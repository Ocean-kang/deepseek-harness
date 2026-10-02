/** Real Cordis and JSONL lifecycle, including plugin unload and inherited history. */
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as MemoryPlugin from '../src/index.ts'
import { fixture } from './helpers.ts'
import { knowledgeFixture, knowledgeCandidate, commitKnowledge } from './knowledge-fixtures.ts'
import { candidate } from './l1-fixtures.ts'

it('isolates fallback projects by working directory without a Workspace registry', async () => {
  const item = await fixture()
  const ctx = new Context()
  const writers: Array<Awaited<ReturnType<typeof ctx.sessionPersistence.create>>> = []
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: 'unassigned', databasePath: item.spec.databasePath, projectByPath: true })
    const sessions = ['first', 'second', 'same-first'].map((id, index) => ctx.sessions.create(SessionId(id), {
      meta: { cwd: `${item.root}/${index === 1 ? 'second' : 'first'}` },
    }))
    for (const session of sessions) {
      writers.push(await ctx.sessionPersistence.create(session.header))
      await ctx.sessions.flush(session)
    }
    const owners = sessions.map(session => ctx.memory.projectOfSession(session.id))
    expect(owners[0]).toMatch(/^path:/)
    expect(owners[0]).not.toBe(owners[1])
    expect(owners[0]).toBe(owners[2])
  } finally {
    await ctx.fiber.dispose()
    await Promise.all(writers.map(writer => writer.close()))
    await item.close()
  }
})

