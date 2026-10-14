/** Streaming extraction and byte-bounded immutable trace pages over recorded source events. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { L1Extractor } from '../src/l1-extractor.ts'
import { resolveL1Config, resolveKnowledgeConfig } from '../src/l1-config.ts'
import { KnowledgeExtractor } from '../src/knowledge-extractor.ts'
import { episodeTrace } from '../src/evidence.ts'
import { batch, fixture, header } from './helpers.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import { knowledgeCandidate } from './knowledge-fixtures.ts'
import type { TraceCursor, MemoryRef } from '../src/l1-types.ts'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

async function source() {
  const item = await fixture()
  resources.push(() => item.close())
  const provider = await item.open()
  const base = turnEvents({ kind: 'completed' }, 'Use strict TypeScript and ESM in this project.')
  const events: SessionEvent[] = [base[0]!, base[1]!]
  for (let i = 0; i < 20; i++) events.push({ type: 'tool/call', seq: SessionSeq(i + 2), time: i + 3,
    data: { turn: 1, step: i + 1, callId: ToolCallId('trace-' + i), name: 'write_file',
      arguments: JSON.stringify({ path: 'file-' + i + '.ts', content: '🧪'.repeat(1024) }) } })
  events.push({ ...base[2]!, seq: SessionSeq(events.length), time: events.length + 1 })
  await provider.appendRaw(batch(item.spec, events))
  await provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test', maxInputBytes: 16000 }), 2)
  const task = (await provider.l1.claim(item.spec.projectId, header().id, 'trace-worker', Date.now()))!
  return { item, provider, events, task }
}

async function* response(value: unknown): AsyncIterable<StreamChunk> {
  const text = JSON.stringify(value)
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

it('dispatches bounded groups before reading the complete turn and awaits durable call charges', async () => {
  const { task, events } = await source()
  let consumed = 0
  let reservations = 0
  let calls = 0
  const sourceEvents = async function* () { for (const event of events) { consumed++; yield event } }
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('fixture')
  const llm: Pick<LlmRuntime, 'stream'> = { stream: options => {
    calls++
    expect(reservations).toBe(calls)
    if (calls === 1) expect(consumed).toBeLessThan(events.length)
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture')
    expect(Buffer.byteLength(options.system ?? '') + Buffer.byteLength(block.text)).toBeLessThanOrEqual(task.config.maxInputBytes)
    const input = JSON.parse(block.text) as { input: Array<{ sources: typeof value.summary.sources }> }
    return response({ kind: 'memory', summary: { ...value.summary, title: 'Write files', problem: 'No verified settlement',
      summary: 'Files were requested', description: 'Writes were requested', sources: input.input[0]!.sources } })
  } }
  const extractor = new L1Extractor(llm, async () => {})
  const result = await extractor.extractTurn(task, sourceEvents(), new AbortController().signal,
    async () => { await Promise.resolve(); reservations++ }, async () => [])
  expect(result).toMatchObject({ kind: 'memory', summary: { outcome: 'unknown' } })
  expect(result.kind === 'memory' && result.summary.trace).toBeUndefined()
  expect(consumed).toBe(events.length)
  expect(calls).toBeGreaterThan(1)
})

it.each(['knowledge-v3', 'knowledge-v4'] as const)('continues large-trace L1 through verified L2 and L3 with %s', async (promptVersion: 'knowledge-v3' | 'knowledge-v4') => {
  const { item, provider, events, task } = await source()
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('fixture')
  const trace = episodeTrace(events, [])
  expect(Buffer.byteLength(JSON.stringify(trace))).toBeGreaterThan(65536)
  provider.l1.prepare(item.spec.projectId, task.operationId, 'trace-worker', { ...value, summary: { ...value.summary, trace } })
  let previous: MemoryRef = provider.l1.commitMemory(item.spec.projectId, task.operationId, 'trace-worker', Date.now())!
  const config = { ...resolveKnowledgeConfig({ provider: 'test', model: 'test' }), promptVersion }
  const originals: number[] = []
  for (const level of ['L2', 'L3'] as const) {
    const operation = provider.knowledge.enqueue(item.spec.projectId, level, [previous], config)
    const stored = provider.knowledge.claim(item.spec.projectId, operation, 'trace-knowledge', Date.now())!
    // A legacy L1 can still reach direct source projection with its full trace attached.
    const input = { ...stored.input, sources: stored.input.sources.map(record => record.level === 'L1'
      ? { ...record, summary: { ...record.summary, trace } } : record) }
    const checked = { ...stored, input }
    let records = 0
    const llm: Pick<LlmRuntime, 'stream'> = { stream: options => {
      expect(records).toBeGreaterThan(0)
      const block = options.messages[0]!.content[0]!
      if (block.type !== 'text') throw new Error('fixture')
      expect(Buffer.byteLength(options.system ?? '') + Buffer.byteLength(block.text)).toBeLessThanOrEqual(config.maxInputBytes)
      expect(block.text).not.toContain('trace-19')
      expect(block.text).not.toContain('"trace":')
      if (block.text.includes('"stage":"visualize"')) return response({ description: 'Use strict TypeScript and ESM.' })
      expect(block.text).toContain('Use strict TypeScript and ESM in this project.')
      const method = knowledgeCandidate(previous, 'Use strict TypeScript and ESM')
      const output = promptVersion === 'knowledge-v4' ? { ...method, action: 'store', knowledge: { ...method.knowledge,
        scenario: 'TypeScript development', conclusion: 'Use strict TypeScript and ESM', reason: 'Explicit user policy',
        whenToUse: ['Editing this project'], recommendedAction: 'Enable strict TypeScript and ESM', limitations: [],
        kind: 'knowledge', description: 'Use strict TypeScript and ESM.' } } : method
      return response([output])
    } }
    const extractor = new KnowledgeExtractor(llm, async () => { records++ }, SessionId('trace-auxiliary'),
      (project, ref) => provider.knowledge.sourcesCurrent(project, ref), async (project, ref, signal) => {
        originals.push(ref.seq)
        const page = await provider.readRaw({ projectId: project, sessionId: ref.sessionId, from: SessionLogOffset(ref.seq),
          to: SessionLogOffset(ref.seq + 1), limit: 1, signal })
        if (page.events[0] === undefined) throw new Error('fixture')
        return page.events[0]
      })
    const result = await extractor.consolidate(checked, new AbortController().signal,
      () => provider.knowledge.reserveCall(item.spec.projectId, operation, 'trace-knowledge'))
    provider.knowledge.prepare(item.spec.projectId, operation, 'trace-knowledge', result)
    previous = provider.knowledge.commit(item.spec.projectId, operation, 'trace-knowledge', Date.now())[0]!
    expect(provider.knowledge.getMemory(item.spec.projectId, previous)).toMatchObject({ level, knowledge: { evidence: 'supported' } })
  }
  expect(originals).toEqual([1, 1])
})

it('keeps source buffering bounded when a slow consumer receives ten times as many events', async () => {
  const { task } = await source()
  const metrics = []
  for (const count of [100, 1000]) {
    const current = { ...task, to: SessionLogOffset(count + 2), config: { ...task.config,
      promptVersion: 'l1-v1' as const, maxInputBytes: 16000, maxCalls: 256 } }
    let consumed = 0
    let acknowledged = 0
    let sourceBytes = 0
    let peakBytes = 0
    let eventBytes = 0
    let calls = 0
    const events = async function* () {
      yield { type: 'turn/start' as const, seq: SessionSeq(0), time: 1, data: { turn: 1 } }
      for (let seq = 1; seq <= count; seq++) {
        const event = { type: 'user/message' as const, seq: SessionSeq(seq), time: seq + 1,
          data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text: 'x'.repeat(1024) }] }), surfaceOp: 'append' as const }
        eventBytes = Math.max(eventBytes, Buffer.byteLength(JSON.stringify(event)))
        sourceBytes += Buffer.byteLength(JSON.stringify(event))
        consumed = seq
        peakBytes = Math.max(peakBytes, (consumed - acknowledged) * eventBytes)
        yield event
      }
      yield { type: 'turn/end' as const, seq: SessionSeq(count + 1), time: count + 2, data: { turn: 1, reason: { kind: 'completed' as const } } }
    }
    const llm: Pick<LlmRuntime, 'stream'> = { stream: options => {
      calls++
      const block = options.messages[0]!.content[0]!
      if (block.type !== 'text') throw new Error('fixture')
      const input = JSON.parse(block.text) as { stage: string; input: Array<{ sources: Array<{ seq: number }> }> }
      if (input.stage === 'extract') acknowledged = Math.max(...input.input.flatMap(piece => piece.sources.map(ref => ref.seq)))
      return (async function* () {
        // Settlement is asynchronous, so the extractor must hold the source at this group.
        const paused = consumed
        await Promise.resolve()
        expect(consumed).toBe(paused)
        const value = candidate(current)
        if (value.kind !== 'memory') throw new Error('fixture')
        yield* response({ ...value, summary: { ...value.summary,
          sources: [{ sessionId: current.sessionId, seq: input.input[0]!.sources[0]!.seq }] } })
      })()
    } }
    const started = performance.now()
    await new L1Extractor(llm, async () => {}).extractTurn(current, events(), new AbortController().signal, () => {})
    expect(peakBytes).toBeLessThanOrEqual(current.config.maxInputBytes + eventBytes)
    metrics.push({ events: count, sourceBytes, peakSourceBufferBytes: peakBytes, modelCalls: calls,
      elapsedMs: Math.round(performance.now() - started) })
  }
  expect(metrics[1]!.sourceBytes).toBeGreaterThan(metrics[0]!.sourceBytes * 9)
  expect(metrics[1]!.peakSourceBufferBytes).toBeLessThanOrEqual(metrics[0]!.peakSourceBufferBytes * 1.1)
  console.info('L1 streaming metrics', JSON.stringify(metrics))
})

it('preserves large trace separately from compact summaries and restores it through Unicode-safe pages', async () => {
  const { item, provider, events, task } = await source()
  const value = candidate(task)
  await provider.l1.prepare(item.spec.projectId, task.operationId, 'trace-worker', value)
  const memory = (await provider.l1.commitMemory(item.spec.projectId, task.operationId, 'trace-worker', Date.now()))!
  expect(memory.summary.trace).toBeUndefined()
  let cursor: TraceCursor | undefined
  const pages: string[] = []
  do {
    const page = await provider.l1.readTrace(item.spec.projectId, memory, cursor, 257)
    expect(page.found).toBe(true)
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(257)
    expect(page.text).not.toContain('\uFFFD')
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    pages.push(page.text)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  expect(Buffer.byteLength(pages.join(''))).toBeGreaterThan(65536)
  expect(JSON.parse(pages.join(''))).toEqual(episodeTrace(events, []))
  expect(pages.length).toBeGreaterThan(100)
  await expect(Promise.resolve().then(() => provider.l1.readTrace(item.spec.projectId, memory, { chunk: 0, offset: 1 }, 1))).rejects.toThrow()
  await provider.close()
  const reopened = await item.open()
  expect(await reopened.l1.getMemory(item.spec.projectId, memory)).toEqual(memory)
})

it('pages legacy inline trace without rewriting the stored summary', async () => {
  const { item, provider, events, task } = await source()
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('fixture')
  await provider.l1.prepare(item.spec.projectId, task.operationId, 'trace-worker', value)
  const memory = (await provider.l1.commitMemory(item.spec.projectId, task.operationId, 'trace-worker', Date.now()))!
  const summary = JSON.stringify({ ...memory.summary, trace: episodeTrace(events, []) })
  const storedCandidate = JSON.stringify({ kind: 'memory', summary: JSON.parse(summary) })
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.prepare('UPDATE l1_memories SET summary = ? WHERE id = ? AND revision = ?').run(summary, memory.id, memory.revision)
    db.prepare('UPDATE l1_tasks SET candidate = ? WHERE id = ?').run(storedCandidate, task.operationId)
    db.prepare('DELETE FROM l1_summary_projections WHERE memory_id = ? AND revision = ?').run(memory.id, memory.revision)
    db.prepare('DELETE FROM l1_candidate_projections WHERE operation_id = ?').run(task.operationId)
    db.prepare('DELETE FROM l1_trace_chunks WHERE memory_id = ? AND revision = ?').run(memory.id, memory.revision)
    let cursor: TraceCursor | undefined
    let text = ''
    do {
      const page = await provider.l1.readTrace(item.spec.projectId, memory, cursor, 1024)
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024)
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      text += page.text
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(JSON.parse(text)).toEqual(episodeTrace(events, []))
    expect((await provider.l1.getMemory(item.spec.projectId, memory))?.summary.trace).toBeUndefined()
    expect((await provider.l1.getTask(item.spec.projectId, task.operationId))?.candidate).toEqual(value)
    expect((await provider.l1.listTasks(item.spec.projectId, '', 10))[0]?.candidate).toEqual(value)
    expect(db.prepare('SELECT summary FROM l1_memories WHERE id = ? AND revision = ?').get(memory.id, memory.revision)?.summary).toBe(summary)
    expect(db.prepare('SELECT candidate FROM l1_tasks WHERE id = ?').get(task.operationId)?.candidate).toBe(storedCandidate)
    expect(db.prepare('SELECT length(summary) AS size FROM l1_summary_projections WHERE memory_id = ? AND revision = ?').get(memory.id, memory.revision)?.size).toBeLessThan(1024)
    expect(db.prepare('SELECT max(length(CAST(body AS BLOB))) AS size FROM l1_trace_chunks WHERE memory_id = ? AND revision = ?').get(memory.id, memory.revision)?.size).toBeLessThanOrEqual(item.spec.tracePageMaxBytes)
  } finally { db.close() }
})

it('rejects malformed legacy summary and candidate JSON before SQL projection changes their diagnosis', async () => {
  const { item, provider, task } = await source()
  await provider.l1.prepare(item.spec.projectId, task.operationId, 'trace-worker', candidate(task))
  const memory = (await provider.l1.commitMemory(item.spec.projectId, task.operationId, 'trace-worker', Date.now()))!
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.prepare('UPDATE l1_memories SET summary = ? WHERE id = ? AND revision = ?').run('{broken', memory.id, memory.revision)
    db.prepare('DELETE FROM l1_summary_projections WHERE memory_id = ? AND revision = ?').run(memory.id, memory.revision)
    expect(() => provider.l1.getMemory(item.spec.projectId, memory)).toThrow(expect.objectContaining({ code: 'output', message: 'L1 invalid JSON' }))
    expect(() => provider.l1.readTrace(item.spec.projectId, memory)).toThrow(expect.objectContaining({ code: 'output', message: 'L1 invalid JSON' }))
    db.prepare('UPDATE l1_tasks SET candidate = ? WHERE id = ?').run('{broken', task.operationId)
    db.prepare('DELETE FROM l1_candidate_projections WHERE operation_id = ?').run(task.operationId)
    expect(() => provider.l1.getTask(item.spec.projectId, task.operationId)).toThrow(expect.objectContaining({ code: 'output', message: 'L1 invalid JSON' }))
    expect(() => provider.l1.listTasks(item.spec.projectId, '', 10)).toThrow(expect.objectContaining({ code: 'output', message: 'L1 invalid JSON' }))
  } finally { db.close() }
})

it('resumes a prepared legacy candidate with compact task reads and preserves its complete immutable trace', async () => {
  const { item, provider, events, task } = await source()
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('fixture')
  const trace = episodeTrace(events, [])
  const full = { ...value, summary: { ...value.summary, trace } }
  provider.l1.prepare(item.spec.projectId, task.operationId, 'trace-worker', full)
  const original = JSON.stringify({ ...full, summary: { ...full.summary,
    trace: { files: trace.files, errors: trace.errors, commands: trace.commands, actions: trace.actions } } })
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.prepare('UPDATE l1_tasks SET candidate = ? WHERE id = ?').run(original, task.operationId)
    db.prepare('DELETE FROM l1_candidate_projections WHERE operation_id = ?').run(task.operationId)
    const resumed = provider.l1.claim(item.spec.projectId, task.sessionId, 'resumed', Date.now() + 1_000_000_000)!
    expect(resumed.candidate).toEqual(value)
    provider.l1.prepare(item.spec.projectId, task.operationId, 'resumed', value)
    provider.l1.prepare(item.spec.projectId, task.operationId, 'resumed', full)
    expect(() => provider.l1.prepare(item.spec.projectId, task.operationId, 'resumed', { ...full,
      summary: { ...full.summary, trace: { ...trace, actions: ['Changed trace'] } } })).toThrow(expect.objectContaining({ code: 'conflict' }))
    const memory = provider.l1.commitMemory(item.spec.projectId, task.operationId, 'resumed', Date.now())!
    expect(provider.l1.commitMemory(item.spec.projectId, task.operationId, 'resumed', Date.now())).toEqual(memory)
    let cursor: TraceCursor | undefined
    let text = ''
    do {
      const page = provider.l1.readTrace(item.spec.projectId, memory, cursor, 4096)
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(4096)
      text += page.text
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(JSON.parse(text)).toEqual(trace)
    expect(db.prepare('SELECT candidate FROM l1_tasks WHERE id = ?').get(task.operationId)?.candidate).toBe(original)
    expect(memory.summary.trace).toBeUndefined()
  } finally { db.close() }
})
