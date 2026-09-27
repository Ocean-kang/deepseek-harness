/** Recorded LLM requests and durable worker failure handling using the Harness LLM service. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { KnowledgeExtractor } from '../src/knowledge-extractor.ts'
import { KnowledgeWorker } from '../src/knowledge-worker.ts'
import { L1ModelError } from '../src/l1-extractor.ts'
import type { L1Request } from '../src/l1-extractor.ts'
import { MemoryError } from '../src/types.ts'
import { knowledgeFixture, knowledgeCandidate } from './knowledge-fixtures.ts'
import type { KnowledgeConfig } from '../src/knowledge-types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
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
async function setup(overrides: Partial<KnowledgeConfig> = {}) {
  const item = await knowledgeFixture(overrides)
  cleanups.push(item.close)
  const store = item.provider.knowledge
  const operation = store.enqueue(item.project, 'L2', [item.source], item.config)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: L1Request[] = []
  const extractor = new KnowledgeExtractor(ctx.llm, async (_task, request, signal) => { signal.throwIfAborted(); records.push(request) }, SessionId('auxiliary'))
  const worker = new KnowledgeWorker(store, extractor)
  cleanups.push(() => worker.close())
  return { ...item, store, operation, ctx, extractor, records, worker }
}

it('records the frozen exact request before calling the real LLM service and commits once', async () => {
  const item = await setup()
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(options => {
    calls++
    expect(item.records).toHaveLength(1)
    expect(options.messages).toEqual(item.records[0]?.messages)
    expect(Object.isFrozen(item.records[0]?.messages)).toBe(true)
    expect(options.sessionId).toBe('auxiliary')
    return response(JSON.stringify([knowledgeCandidate(item.source)]))
  }))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).toBe(1)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'done', calls: 1, attempts: 1 })
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(1)
})

it.each(['not JSON', '{}', '[{"approved":true}]'])('rejects invalid output %s without publishing knowledge', async text => {
  const item = await setup()
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(text)))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', failure: 'output' })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})

it('does not call the model when request recording fails', async () => {
  const item = await setup()
  const called = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(called))
  const extractor = new KnowledgeExtractor(item.ctx.llm, async () => { throw new MemoryError('integration', 'Recorder unavailable') }, SessionId('auxiliary'))
  const worker = new KnowledgeWorker(item.store, extractor)
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(called).not.toHaveBeenCalled()
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'integration' })
})

it('rejects oversized complete input before recording or dispatch', async () => {
  const item = await setup({ maxInputBytes: 10 })
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.records).toEqual([])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'budget' })
})

it('preserves a prepared candidate on storage failure and retries without another model call', async () => {
  const item = await setup()
  let now = 10
  const generate = vi.fn(async () => [knowledgeCandidate(item.source)])
  const worker = new KnowledgeWorker(item.store, { consolidate: generate }, () => now)
  cleanups.push(() => worker.close())
  const original = item.store.commit.bind(item.store)
  vi.spyOn(item.store, 'commit').mockImplementationOnce(() => { throw new MemoryError('storage', 'Unavailable') }).mockImplementation(original)
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', candidates: [knowledgeCandidate(item.source)] })
  now = 1011
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(item.store.getTask(item.project, item.operation)?.status).toBe('done')
})

it('recognizes a successful commit even when its acknowledgement fails', async () => {
  const item = await setup()
  const original = item.store.commit.bind(item.store)
  vi.spyOn(item.store, 'commit').mockImplementation((...args) => { original(...args); throw new MemoryError('storage', 'Acknowledgement lost') })
  const worker = new KnowledgeWorker(item.store, { consolidate: async () => [knowledgeCandidate(item.source)] })
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)?.status).toBe('done')
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(1)
})

it('honors backoff and lifetime call budgets across explicit retries', async () => {
  const item = await setup({ maxAttempts: 1, maxCalls: 1 })
  let now = 10
  const worker = new KnowledgeWorker(item.store, { consolidate: async (_task, _signal, charge) => { charge(); throw new L1ModelError('TRANSIENT', true) } }, () => now)
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 1 })
  item.store.retry(item.project, item.operation)
  now = 1011
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 1, failure: 'budget' })
})

it('cancels in-flight work and waits for settlement without committing a late candidate', async () => {
  const item = await setup()
  const started = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const worker = new KnowledgeWorker(item.store, { consolidate: async (_task, signal) => {
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    await settled.promise
    return [knowledgeCandidate(item.source)]
  } })
  cleanups.push(async () => { settled.resolve(); await worker.close() })
  const run = worker.run(item.project, item.operation, new AbortController().signal)
  await started.promise
  let closed = false
  const closing = worker.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  settled.resolve()
  await Promise.all([run, closing])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', candidates: null })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
  await expect(worker.run(item.project, item.operation, new AbortController().signal)).rejects.toMatchObject({ code: 'closed' })
})

it('classifies a model deadline as retryable and does not publish partial output', async () => {
  const item = await setup({ timeoutMs: 20 })
  vi.useFakeTimers()
  const started = Promise.withResolvers<void>()
  item.ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
    const aborted = Promise.withResolvers<void>()
    options.signal!.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    options.signal!.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const run = item.worker.run(item.project, item.operation, new AbortController().signal)
  await started.promise
  await vi.advanceTimersByTimeAsync(21)
  await run
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', failure: 'MEMORY_KNOWLEDGE_TIMEOUT' })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})
