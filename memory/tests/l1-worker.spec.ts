/** Deterministic due-time, cancellation and uncertain-commit recovery tests. */
import { afterEach, expect, it, vi } from 'vitest'
import { L1Worker } from '../src/l1-worker.ts'
import { L1ModelError } from '../src/l1-extractor.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { MemoryError } from '../src/types.ts'
import { batch, fixture, header } from './helpers.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import type { L1Config, L1Failure } from '../src/l1-types.ts'
import type { L1Extractor } from '../src/l1-extractor.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

async function setup(extractor: Pick<L1Extractor, 'extractTurn'>, overrides: Partial<L1Config> = {}) {
  const item = await fixture()
  cleanups.push(() => item.close())
  const provider = await item.open()
  await provider.appendRaw(batch(item.spec, turnEvents()))
  const config = resolveL1Config({ provider: 'test', model: 'test', maxAttempts: 2, retryBaseMs: 100, retryMaxMs: 200, ...overrides })
  provider.scanTurns(item.spec.projectId, config, 2)
  let clock = 0
  const failures: L1Failure[] = []
  const worker = new L1Worker(provider, extractor, item.spec.projectId, 1, (_id, failure) => failures.push(failure), () => clock)
  cleanups.push(() => worker.close())
  const task = () => provider.l1.listTasks(item.spec.projectId, '', 10)[0]!
  return { ...item, provider, worker, failures, task, setTime: (value: number) => { clock = value } }
}

it('reads the full paginated turn and commits only one version on repeated flush', async () => {
  let calls = 0
  const state = await setup({ async extractTurn(task, events) {
    calls++
    expect(events.map(event => event.seq)).toEqual([0, 1, 2])
    return candidate(task)
  } })
  await Promise.all([state.worker.flush(header().id), state.worker.flush(header().id)])
  expect(calls).toBe(1)
  expect(state.task().status).toBe('done')
  expect(state.provider.l1.byOperation(state.spec.projectId, state.task().operationId)?.revision).toBe(1)
})

it('persists retry times, stops at the attempt limit and supports explicit retry', async () => {
  let calls = 0
  const state = await setup({ async extractTurn(task) {
    calls++
    if (calls <= 2) throw new L1ModelError('RATE_LIMIT', true)
    return candidate(task)
  } })
  await state.worker.flush(header().id)
  expect(state.task()).toMatchObject({ attempts: 1, status: 'retry', nextRetryAt: 100 })
  state.setTime(99)
  await state.worker.flush(header().id)
  expect(calls).toBe(1)
  state.setTime(100)
  await state.worker.flush(header().id)
  expect(state.task()).toMatchObject({ attempts: 2, status: 'failed' })
  const task = state.task()
  expect(state.provider.l1.rerun(state.spec.projectId, task.operationId, 'retry', task.config)).toBe(task.operationId)
  await state.worker.flush(header().id)
  expect(state.task().status).toBe('done')
  expect(state.failures).toEqual([{ code: 'RATE_LIMIT', retryable: true }, { code: 'RATE_LIMIT', retryable: true }])
})

it('reuses a persisted candidate after a transient commit failure', async () => {
  let calls = 0
  const state = await setup({ async extractTurn(task) { calls++; return candidate(task) } })
  const original = state.provider.l1.commitMemory.bind(state.provider.l1)
  const commit = vi.spyOn(state.provider.l1, 'commitMemory').mockImplementationOnce(() => { throw new MemoryError('storage', 'injected transient failure') }).mockImplementation(original)
  try {
    await state.worker.flush(header().id)
    expect(state.task()).toMatchObject({ status: 'retry', candidate: { kind: 'memory' } })
    state.setTime(100)
    await state.worker.flush(header().id)
    expect(state.task().status).toBe('done')
    expect(calls).toBe(1)
  } finally { commit.mockRestore() }
})

