/** Shared Session state reads for the memory sidebar and conversation composer. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelRequest, PanelResponse } from '../panel-protocol.ts'

/** Validated transport operation; failures carry a safe category, never private response text. */
export type PanelCall = (request: PanelRequest, signal: AbortSignal) => Promise<PanelResponse>

/** Saved choices, extraction progress and recent committed recall. */
export type PanelState = Extract<PanelResponse, { action: 'state' }>
/** A failed refresh retains the last state in each subscriber. */
export type PanelStateUpdate = { kind: 'state'; state: PanelState } | { kind: 'error'; error: unknown }
/** Subscribe to one shared polling lifetime; the final disposer cancels its outstanding read. */
export type PanelStateWatch = (sessionId: SessionId, listener: (update: PanelStateUpdate) => void) => () => void
/** Request fresh state after a user action, sharing any outstanding read. */
export type PanelStateRefresh = (sessionId: SessionId) => void

interface ObservedSession {
  sessionId: SessionId
  controller: AbortController
  listeners: Set<(update: PanelStateUpdate) => void>
  readers: number
  revision: number
  state: PanelState | undefined
  work: Promise<PanelStateUpdate> | undefined
  interval: number | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Share state RPCs and polling while preserving caller cancellation.
 * @param transport - authenticated, validated panel endpoint.
 * @param onListenerError - records one subscriber failure without stopping other subscribers.
 * @returns the shared call, subscriptions and plugin-lifetime disposer.
 */
export function createPanelStateObserver(
  transport: PanelCall,
  onListenerError: (error: unknown) => void = (error) => { console.error('Memory state subscriber failed', error) },
): {
  call: PanelCall
  watch: PanelStateWatch
  refresh: PanelStateRefresh
  dispose: () => Promise<void>
} {
  const sessions = new Map<SessionId, ObservedSession>()
  const notify = (listener: (update: PanelStateUpdate) => void, update: PanelStateUpdate): void => {
    try { listener(update) } catch (error) { onListenerError(error) }
  }
  const clearTimer = (entry: ObservedSession): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
  }
  const remove = (entry: ObservedSession): void => {
    if (entry.listeners.size > 0 || entry.readers > 0) return
    clearTimer(entry)
    entry.controller.abort()
    sessions.delete(entry.sessionId)
  }
  const entryOf = (sessionId: SessionId): ObservedSession => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { sessionId, controller: new AbortController(), listeners: new Set(), readers: 0, revision: 0,
        state: undefined, work: undefined, interval: undefined, timer: undefined }
      sessions.set(sessionId, entry)
    }
    return entry
  }
  const read = (entry: ObservedSession): Promise<PanelStateUpdate> => {
    if (entry.work !== undefined) return entry.work
    clearTimer(entry)
    entry.work = Promise.resolve().then(async (): Promise<PanelStateUpdate> => {
      let update: PanelStateUpdate
      try {
        for (;;) {
          const revision = entry.revision
          const response = await transport({ action: 'state', sessionId: entry.sessionId }, entry.controller.signal)
          entry.controller.signal.throwIfAborted()
          if (revision !== entry.revision) continue
          if (response.action !== 'state') throw new Error('protocol')
          entry.state = response
          entry.interval = response.refreshIntervalMs
          update = { kind: 'state', state: response }
          break
        }
      } catch (error) { update = { kind: 'error', error } }
      entry.work = undefined
      if (!entry.controller.signal.aborted) {
        for (const listener of entry.listeners) notify(listener, update)
        if (entry.listeners.size > 0 && entry.interval !== undefined) {
          entry.timer = setTimeout(() => { void read(entry) }, entry.interval)
        }
        remove(entry)
      }
      return update
    })
    return entry.work
  }
  const refresh: PanelStateRefresh = (sessionId) => {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return
    entry.revision += 1
    entry.state = undefined
    clearTimer(entry)
    if (entry.listeners.size > 0) void read(entry)
  }
  const call: PanelCall = async (request, signal) => {
    signal.throwIfAborted()
    if (request.action !== 'state') {
      const response = await transport(request, signal)
      signal.throwIfAborted()
      if (response.action === 'select' || response.action === 'automatic') refresh(request.sessionId)
      return response
    }
    const entry = entryOf(request.sessionId)
    entry.readers += 1
    try {
      const pending = entry.work ?? (entry.state === undefined ? read(entry) : Promise.resolve<PanelStateUpdate>({ kind: 'state', state: entry.state }))
      const update = await new Promise<PanelStateUpdate>((resolve, reject) => {
        const stop = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled')) }
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
        void pending.then(value => { signal.removeEventListener('abort', stop); resolve(value) },
          (error: unknown) => { signal.removeEventListener('abort', stop); reject(error instanceof Error ? error : new Error('storage')) })
      })
      signal.throwIfAborted()
      if (update.kind === 'error') throw update.error instanceof Error ? update.error : new Error('storage')
      return update.state
    } finally { entry.readers -= 1; remove(entry) }
  }
  const watch: PanelStateWatch = (sessionId, listener) => {
    const entry = entryOf(sessionId)
    entry.listeners.add(listener)
    if (entry.state !== undefined) notify(listener, { kind: 'state', state: entry.state })
    else void read(entry)
    return () => { entry.listeners.delete(listener); remove(entry) }
  }
  return { call, watch, refresh, dispose: async () => {
    const pending = [...sessions.values()].flatMap(entry => entry.work === undefined ? [] : [entry.work])
    for (const entry of sessions.values()) { clearTimer(entry); entry.controller.abort(); entry.listeners.clear() }
    sessions.clear()
    await Promise.allSettled(pending)
  } }
}
