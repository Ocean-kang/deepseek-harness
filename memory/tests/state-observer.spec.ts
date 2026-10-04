/** Shared polling keeps independent consumers and cancelled RPC callers isolated. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createPanelStateObserver } from '../src/client/state-observer.ts'
import type { PanelCall, PanelState, PanelStateUpdate } from '../src/client/state-observer.ts'

afterEach(() => { vi.useRealTimers() })
const sessionId = SessionId('observed-session')
const state = (revision = 'initial'): PanelState => ({ action: 'state', projectId: 'project', refs: [], automatic: false,
  injectionReady: true, valid: true, bytes: 0, limit: 5, maxBytes: 8192, pending: [], used: [], revision,
  refreshIntervalMs: 100, recallMethod: 'trigram', learning: { enabled: true, pending: 0, running: 0, failed: 0, generated: 0 } })

it('shares in-flight reads and preserves another subscriber when one caller cancels', async () => {
  let settle: (value: PanelState) => void = () => { throw new Error('State read did not start') }
  let transportSignal: AbortSignal | undefined
  const transport: PanelCall = vi.fn(async (_request, signal) => {
    transportSignal = signal
    return await new Promise<PanelState>(resolve => { settle = resolve })
  })
  const observer = createPanelStateObserver(transport)
  const updates: PanelStateUpdate[] = []
  const stop = observer.watch(sessionId, update => { updates.push(update) })
  const cancelled = new AbortController()
  const admitted = new AbortController()
  const first = observer.call({ action: 'state', sessionId }, cancelled.signal)
  const second = observer.call({ action: 'state', sessionId }, admitted.signal)
  await Promise.resolve()
  expect(transport).toHaveBeenCalledTimes(1)
  const rejection = expect(first).rejects.toThrow('Caller closed')
  cancelled.abort(new Error('Caller closed'))
  await rejection
  expect(transportSignal?.aborted).toBe(false)
  settle(state())
  await expect(second).resolves.toEqual(state())
  expect(updates).toEqual([{ kind: 'state', state: state() }])
  stop()
  expect(transportSignal?.aborted).toBe(true)
  await observer.dispose()
})

it('refreshes selection writes and discards a pre-write state response before publishing it', async () => {
  vi.useFakeTimers()
  let saved = false
  let reads = 0
  let settle: (value: PanelState) => void = () => { throw new Error('Overlapping state read did not start') }
  const transport: PanelCall = async (request) => {
    if (request.action === 'select') { saved = true; return { action: 'select', refs: [], automatic: false } }
    if (request.action !== 'state') throw new Error('Unexpected request')
    reads += 1
    if (reads === 2) return await new Promise<PanelState>(resolve => { settle = resolve })
    return state(saved ? 'after-save' : 'before-save')
  }
  const observer = createPanelStateObserver(transport)
  const updates: PanelStateUpdate[] = []
  const stop = observer.watch(sessionId, update => { updates.push(update) })
  await observer.call({ action: 'state', sessionId }, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(100)
  expect(reads).toBe(2)
  await observer.call({ action: 'select', sessionId, refs: [], automatic: false }, new AbortController().signal)
  const refreshed = observer.call({ action: 'state', sessionId }, new AbortController().signal)
  settle(state('outdated-read'))
  await expect(refreshed).resolves.toEqual(state('after-save'))
  expect(reads).toBe(3)
  expect(updates).toEqual([{ kind: 'state', state: state('before-save') }, { kind: 'state', state: state('after-save') }])
  stop()
  await observer.dispose()
})

it('cancels the final subscription and suppresses late state publication after disposal', async () => {
  vi.useFakeTimers()
  let settle: (value: PanelState) => void = () => { throw new Error('State read did not start') }
  let transportSignal: AbortSignal | undefined
  const transport: PanelCall = vi.fn(async (_request, signal) => {
    transportSignal = signal
    return await new Promise<PanelState>(resolve => { settle = resolve })
  })
  const observer = createPanelStateObserver(transport)
  const first: PanelStateUpdate[] = []
  const second: PanelStateUpdate[] = []
  const stopFirst = observer.watch(sessionId, update => { first.push(update) })
  observer.watch(sessionId, update => { second.push(update) })
  await Promise.resolve()
  stopFirst()
  expect(transportSignal?.aborted).toBe(false)
  const disposing = observer.dispose()
  expect(transportSignal?.aborted).toBe(true)
  settle(state())
  await disposing
  await vi.advanceTimersByTimeAsync(1000)
  expect(first).toEqual([])
  expect(second).toEqual([])
  expect(transport).toHaveBeenCalledTimes(1)
})

it('isolates throwing subscribers and preserves polling and final cancellation for other subscribers', async () => {
  vi.useFakeTimers()
  const failure = new Error('Subscriber failed')
  const reported = vi.fn()
  let transportSignal: AbortSignal | undefined
  const transport: PanelCall = vi.fn(async (_request, signal) => { transportSignal = signal; return state() })
  const observer = createPanelStateObserver(transport, reported)
  const updates: PanelStateUpdate[] = []
  const stopThrowing = observer.watch(sessionId, () => { throw failure })
  const stopReading = observer.watch(sessionId, update => { updates.push(update) })
  await observer.call({ action: 'state', sessionId }, new AbortController().signal)
  expect(reported).toHaveBeenCalledWith(failure)
  expect(updates).toEqual([{ kind: 'state', state: state() }])
  await vi.advanceTimersByTimeAsync(100)
  expect(reported).toHaveBeenCalledTimes(2)
  expect(updates).toHaveLength(2)
  stopThrowing()
  expect(transportSignal?.aborted).toBe(false)
  stopReading()
  expect(transportSignal?.aborted).toBe(true)
  await observer.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect(transport).toHaveBeenCalledTimes(2)
})