it('queries the operation after an ambiguous successful commit', async () => {
  const state = await setup({ async extractTurn(task) { return candidate(task) } })
  const original = state.provider.l1.commitMemory.bind(state.provider.l1)
  const commit = vi.spyOn(state.provider.l1, 'commitMemory').mockImplementationOnce((...args) => {
    original(...args)
    throw new MemoryError('storage', 'reply lost after commit')
  })
  try {
    await state.worker.flush(header().id)
    expect(state.task()).toMatchObject({ status: 'done', attempts: 1 })
    expect(state.failures).toEqual([])
  } finally { commit.mockRestore() }
})

it('waits for cancellation settlement before close and leaves no half-written memory', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let settled = false
  const state = await setup({ async extractTurn(task, _events, signal) {
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    await release.promise
    settled = true
    return candidate(task)
  } })
  const work = state.worker.flush(header().id)
  await entered.promise
  let closed = false
  const closing = state.worker.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  release.resolve()
  await Promise.all([work, closing])
  expect(settled).toBe(true)
  expect(state.task()).toMatchObject({ status: 'retry', attempts: 0, candidate: null })
  expect(state.provider.l1.byOperation(state.spec.projectId, state.task().operationId)).toBeNull()
  await expect(state.worker.flush(header().id)).rejects.toMatchObject({ code: 'closed' })
})

it('does not retry invalid output or claim successful extraction', async () => {
  const state = await setup({ async extractTurn() { throw new MemoryError('output', 'invalid output') } })
  await state.worker.flush(header().id)
  state.setTime(1000)
  await state.worker.flush(header().id)
  expect(state.task()).toMatchObject({ status: 'failed', attempts: 1, candidate: null, failure: { code: 'output', retryable: false } })
})

it('recovers failed work after reopen with its original saved model configuration', async () => {
  const state = await setup({ async extractTurn() { throw new L1ModelError('NETWORK', true) } })
  await state.worker.flush(header().id)
  await state.worker.close()
  await state.provider.close()
  const reopened = await state.open()
  const worker = new L1Worker(reopened, { async extractTurn(task) {
    expect(task.config.model).toBe('test')
    return candidate(task)
  } }, state.spec.projectId, 1, () => {}, () => 100)
  cleanups.push(() => worker.close())
  await worker.flush(header().id)
  expect(reopened.l1.listTasks(state.spec.projectId, '', 10)[0]?.status).toBe('done')
})

it('automatically wakes a watched source at its persisted retry time', async () => {
  let calls = 0
  const completed = Promise.withResolvers<void>()
  const state = await setup({ async extractTurn(task) {
    calls++
    if (calls === 1) throw new L1ModelError('RATE_LIMIT', true)
    completed.resolve()
    return candidate(task)
  } })
  vi.useFakeTimers()
  state.worker.watch(header().id)
  await vi.advanceTimersByTimeAsync(1)
  expect(state.task()).toMatchObject({ status: 'retry', nextRetryAt: 100 })
  state.setTime(100)
  await vi.advanceTimersByTimeAsync(100)
  await completed.promise
  await state.worker.flush(header().id)
  expect(state.task().status).toBe('done')
})

it('retires an active source without redispatching its cancelled task', async () => {
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const state = await setup({ async extractTurn(task, _events, signal) {
    calls++
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return candidate(task)
  } })
  const work = state.worker.flush(header().id)
  await entered.promise
  await state.worker.retire(header().id)
  await work
  expect(calls).toBe(1)
  expect(state.task().status).toBe('retry')
})

it('enforces the durable model-call budget across retries', async () => {
  let calls = 0
  const state = await setup({ async extractTurn(_task, _events, _signal, reserve) {
    reserve()
    calls++
    throw new L1ModelError('TRANSPORT', true)
  } }, { maxCalls: 1 })
  await state.worker.flush(header().id)
  expect(state.task()).toMatchObject({ status: 'retry', calls: 1 })
  state.setTime(100)
  await state.worker.flush(header().id)
  expect(state.task()).toMatchObject({ status: 'failed', calls: 1, failure: { code: 'budget' } })
  expect(calls).toBe(1)
})