it('automatically learns captured turns using the mounted LLM and serves text recall without embeddings', async () => {
  const item = await fixture()
  const ctx = new Context()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('automatic-learning-source'))
    const writer = await ctx.sessionPersistence.create(session.header)
    class Adapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++
        let text: string
        if (options.system?.startsWith('Summarize')) {
          entered.resolve()
          await release.promise
          text = JSON.stringify(candidate({ sessionId: session.id }))
        } else {
          const block = options.messages[0]!.content[0]!
          if (block.type !== 'text') throw new Error('expected text')
          text = JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])])
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['test'], new Adapter())
    const options = { projectId: item.spec.projectId, databasePath: item.spec.databasePath, autoLearning: true, textSearch: {},
      l1: { provider: 'test', model: 'test' }, knowledge: { provider: 'test', model: 'test' } }
    const plugin = await ctx.plugin({ ...MemoryPlugin, inject: [...MemoryPlugin.inject, 'llm'] }, options)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use strict TypeScript' }] }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    // Model entry is observed before invoking the explicit learning barrier.
    await entered.promise
    expect((await ctx.memory.readRaw({ projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 10 })).events).toHaveLength(3)
    release.resolve()
    await ctx.memory.flushLearning(item.spec.projectId)
    expect(calls).toBe(3)
    expect(await ctx.memory.listCandidates(item.spec.projectId, 'L3')).toHaveLength(1)
    const recall = await ctx.memory.retrieve({ projectId: item.spec.projectId, text: 'TypeScript', levels: ['L3'] })
    expect(recall).toMatchObject({ method: 'bm25', hits: [{ similarity: null }] })
    expect(recall.text).toContain('Use strict TypeScript')
    await plugin.dispose()
    const reopened = await ctx.plugin({ ...MemoryPlugin, inject: [...MemoryPlugin.inject, 'llm'] }, options)
    await ctx.memory.flushLearning(item.spec.projectId)
    expect(calls).toBe(3)
    await reopened.dispose()
    await writer.close()
  } finally {
    release.resolve()
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('captures real persisted events, unloads, and recovers missed events on reload', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('real-source'), { meta: { cwd: item.root } })
    const writer = await ctx.sessionPersistence.create(session.header)
    const options = { projectId: item.spec.projectId, databasePath: item.spec.databasePath }
    const first = await ctx.plugin(MemoryPlugin, options)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    const request = { projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 }
    expect((await ctx.memory.readRaw(request)).events).toEqual(session.snapshotEvents())
    await first.dispose()
    const external = await item.open()
    const before = (await external.readRaw(request)).committedTo
    session.append('turn/start', { turn: 2 })
    await writer.flush()
    expect((await external.readRaw({ ...request, to: session.seq })).committedTo).toBe(before)
    await external.close()
    const second = await ctx.plugin(MemoryPlugin, options)
    await ctx.sessions.flush(session)
    expect((await ctx.memory.readRaw({ ...request, to: session.seq })).events).toEqual(session.snapshotEvents())
    await second.dispose()
    await writer.close()
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('recovers the complete inherited prefix of a restored fork', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const parent = ctx.sessions.create(SessionId('parent'))
    const parentWriter = await ctx.sessionPersistence.create(parent.header)
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = ctx.sessions.fork(parent)
    const writer = await ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
    await writer.append(child.snapshotEvents())
    await writer.flush()
    const plugin = await ctx.plugin(MemoryPlugin, { projectId: item.spec.projectId, databasePath: item.spec.databasePath })
    await ctx.sessions.flush(child)
    const page = await ctx.memory.readRaw({ projectId: item.spec.projectId, sessionId: child.id, from: SessionLogOffset(0), to: child.seq, limit: 100 })
    expect(page.events).toEqual(child.snapshotEvents())
    expect(page.missing).toEqual([])
    await plugin.dispose()
    await writer.close()
    await parentWriter.close()
    const restored = Session.fromRestore(child.id, page.events, child.header, child.inheritedEventCount, 'detached')
    expect(restored.inheritedEventCount).toBe(child.inheritedEventCount)
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('drains a full queue while the root and source provider shut down', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.spec.projectId, databasePath: item.spec.databasePath, queueCapacity: 1, batchSize: 2, pageSize: 2 })
    const session = ctx.sessions.create(SessionId('root-close'))
    await ctx.sessionPersistence.create(session.header)
    for (let turn = 1; turn < 10; turn++) {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const expected = session.snapshotEvents()
    await ctx.fiber.dispose()
    const reopened = await item.open()
    const page = await reopened.readRaw({ projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 })
    expect(page.events).toEqual(expected)
    expect(page.missing).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('persists L1 tasks after L0 flush and leaves model dispatch visibly unintegrated', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('l1-source'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const options = { projectId: item.spec.projectId, databasePath: item.spec.databasePath, l1: { provider: 'test', model: 'test' } }
    const plugin = await ctx.plugin(MemoryPlugin, options)
    session.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(session)
    expect(await ctx.memory.listTasks(item.spec.projectId, '', 10)).toEqual([])
    session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    await ctx.sessions.flush(session)
    expect(await ctx.memory.listTasks(item.spec.projectId, '', 10)).toMatchObject([{ status: 'pending', reason: { kind: 'blocked' } }])
    await plugin.dispose()
    const reloaded = await ctx.plugin(MemoryPlugin, options)
    expect(await ctx.memory.listTasks(item.spec.projectId, '', 10)).toHaveLength(1)
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    await reloaded.dispose()
    await writer.close()
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('queues knowledge through the mounted service without exposing approval or invoking extraction', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.spec.projectId, databasePath: item.spec.databasePath })
    expect(await ctx.memory.listCandidates(item.spec.projectId, 'L2')).toEqual([])
    expect(await ctx.memory.listKnowledgeTasks(item.spec.projectId)).toEqual([])
    const operation = await ctx.memory.consolidate(item.project, 'L2', [item.source], item.config)
    expect(await ctx.memory.getKnowledgeTask(item.project, operation)).toMatchObject({ status: 'pending', calls: 0 })
    expect(await ctx.memory.getMemory(item.project, item.source)).toEqual(item.source)
    expect('approveShare' in ctx.memory).toBe(false)
    expect('revokeShare' in ctx.memory).toBe(false)
    await expect(ctx.memory.consolidate(item.spec.projectId, 'L2', [], MemoryPlugin.resolveKnowledgeConfig({ provider: 'test', model: 'test' }))).rejects.toMatchObject({ code: 'source' })
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('queues every page of existing L1 and L2 versions across restarts while automatic learning is disabled', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const options = { projectId: item.project, databasePath: item.spec.databasePath, autoLearning: false, pageSize: 1,
      knowledge: { provider: 'test', model: 'test' } }
    const first = await ctx.plugin(MemoryPlugin, options)
    const l2 = (await ctx.memory.listKnowledgeTasks(item.project))[0]!
    expect(l2).toMatchObject({ input: { level: 'L2' }, status: 'pending', calls: 0 })
    await first.dispose()
    item.provider.knowledge.claim(item.project, l2.operationId, 'fixture', 10)
    item.provider.knowledge.prepare(item.project, l2.operationId, 'fixture', [
      knowledgeCandidate(item.source, 'Use strict TypeScript'),
      knowledgeCandidate(item.source, 'Use ESM'),
      knowledgeCandidate(item.source, 'Keep source references'),
    ])
    const sources = item.provider.knowledge.commit(item.project, l2.operationId, 'fixture', 11)
    const second = await ctx.plugin(MemoryPlugin, options)
    const tasks = await ctx.memory.listKnowledgeTasks(item.project)
    expect(tasks).toHaveLength(4)
    const pending = tasks.filter(task => task.input.level === 'L3')
    expect(pending).toHaveLength(3)
    expect(pending.every(task => task.status === 'pending' && task.calls === 0)).toBe(true)
    expect(pending.flatMap(task => task.input.sources.map(({ id, revision }) => ({ id, revision })))
      .sort((a, b) => a.id.localeCompare(b.id))).toEqual([...sources].sort((a, b) => a.id.localeCompare(b.id)))
    await second.dispose()
    await ctx.plugin(MemoryPlugin, options)
    expect(await ctx.memory.listKnowledgeTasks(item.project)).toEqual(tasks)
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('shares an exact L3 version only after a human command preview and approval', async () => {
  const item = await knowledgeFixture()
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2)], 'l3')[0]!
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(CommandRuntime)
    const session = ctx.sessions.create(SessionId('share-command'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const plugin = await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath })
    const agent = { id: session.id, session } as Agent
    const execute = async (line: string) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result
    const ref = `${l3.id}@${l3.revision}`
    const foreign = 'foreign' as typeof item.project
    expect(await ctx.memory.getMemory(foreign, l3)).toBeNull()
    expect(await execute('/memory-share approve unknown')).toMatchObject({ kind: 'error' })
    const preview = await execute(`/memory-share show ${ref}`)
    expect(preview).toMatchObject({ kind: 'success' })
    expect(preview?.text).toContain('cannot erase content already recorded')
    const token = /\/memory-share approve ([a-f0-9-]+)/u.exec(preview?.text ?? '')?.[1]
    expect(token).toBeDefined()
    const newerPreview = await execute(`/memory-share show ${ref}`)
    const newerToken = /\/memory-share approve ([a-f0-9-]+)/u.exec(newerPreview?.text ?? '')?.[1]
    expect(newerToken).toBeDefined()
    expect(await execute(`/memory-share approve ${token}`)).toMatchObject({ kind: 'error' })
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk full'))
    try {
      await expect(ctx.commands.execute(agent, `/memory-share approve ${newerToken}`, [], new AbortController().signal)).rejects.toThrow('disk full')
    } finally { flush.mockRestore() }
    expect(await ctx.memory.getMemory(foreign, l3)).toBeNull()
    const anotherSession = ctx.sessions.create(SessionId('other-share-command'))
    const anotherWriter = await ctx.sessionPersistence.create(anotherSession.header)
    const anotherAgent = { id: anotherSession.id, session: anotherSession } as Agent
    expect((await ctx.commands.execute(anotherAgent, `/memory-share approve ${newerToken}`, [], new AbortController().signal))?.result).toMatchObject({ kind: 'error' })
    expect(await execute(`/memory-share approve ${newerToken}`)).toMatchObject({ kind: 'success' })
    expect(await execute(`/memory-share approve ${newerToken}`)).toMatchObject({ kind: 'error' })
    expect(await ctx.memory.getMemory(foreign, l3)).toMatchObject({ shared: true, id: l3.id, revision: l3.revision })
    expect(await execute(`/memory-share revoke ${ref}`)).toMatchObject({ kind: 'success' })
    expect(await ctx.memory.getMemory(foreign, l3)).toBeNull()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'memory-share')).toBeUndefined()
    await anotherWriter.close()
    await writer.close()
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('exposes real HTTP retrieval through configured service and closes it on unload', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  const keyName = `MEMORY_FIXTURE_${randomUUID().replaceAll('-', '_')}`
  const previous = process.env[keyName]
  process.env[keyName] = 'fixture-key'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body: { input: string[] } = JSON.parse(Buffer.concat(chunks).toString())
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: 'fixture', data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })) }))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing endpoint')
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const plugin = await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath,
      embedding: { endpoint: `http://127.0.0.1:${address.port}/embeddings`, model: 'fixture', dimensions: 2, apiKeyEnv: keyName } })
    await ctx.memory.rebuildIndex()
    expect(await ctx.memory.getIndexStatus(item.project)).toMatchObject({ ready: true, candidates: 1 })
    expect((await ctx.memory.retrieve({ projectId: item.project, text: 'parser' })).hits).toHaveLength(1)
    const service = ctx.memory
    await plugin.dispose()
    await expect(service.retrieve({ projectId: item.project, text: 'after close' })).rejects.toMatchObject({ code: 'closed' })
  } finally {
    if (previous === undefined) delete process.env[keyName]
    else process.env[keyName] = previous
    await ctx.fiber.dispose()
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
    await item.close()
  }
})
