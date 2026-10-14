/** Workspace history import and previewed retention operations over the authenticated panel. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelRequest, PanelResponse } from '../panel-protocol.ts'
import type { MemoryPanelProps } from './MemoryPanel.tsx'
import type { PanelState } from './state-observer.ts'
import type { MemoryPanelKey } from './locales.ts'
import css from './MemoryPanel.module.css'

type ImportPage = Extract<PanelResponse, { action: 'importPreview' }>
type ImportTask = Extract<PanelResponse, { action: 'importStart' }>['task']
type CleanupPreview = Extract<PanelResponse, { action: 'cleanupPreview' }>['preview']
const importFailureKey = (code: string | null | undefined): MemoryPanelKey => {
  switch (code) {
    case 'source': return 'importSourceFailure'
    case 'schema': return 'importSchemaFailure'
    case 'conflict': return 'importConflictFailure'
    case 'gap': return 'importGapFailure'
    case 'corrupt': return 'importCorruptFailure'
    case 'unknown-outcome': return 'operationUnknown'
    default: return 'importFailure'
  }
}

/** @param props - authoritative conversation and tab lifetime, with validated transport.
 * @returns import preview, durable task progress and cleanup controls.
 */
export function MaintenancePanel({ sessionId, signal, state, call, refresh, t, onUnknown }: Pick<MemoryPanelProps, 'sessionId' | 'call' | 'refresh' | 't'> & {
  signal: AbortSignal; state: PanelState; onUnknown: () => void
}): ReactNode {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [days, setDays] = useState('30')
  const [page, setPage] = useState<ImportPage>()
  const [selected, setSelected] = useState<SessionId[]>([])
  const [task, setTask] = useState<ImportTask | null>(null)
  const [preview, setPreview] = useState<CleanupPreview>()
  const [done, setDone] = useState<number>()
  const [compacted, setCompacted] = useState(false)
  const [failure, setFailure] = useState<'operationFailed' | 'dateInvalid' | 'operationUnknown'>()
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const mutation = useRef(0)
  const latest = useRef(task)
  latest.current = task
  const uncertain = failure === 'operationUnknown'
  const failed = (error: unknown): void => {
    if (error instanceof Error && error.message === 'unknown-outcome') onUnknown()
    setFailure(previous => previous === 'operationUnknown' || (error instanceof Error && error.message === 'unknown-outcome')
      ? 'operationUnknown' : 'operationFailed')
  }

  useEffect(() => {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(); operation.current?.abort() }
    signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const revision = mutation.current
      try {
        const [result, cleanupResult] = await Promise.all([
          call({ action: 'importStatus', sessionId, id: latest.current?.id ?? null }, controller.signal),
          call({ action: 'cleanupStatus', sessionId }, controller.signal),
        ])
        if (controller.signal.aborted) return
        if (revision === mutation.current) {
          if (result.action === 'importStatus') { latest.current = result.task; setTask(result.task) }
          if (cleanupResult.action === 'cleanupStatus' && cleanupResult.task !== null) setDone(cleanupResult.task.deletedSessions)
        }
      } catch (error) { if (!controller.signal.aborted) failed(error) }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, state.refreshIntervalMs)
    }
    if (!signal.aborted) void poll()
    return () => { signal.removeEventListener('abort', abort); abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId, signal, call, state.refreshIntervalMs])

  const run = async (request: PanelRequest, receive: (response: PanelResponse) => void): Promise<void> => {
    if (operation.current !== null && !operation.current.signal.aborted) return
    const controller = new AbortController()
    operation.current = controller
    mutation.current++
    const stop = (): void => { controller.abort() }
    signal.addEventListener('abort', stop, { once: true, signal: controller.signal })
    if (signal.aborted) controller.abort()
    setBusy(true)
    setFailure(previous => previous === 'operationUnknown' ? previous : undefined)
    try {
      const response = await call(request, controller.signal)
      controller.signal.throwIfAborted()
      receive(response)
      refresh(sessionId)
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }
  const showPreview = (more = false): void => {
    const start = from === '' ? undefined : Date.parse(`${from}T00:00:00`)
    const end = to === '' ? undefined : Date.parse(`${to}T23:59:59.999`)
    if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end)) || (start !== undefined && end !== undefined && start > end)) {
      setFailure('dateInvalid'); return
    }
    void run({ action: 'importPreview', sessionId, after: more ? page?.nextCursor ?? null : null,
      ...start === undefined ? {} : { fromCreatedAt: start }, ...end === undefined ? {} : { toCreatedAt: end } }, response => {
      if (response.action === 'importPreview') {
        if (!more) setSelected([])
        setPage(previous => ({ ...response, items: more ? [...previous?.items ?? [], ...response.items] : response.items }))
      }
    })
  }
  const cleanup = (execute: boolean): void => {
    const maxAgeDays = Number(days)
    if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) { setFailure('dateInvalid'); return }
    void run({ action: execute ? 'cleanup' : 'cleanupPreview', sessionId, maxAgeDays }, response => {
      if (response.action === 'cleanupPreview') { setPreview(response.preview); setDone(undefined) }
      if (response.action === 'cleanup') { setDone(response.task.deletedSessions); setPreview(undefined) }
    })
  }
  const importKey = task?.status === 'done' ? 'importDone' : task?.status === 'cancelled' ? 'importCancelled' : task?.status === 'running' ? 'importRunning' : 'importPending'
  return <details className={css.row}>
    <summary>{t('maintenance')}</summary>
    {failure !== undefined && <p role="alert">{t(failure)}</p>}
    <h3>{t('historyImport')}</h3><p>{t('importHelp')}</p>
    <form className={css.search} onSubmit={event => { event.preventDefault(); showPreview() }}>
      <label>{t('fromDate')}<Input type="date" aria-label={t('fromDate')} value={from} onChange={event => { setFrom(event.target.value); setPage(undefined) }} /></label>
      <label>{t('toDate')}<Input type="date" aria-label={t('toDate')} value={to} onChange={event => { setTo(event.target.value); setPage(undefined) }} /></label>
      <Button type="submit" disabled={busy}>{t('importPreview')}</Button>
    </form>
    {page !== undefined && <><p>{t(page.autoLearning ? 'importLearning' : 'importRawOnly')}</p>
      <p>{t('importPreviewCounts', { available: page.items.filter(item => item.status === 'available').length,
        imported: page.items.filter(item => item.status === 'imported').length, unsupported: page.items.filter(item => item.status === 'unsupported').length })}</p>
      {page.items.map(item => <div key={item.sessionId} className={css.row}>
        <Checkbox label={`${item.sessionId} · ${new Date(item.createdAt).toLocaleString()}`} checked={selected.includes(item.sessionId)} disabled={busy || item.status === 'unsupported'}
          onChange={checked => { setSelected(previous => checked ? [...previous.filter(id => id !== item.sessionId), item.sessionId] : previous.filter(id => id !== item.sessionId)) }} />
        <div>{t(item.status === 'available' ? 'importAvailable' : item.status === 'imported' ? 'importImported' : 'importUnsupported')}</div>
        {item.reason !== undefined && <p>{t(importFailureKey(item.reason))}</p>}
      </div>)}
      {page.nextCursor !== null && <Button disabled={busy} onClick={() => { showPreview(true) }}>{t('more')}</Button>}
      <Button disabled={busy || uncertain || selected.length === 0 || task?.status === 'running' || task?.status === 'pending'} onClick={() => {
        void run({ action: 'importStart', sessionId, sessionIds: selected }, response => { if (response.action === 'importStart') { setTask(response.task); setSelected([]) } })
      }}>{t('importStart')}</Button></>}
    {task !== null && <div role="status" aria-live="polite"><p>{t(importKey)}</p>
      {task.items.map(item => <div key={item.sessionId}>{item.sessionId} · {t('importProgress', { committed: item.committedTo, target: item.targetTo })}
        {(item.status === 'failed' || item.failure !== null) && <p>{t(importFailureKey(item.failure))}</p>}</div>)}
      {(task.status === 'running' || task.status === 'pending') && <Button disabled={busy || uncertain} onClick={() => {
        void run({ action: 'importCancel', sessionId, id: task.id }, response => { if (response.action === 'importCancel') setTask(response.task) })
      }}>{t('importCancel')}</Button>}
    </div>}
    <h3>{t('cleanupTitle')}</h3><p>{t('cleanupHelp')}</p>
    <label>{t('maxAgeDays')}<Input type="number" min={1} step={1} aria-label={t('maxAgeDays')} value={days} onChange={event => { setDays(event.target.value); setPreview(undefined) }} /></label>
    <Button disabled={busy} onClick={() => { cleanup(false) }}>{t('cleanupPreview')}</Button>
    {preview !== undefined && <><p>{t('cleanupCounts', { eligible: preview.eligibleSessions, protected: preview.protectedSessions, events: preview.eventCount, bytes: preview.bytes })}</p>
      <p>{t('cleanupProtected', { events: preview.protectedEventCount, bytes: preview.protectedBytes })}</p>
      <Button disabled={busy || uncertain || preview.eligibleSessions === 0} onClick={() => { cleanup(true) }}>{t('cleanupRun')}</Button></>}
    {done !== undefined && <p role="status">{t('cleanupDone', { count: done })}</p>}
    <Button disabled={busy} onClick={() => {
      void run({ action: 'importStatus', sessionId, id: task?.id ?? null }, response => { if (response.action === 'importStatus') setTask(response.task) })
    }}>{t('refreshStatus')}</Button>
    <div><Button disabled={busy || uncertain || task?.status === 'running' || task?.status === 'pending'} onClick={() => {
      void run({ action: 'compact', sessionId }, response => { if (response.action === 'compact') setCompacted(true) })
    }}>{t('compact')}</Button>{compacted && <p role="status">{t('compactDone')}</p>}</div>
  </details>
}
