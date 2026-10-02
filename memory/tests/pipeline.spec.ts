/** Complete library learning uses the real LLM service and durable auxiliary request Sessions. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, expandAssistantStream, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LearningBudget, MemoryPipeline } from '../src/pipeline.ts'
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'
import { MemoryRetriever } from '../src/retrieval.ts'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import { resolveEmbeddingConfig } from '../src/embedding.ts'
import type { ProjectId } from '../src/types.ts'
import { installMemoryInjector } from '../src/injector.ts'
import { batch, fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import { candidate } from './l1-fixtures.ts'
import { knowledgeCandidate } from './knowledge-fixtures.ts'

class Adapter extends LlmAdapter {
  constructor(private readonly run: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.run(options) }
}

async function* response(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const settings = { l1: resolveL1Config({ provider: 'test', model: 'test' }),
  knowledge: resolveKnowledgeConfig({ provider: 'test', model: 'test' }), pageSize: 2, learningConcurrency: 2, learningQueueCapacity: 128 }

it('shares execution and queued capacity across separate databases and cancels a waiting drain', async () => {
  const items = await Promise.all([fixture(), fixture()])
  const providers = await Promise.all(items.map(item => item.open()))
  const ctx = new Context()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const budget = new LearningBudget()
  const pipelines: MemoryPipeline[] = []
  const work: Promise<unknown>[] = []
  let calls = 0
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test'], new Adapter(async function* () {
      calls++
      entered.resolve()
      await release.promise
      yield* response(JSON.stringify({ kind: 'empty' }))
    }))
    for (const [i, item] of items.entries()) {
      const provider = providers[i]!
      await provider.appendRaw(batch(item.spec, turnEvents()))
      pipelines.push(new MemoryPipeline(provider, { ...settings, learningConcurrency: 1, learningQueueCapacity: 1 }, ctx.llm, () => {}, undefined, budget))
    }
    work.push(pipelines[0]!.flush(items[0]!.spec.projectId))
    await entered.promise
    const cancel = new AbortController()
    work.push(pipelines[1]!.flush(items[1]!.spec.projectId, cancel.signal).catch(error => error))
    expect(budget.active).toBe(1)
    expect(budget.drains).toBe(2)
    expect(() => pipelines[1]!.flush(items[1]!.spec.projectId)).toThrow('queue is full')
    expect(calls).toBe(1)
    cancel.abort(new Error('Cancelled queued project'))
    expect(await work[1]).toMatchObject({ message: 'Cancelled queued project' })
    release.resolve()
    await work[0]
    await pipelines[0]!.retire(items[0]!.spec.projectId)
    await pipelines[1]!.retire(items[1]!.spec.projectId)
    await pipelines[1]!.flush(items[1]!.spec.projectId)
    expect(calls).toBe(2)
  } finally {
    release.resolve()
    await Promise.all(pipelines.map(pipeline => pipeline.close()))
    await Promise.allSettled(work)
    expect(budget.active).toBe(0)
    expect(budget.drains).toBe(0)
    expect(budget.waiting).toEqual([])
    await ctx.fiber.dispose()
    await Promise.all(items.map(item => item.close()))
  }
})

it('learns all layers, retrieves independently, replays requests and restarts without repeat calls', async () => {
  const item = await fixture()
  const ctx = new Context()
  const provider = await item.open()
  const errors: string[] = []
  const embedding = resolveEmbeddingConfig({ endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2, apiKeyEnv: 'TEST_KEY' })
  const retriever = new MemoryRetriever(provider, embedding, { embed: async texts => ({ vectors: texts.map(() => [1, 0]), tokens: null }) }, error => errors.push(error.code))
  let pipeline: MemoryPipeline | undefined
  try {
    await ctx.plugin(LlmRuntime)
    let calls = 0
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      calls++
      const sessions = provider.listSessions(item.spec.projectId, '', 100)
      const logs = await Promise.all(sessions.map(async session => (await provider.readRaw({ projectId: item.spec.projectId,
        sessionId: session.header.id, from: SessionLogOffset(0), to: session.committedTo, limit: 10 })).events))
      expect(logs.flat().some(event => event.type === 'memory/extraction-request'
        && JSON.stringify(event.data.request.messages) === JSON.stringify(options.messages))).toBe(true)
      const input = JSON.parse(options.messages[0]!.content[0]!.type === 'text' ? options.messages[0]!.content[0]!.text : '')
      if ('stage' in input) yield* response(JSON.stringify(candidate({ sessionId: header().id })))
      else yield* response(JSON.stringify([knowledgeCandidate(input.input.sources[0])]))
    }))
    pipeline = new MemoryPipeline(provider, settings, ctx.llm, error => errors.push(error.code), retriever)
    await pipeline.learn(batch(item.spec, turnEvents()))
    expect(calls).toBe(3)
    expect(errors).toEqual([])
    const layers = (['L1', 'L2', 'L3'] as const).map(level => provider.knowledge.listCandidates(item.spec.projectId, level).length)
    expect(layers).toEqual([1, 1, 1])
    const retrieved = await pipeline.retrieve({ projectId: item.spec.projectId, text: 'Which type checking is required?', levels: ['L3'] })
    expect(retrieved.hits).toHaveLength(1)
    expect(retrieved.text).toContain('Use strict TypeScript')
    const auxiliary = provider.listSessions(item.spec.projectId, '', 100).filter(session => session.header.id !== header().id)
    expect(auxiliary).toHaveLength(3)
    const journal: SessionEvent[] = []
    for (const session of auxiliary) {
      const stored = await provider.readRaw({ projectId: item.spec.projectId, sessionId: session.header.id,
        from: SessionLogOffset(0), to: session.committedTo, limit: 10 })
      expect(stored.events.map(event => event.type)).toEqual(['memory/extraction-request', 'memory/extraction-result'])
      expect(stored.events.every(event => event.ignorable === true)).toBe(true)
      const restored = Session.create(session.header.id, stored.events, session.header)
      expect(restored.deriveMessages()).toEqual([])
      expect(restored.snapshotEvents().slice(0, stored.events.length)).toEqual(stored.events)
      const result = stored.events[1]!
      if (result.type !== 'memory/extraction-result') throw new Error('expected settlement')
      expect(expandAssistantStream(result.data.stream).at(-1)?.chunk).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      journal.push(...stored.events)
    }
    await expect(JSON.stringify({ layers, requestLevels: journal.filter(event => event.type === 'memory/extraction-request').map(event => event.data.level).sort(),
      settlements: journal.filter(event => event.type === 'memory/extraction-result').map(event => event.data.outcome),
      recalled: retrieved.hits.map(hit => ({ shared: hit.shared, text: hit.text })) }, null, 2) + '\n').toMatchFileSnapshot('./expected/pipeline.json')
    await pipeline.close()
    await retriever.close()
    await provider.close()
    const reopened = await item.open()
    pipeline = new MemoryPipeline(reopened, settings, ctx.llm, error => errors.push(error.code))
    await pipeline.flush(item.spec.projectId)
    expect(calls).toBe(3)
    expect(reopened.knowledge.listCandidates(item.spec.projectId, 'L3')).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    await pipeline?.close()
    await retriever.close()
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('does not call the model if its request cannot commit, and recovers from retained L0', async () => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  let pipeline: MemoryPipeline | undefined
  try {
    await ctx.plugin(LlmRuntime)
    const calls = vi.fn()
    ctx.llm.registerAdapter(['test'], new Adapter(options => {
      calls()
      return response(options.system?.startsWith('Summarize') ? JSON.stringify(candidate({ sessionId: header().id })) : '[]')
    }))
    pipeline = new MemoryPipeline(provider, settings, ctx.llm, () => {})
    const append = provider.appendRaw.bind(provider)
    const fault = vi.spyOn(provider, 'appendRaw').mockImplementation(request => request.events[0]?.type === 'memory/extraction-request'
      ? Promise.reject(new Error('injected disk failure')) : append(request))
    await pipeline.learn(batch(item.spec, turnEvents()))
    expect(calls).not.toHaveBeenCalled()
    const task = provider.l1.listTasks(item.spec.projectId, '', 10)[0]!
    expect(task.status).toBe('retry')
    expect(task.calls).toBe(0)
    fault.mockRestore()
    provider.l1.rerun(item.spec.projectId, task.operationId, 'retry', settings.l1)
    await pipeline.flush(item.spec.projectId)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(provider.l1.getTask(item.spec.projectId, task.operationId)?.status).toBe('done')
  } finally {
    await pipeline?.close()
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('delivers newly learned memory through text search to a new Agent Session and persists the exact recalled body', async () => {
  const item = await fixture()
  const ctx = new Context()
  const provider = await item.open()
  const errors: string[] = []
  const retriever = new TextMemoryRetriever(provider, resolveTextSearchConfig({}))
  let pipeline: MemoryPipeline | undefined
  let dispose: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(LlmRuntime)
    const requests: GenerateOptions[] = []
    ctx.llm.registerAdapter(['test'], new Adapter(options => {
      requests.push(options)
      if (options.system?.startsWith('Summarize')) return response(JSON.stringify(candidate({ sessionId: header().id })))
      if (options.system?.startsWith('Extract project knowledge')) {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        return response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
      return response('The learned constraint requires strict TypeScript.')
    }))
    pipeline = new MemoryPipeline(provider, settings, ctx.llm, error => errors.push(error.code), retriever)
    await pipeline.learn(batch(item.spec, turnEvents()))
    expect(requests).toHaveLength(3)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/reader-sessions`, compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    dispose = installMemoryInjector(ctx, retriever, async () => item.spec.projectId, error => errors.push(error.code))
    const agent = await ctx.agentLoop.create(SessionId('new-memory-reader'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Which type checking does this project require?' }] }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    expect(requests).toHaveLength(4)
    const recalls = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')
    expect(recalls).toHaveLength(1)
    const recall = recalls[0]!
    if (recall.type !== 'user/message') throw new Error('expected recall')
    expect(requests.at(-1)!.messages).toContainEqual(recall.data)
    expect(JSON.stringify(recall.data.content)).toContain('Use strict TypeScript')
    const reader = await ctx.sessionPersistence.open(agent.session.id, 'read')
    try {
      const stored = (await reader.read()).events
      expect(stored).toContainEqual(recall)
    } finally { await reader.close() }
    expect(errors).toEqual([])
  } finally {
    await dispose?.()
    await pipeline?.close()
    await ctx.fiber.dispose()
    await retriever.close()
    await item.close()
  }
})

it.each(['close', 'caller'] as const)('cancels an in-flight extraction through %s, retaining a recoverable task', async mode => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  let pipeline: MemoryPipeline | undefined
  try {
    await ctx.plugin(LlmRuntime)
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      entered.resolve()
      const signal = options.signal!
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      released.resolve()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }
    }))
    pipeline = new MemoryPipeline(provider, settings, ctx.llm, () => {})
    const caller = new AbortController()
    const work = pipeline.learn({ ...batch(item.spec, turnEvents()), signal: caller.signal }).catch(error => error)
    await entered.promise
    if (mode === 'close') await pipeline.close()
    else caller.abort(new Error('caller cancelled'))
    await released.promise
    expect(await work).toBeInstanceOf(Error)
    expect(provider.l1.listTasks(item.spec.projectId, '', 10)[0]?.status).toBe('retry')
    if (mode === 'caller') await pipeline.close()
    expect(() => pipeline!.flush(item.spec.projectId)).toThrow('closing')
  } finally {
    await pipeline?.close()
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('retries a watched project in the background and continues from L1 through L3 without manual flush', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  let pipeline: MemoryPipeline | undefined
  try {
    await ctx.plugin(LlmRuntime)
    let calls = 0
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      calls++
      if (calls === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'retry later' } } }
      } else if (options.system?.startsWith('Summarize')) yield* response(JSON.stringify(candidate({ sessionId: header().id })))
      else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    const retrySettings = { ...settings, l1: resolveL1Config({ provider: 'test', model: 'test', retryBaseMs: 100, retryMaxMs: 100 }) }
    pipeline = new MemoryPipeline(provider, retrySettings, ctx.llm, () => {})
    await provider.appendRaw(batch(item.spec, turnEvents()))
    await pipeline.watch(item.spec.projectId)
    expect(calls).toBe(1)
    expect(provider.l1.listTasks(item.spec.projectId, '', 10)[0]?.status).toBe('retry')
    await vi.advanceTimersByTimeAsync(99)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(calls).toBe(4)
    expect(provider.knowledge.listCandidates(item.spec.projectId, 'L3')).toHaveLength(1)
    await pipeline.retire(item.spec.projectId)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(4)
  } finally {
    await pipeline?.close()
    await ctx.fiber.dispose()
    await item.close()
    vi.useRealTimers()
  }
})

it('recovers a watched project after restart and schedules due L2 retry before creating L3', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const item = await fixture()
  const ctx = new Context()
  let pipeline: MemoryPipeline | undefined
  try {
    const provider = await item.open()
    await ctx.plugin(LlmRuntime)
    let calls = 0
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      calls++
      if (calls === 2) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'retry later' } } }
      } else if (options.system?.startsWith('Summarize')) yield* response(JSON.stringify(candidate({ sessionId: header().id })))
      else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    const retrySettings = { ...settings, knowledge: resolveKnowledgeConfig({ provider: 'test', model: 'test', retryBaseMs: 100, retryMaxMs: 100 }) }
    pipeline = new MemoryPipeline(provider, retrySettings, ctx.llm, () => {})
    await pipeline.learn(batch(item.spec, turnEvents()))
    expect(calls).toBe(2)
    expect(provider.knowledge.listTasks(item.spec.projectId, '', 10)[0]?.status).toBe('retry')
    await pipeline.close()
    await provider.close()
    const reopened = await item.open()
    pipeline = new MemoryPipeline(reopened, retrySettings, ctx.llm, () => {})
    await pipeline.watch(item.spec.projectId)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(101)
    expect(calls).toBe(4)
    expect(reopened.knowledge.listCandidates(item.spec.projectId, 'L3')).toHaveLength(1)
    await pipeline.close()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await pipeline?.close()
    await ctx.fiber.dispose()
    await item.close()
    vi.useRealTimers()
  }
})

it('lets project B finish while project A is blocked in its model, preserving source ownership', async () => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  let pipeline: MemoryPipeline | undefined
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const sourceA = header('source-a')
  const sourceB = header('source-b')
  const projectA = 'project-a' as ProjectId
  const projectB = 'project-b' as ProjectId
  let workA: Promise<void> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      if (options.system?.startsWith('Summarize')) {
        if (options.sessionId === sourceA.id) { entered.resolve(); await release.promise }
        yield* response(JSON.stringify(candidate({ sessionId: options.sessionId! })))
      } else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    pipeline = new MemoryPipeline(provider, settings, ctx.llm, () => {})
    await provider.appendRaw({ ...batch(item.spec, turnEvents()), projectId: projectA, header: sourceA })
    await provider.appendRaw({ ...batch(item.spec, turnEvents()), projectId: projectB, header: sourceB })
    workA = pipeline.watch(projectA)
    void workA.catch(() => undefined)
    await entered.promise
    await pipeline.watch(projectB)
    const recordsB = provider.knowledge.listCandidates(projectB, 'L3')
    expect(recordsB).toHaveLength(1)
    expect(recordsB.every(record => record.projectId === projectB)).toBe(true)
    expect(provider.knowledge.listCandidates(projectA, 'L3')).toEqual([])
    await pipeline.retire(projectB)
    release.resolve()
    await workA
    const recordsA = provider.knowledge.listCandidates(projectA, 'L3')
    expect(recordsA).toHaveLength(1)
    expect(recordsA.every(record => record.projectId === projectA)).toBe(true)
    expect(provider.getSessionProject(sourceA.id)).toBe(projectA)
    expect(provider.getSessionProject(sourceB.id)).toBe(projectB)
  } finally {
    release.resolve()
    await pipeline?.close()
    await workA?.catch(() => undefined)
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('cancels same-project queued work without releasing project ordering or consuming a model call', async () => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const caller = new AbortController()
  const source = header('cancel-same-project')
  let calls = 0
  let pipeline: MemoryPipeline | undefined
  let first: Promise<unknown> | undefined
  let cancelled: Promise<unknown> | undefined
  let next: Promise<unknown> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      calls++
      if (options.system?.startsWith('Summarize')) {
        entered.resolve()
        await release.promise
        yield* response(JSON.stringify(candidate({ sessionId: source.id })))
      } else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    pipeline = new MemoryPipeline(provider, { ...settings, learningQueueCapacity: 1 }, ctx.llm, () => {})
    first = pipeline.learn({ ...batch(item.spec, turnEvents()), header: source }).catch(error => error)
    await entered.promise
    cancelled = pipeline.flush(item.spec.projectId, caller.signal).catch(error => error)
    const reason = new Error('cancel project queue')
    caller.abort(reason)
    expect(await cancelled).toBe(reason)
    await expect(pipeline.flush(item.spec.projectId, AbortSignal.abort(reason))).rejects.toBe(reason)
    next = pipeline.flush(item.spec.projectId).catch(error => error)
    await Promise.resolve()
    expect(calls).toBe(1)
    release.resolve()
    expect(await first).not.toBeInstanceOf(Error)
    expect(await next).toBeUndefined()
    expect(calls).toBe(3)
    expect(provider.knowledge.listCandidates(item.spec.projectId, 'L3')).toHaveLength(1)
  } finally {
    caller.abort(new Error('test cleanup'))
    release.resolve()
    await pipeline?.close()
    await Promise.all([first, cancelled, next])
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('bounds concurrency, cancels a queued drain promptly, and retains L0 rejected by backpressure', async () => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const caller = new AbortController()
  const calls: string[] = []
  const sourceA = header('bounded-a')
  const sourceB = header('bounded-b')
  const sourceC = header('bounded-c')
  const projectA = 'bounded-project-a' as ProjectId
  const projectB = 'bounded-project-b' as ProjectId
  const projectC = 'bounded-project-c' as ProjectId
  let pipeline: MemoryPipeline | undefined
  let workA: Promise<unknown> | undefined
  let workB: Promise<unknown> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      calls.push(options.sessionId!)
      if (options.system?.startsWith('Summarize')) {
        if (options.sessionId === sourceA.id) { entered.resolve(); await release.promise }
        yield* response(JSON.stringify(candidate({ sessionId: options.sessionId! })))
      } else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    pipeline = new MemoryPipeline(provider, { ...settings, learningConcurrency: 1, learningQueueCapacity: 1 }, ctx.llm, () => {})
    workA = pipeline.learn({ ...batch(item.spec, turnEvents()), header: sourceA, projectId: projectA }).catch(error => error)
    await entered.promise
    workB = pipeline.learn({ ...batch(item.spec, turnEvents()), header: sourceB, projectId: projectB, signal: caller.signal }).catch(error => error)
    // appendRaw commits synchronously; this checkpoint lets learn submit its drain before the overflow batch.
    const batchC = { ...batch(item.spec, turnEvents()), header: sourceC, projectId: projectC }
    await provider.appendRaw(batchC)
    await expect(pipeline.learn(batchC)).rejects.toMatchObject({ code: 'backpressure' })
    expect(calls).toEqual([sourceA.id])
    caller.abort(new Error('cancel queued B'))
    expect(await workB).toBeInstanceOf(Error)
    expect(calls).toEqual([sourceA.id])
    const copied = await provider.readRaw({ projectId: projectC, sessionId: sourceC.id, from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 10 })
    expect(copied.events).toHaveLength(3)
    expect(copied.committedTo).toBe(3)
    release.resolve()
    await workA
    await pipeline.flush(projectC)
    expect(provider.knowledge.listCandidates(projectC, 'L3')).toHaveLength(1)
    expect(calls).not.toContain(sourceB.id)
  } finally {
    caller.abort(new Error('test cleanup'))
    release.resolve()
    await pipeline?.close()
    await Promise.all([workA, workB])
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('automatically resumes a watched project refused by a full queue once capacity is released', async () => {
  const item = await fixture()
  const provider = await item.open()
  const ctx = new Context()
  const enteredA = Promise.withResolvers<void>()
  const enteredC = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const projectA = 'overflow-a' as ProjectId
  const projectB = 'overflow-b' as ProjectId
  const projectC = 'overflow-c' as ProjectId
  const sourceA = header('overflow-source-a')
  const sourceB = header('overflow-source-b')
  const sourceC = header('overflow-source-c')
  let pipeline: MemoryPipeline | undefined
  let workA: Promise<unknown> | undefined
  let workB: Promise<unknown> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
      if (options.system?.startsWith('Summarize')) {
        if (options.sessionId === sourceA.id) { enteredA.resolve(); await release.promise }
        if (options.sessionId === sourceC.id) enteredC.resolve()
        yield* response(JSON.stringify(candidate({ sessionId: options.sessionId! })))
      } else {
        const block = options.messages[0]!.content[0]!
        if (block.type !== 'text') throw new Error('expected text')
        yield* response(JSON.stringify([knowledgeCandidate(JSON.parse(block.text).input.sources[0])]))
      }
    }))
    pipeline = new MemoryPipeline(provider, { ...settings, learningConcurrency: 1, learningQueueCapacity: 1 }, ctx.llm, () => {})
    for (const [project, source] of [[projectA, sourceA], [projectB, sourceB], [projectC, sourceC]] as const) {
      await provider.appendRaw({ ...batch(item.spec, turnEvents()), header: source, projectId: project })
    }
    workA = pipeline.watch(projectA).catch(error => error)
    await enteredA.promise
    workB = pipeline.watch(projectB).catch(error => error)
    expect(() => pipeline!.watch(projectC)).toThrow('queue is full')
    release.resolve()
    expect(await workA).toBeUndefined()
    expect(await workB).toBeUndefined()
    await enteredC.promise
    await pipeline.retire(projectC)
    expect(provider.knowledge.listCandidates(projectC, 'L3')).toHaveLength(1)
  } finally {
    release.resolve()
    await pipeline?.close()
    await Promise.all([workA, workB])
    await ctx.fiber.dispose()
    await item.close()
  }
})
