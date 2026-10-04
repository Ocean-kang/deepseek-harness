/** Opt-in verification of one identified real-provider learning run, without further model calls. */
import { expect, it } from 'vitest'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { SqliteMemory } from '../src/sqlite.ts'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import { json, object } from '../src/l1-validation.ts'

it.runIf(process.env.DSH_MEMORY_VERIFY_LEARNING === '1')('reopens the live run and verifies content, ancestry and exact request/result logs', async () => {
  const id = process.env.DSH_MEMORY_VERIFY_LEARNING_SOURCE
  if (id === undefined || !id.trim()) throw new Error('DSH_MEMORY_VERIFY_LEARNING_SOURCE must identify the live fixture run')
  const databasePath = process.env.DSH_MEMORY_VERIFY_LEARNING_DB
  if (databasePath === undefined || !databasePath.trim()) throw new Error('DSH_MEMORY_VERIFY_LEARNING_DB must identify the live fixture database')
  const spec = await resolveConfig({ projectId: 'memory-live-learning', databasePath })
  const memory = await SqliteMemory.open(spec)
  try {
    const project = spec.projectId
    const l1Tasks = []
    const tasks = []
    let after = ''
    for (;;) {
      const page = memory.l1.listTasks(project, after, spec.pageSize)
      l1Tasks.push(...page.filter(task => task.sessionId === SessionId(id)))
      if (page.length < spec.pageSize) break
      after = page.at(-1)!.operationId
    }
    expect(l1Tasks).toHaveLength(1)
    const l1Task = l1Tasks[0]!
    expect(l1Task.status).toBe('done')
    expect(l1Task.config.promptVersion).toBe('l1-v2')
    const l1 = memory.l1.byOperation(project, l1Task.operationId)!
    expect(l1.summary.description?.trim()).toBeTruthy()
    expect(['unknown', 'incomplete']).toContain(l1.summary.outcome)
    expect(l1.summary.solution).toBeNull()
    expect(l1.summary.sources).toEqual([{ sessionId: SessionId(id), seq: 1 }])
    const source = await memory.readRaw({ projectId: project, sessionId: SessionId(id), from: SessionLogOffset(1), to: SessionLogOffset(2), limit: 1 })
    expect(JSON.stringify(source.events)).toContain('No implementation or test execution has occurred')
    after = ''
    for (;;) {
      const page = memory.knowledge.listTasks(project, after, spec.pageSize)
      tasks.push(...page)
      if (page.length < spec.pageSize) break
      after = page.at(-1)!.operationId
    }
    const l2Tasks = tasks.filter(task => task.input.level === 'L2' && task.input.sources.some(record => record.id === l1.id && record.revision === l1.revision))
    const l2Refs = l2Tasks.flatMap(task => task.result ?? [])
    const l3Tasks = tasks.filter(task => task.input.level === 'L3' && task.input.sources.some(record => l2Refs.some(ref => ref.id === record.id && ref.revision === record.revision)))
    expect(l2Tasks).toHaveLength(1)
    expect(l3Tasks.length).toBeGreaterThan(0)
    expect(l2Refs.every(ref => l3Tasks.some(task => task.input.sources.some(source => source.id === ref.id && source.revision === ref.revision)))).toBe(true)
    const search = new TextMemoryRetriever(memory, resolveTextSearchConfig({}))
    try {
      const result = await search.retrieve({ projectId: project, text: 'TypeScript', levels: ['L3'] })
      expect(result.method).toBe('bm25')
      expect(result.hits.some(hit => l3Tasks.some(task => task.result!.some(ref => ref.id === hit.ref.id && ref.revision === hit.ref.revision)))).toBe(true)
      expect(result.hits.every(hit => hit.similarity === null)).toBe(true)
    } finally { await search.close() }
    for (const task of [...l2Tasks, ...l3Tasks]) {
      expect(task.status).toBe('done')
      expect(task.config.promptVersion).toBe('knowledge-v3')
      expect(task.result?.length).toBeGreaterThan(0)
      for (const ref of task.result!) {
        const record = memory.knowledge.getMemory(project, ref)
        if (record === null || record.level === 'L1' || 'shared' in record) throw new Error('expected owned knowledge')
        expect(record.knowledge.description?.trim()).toBeTruthy()
        expect(record.knowledge.examinedEvents).toEqual(l1.summary.sources)
        expect(record.knowledge.evidence).toBe('supported')
        expect(['constraint', 'decision']).toContain(record.knowledge.category)
        expect(record.knowledge.sources.some(source => task.input.sources.some(input => input.id === source.ref.id && input.revision === source.ref.revision))).toBe(true)
        expect(record.knowledge.sources.every(source => [...task.input.sources, ...task.input.existing].some(input => input.id === source.ref.id && input.revision === source.ref.revision))).toBe(true)
      }
    }
    for (const levelTasks of [l2Tasks, l3Tasks]) {
      const content = levelTasks.flatMap(task => task.result ?? []).map(ref => memory.knowledge.getMemory(project, ref))
        .map(record => record !== null && record.level !== 'L1' && !('shared' in record) ? record.knowledge.body : '').join('\n')
      expect(content).toMatch(/strict TypeScript/i)
      expect(content).toContain('ESM')
    }
    const operations = new Set([l1Task.operationId, ...l2Tasks.map(task => task.operationId), ...l3Tasks.map(task => task.operationId)])
    const levels: string[] = []
    const stages = new Map<string, string[]>()
    after = ''
    for (;;) {
      const sessions = memory.listSessions(project, after, spec.pageSize)
      for (const session of sessions) {
        const stored = await memory.readRaw({ projectId: project, sessionId: session.header.id, from: SessionLogOffset(0), to: session.committedTo, limit: spec.pageSize })
        const request = stored.events[0]
        if (request?.type !== 'memory/extraction-request' || !operations.has(request.data.operationId)) continue
        const result = stored.events[1]
        expect(request.ignorable).toBe(true)
        expect(result?.type).toBe('memory/extraction-result')
        if (result?.type !== 'memory/extraction-result') throw new Error('expected result')
        expect(result.ignorable).toBe(true)
        expect(result.data.outcome).toBe('returned')
        expect(result.data.operationId).toBe(request.data.operationId)
        expect(expandAssistantStream(result.data.stream).at(-1)?.chunk).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
        expect(request.data.request.provider).toBe(l1Task.config.provider)
        expect(request.data.request.model).toBe(l1Task.config.model)
        levels.push(request.data.level)
        const block = request.data.request.messages[0]?.content[0]
        if (block?.type !== 'text') throw new Error('expected recorded text input')
        const stage = object(json(block.text)).stage
        stages.set(request.data.operationId, [...stages.get(request.data.operationId) ?? [], typeof stage === 'string' ? stage : 'extract'])
      }
      if (sessions.length < spec.pageSize) break
      after = sessions.at(-1)!.header.id
    }
    expect(levels.filter(level => level === 'L1')).toHaveLength(l1Task.calls)
    expect(levels.filter(level => level === 'L2')).toHaveLength(l2Tasks.reduce((sum, task) => sum + task.calls, 0))
    expect(levels.filter(level => level === 'L3')).toHaveLength(l3Tasks.reduce((sum, task) => sum + task.calls, 0))
    expect(levels).toHaveLength(l1Task.calls + [...l2Tasks, ...l3Tasks].reduce((sum, task) => sum + task.calls, 0))
    expect(l1Task.calls).toBe(2)
    for (const task of [...l2Tasks, ...l3Tasks]) {
      const recorded = stages.get(task.operationId) ?? []
      expect(recorded).toHaveLength(task.calls)
      expect(recorded.filter(stage => stage === 'visualize')).toHaveLength(task.candidates!.length)
      expect(recorded.filter(stage => stage !== 'visualize').length).toBeGreaterThan(0)
    }
  } finally { await memory.close() }
})
