/** Sidebar content with cancellable project-scoped reads and durable next-turn choices. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MemoryRef } from '../l1-types.ts'
import type { PanelRequest, PanelResponse, PanelRow } from '../panel-protocol.ts'
import type {} from './locales.ts'
import css from './MemoryPanel.module.css'

/** Validated transport operation; failures carry a safe category, never private response text. */
export type PanelCall = (request: PanelRequest, signal: AbortSignal) => Promise<PanelResponse>
/** Injected endpoint and the existing tab/locale seats. */
export type MemoryPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'memoryPanel'> & { call: PanelCall }
type PanelState = Extract<PanelResponse, { action: 'state' }>
type Page = Extract<PanelResponse, { action: 'browse' }>
const same = (left: MemoryRef, right: MemoryRef): boolean => left.id === right.id && left.revision === right.revision

/** @param props - framework Session/tab lifetime, typed copy and validated endpoint.
 * @returns L0–L3 browser, pending selection and the exact committed recall text.
 */
export function MemoryPanel({ sessionId, useTabInfo, t, call }: MemoryPanelProps): ReactNode {
  const { tab } = useTabInfo()
  const [level, setLevel] = useState<PanelRow['level']>('L2')
  const [query, setQuery] = useState('')
  const submittedQuery = useRef('')
  const [page, setPage] = useState<Page>({ action: 'browse', rows: [], next: null })
  const [state, setState] = useState<PanelState>()
  const [draft, setDraft] = useState<MemoryRef[]>([])
  const [detail, setDetail] = useState<PanelRow>()
  const [history, setHistory] = useState<MemoryRef[]>([])
  const [historyNext, setHistoryNext] = useState<number | null>(null)
  const [failure, setFailure] = useState<'failed' | 'stale' | 'budget' | 'excluded'>()
  const [busy, setBusy] = useState(false)
  const reads = useRef<AbortController | null>(null)
  const writes = useRef<AbortController | null>(null)
  const dirty = useRef(false)
  const owner = useRef(sessionId)

  const failed = (error: unknown): void => {
    const code = error instanceof Error ? error.message : ''
    setFailure(code === 'excluded' ? 'excluded' : code === 'conflict' ? 'stale' : code === 'budget' ? 'budget' : 'failed')
  }
  const lifetime = (): AbortController => {
    const controller = new AbortController()
    const stop = (): void => { controller.abort() }
    tab.signal.addEventListener('abort', stop, { once: true, signal: controller.signal })
    if (tab.signal.aborted) controller.abort()
    return controller
  }
  const reload = async (more = false, search = submittedQuery.current): Promise<void> => {
    reads.current?.abort()
    const controller = lifetime()
    reads.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const [listed, status] = await Promise.all([
        call({ action: 'browse', sessionId, level, query: search, after: more ? page.next : null }, controller.signal),
        call({ action: 'state', sessionId }, controller.signal),
      ])
      if (controller.signal.aborted) return
      if (listed.action !== 'browse' || status.action !== 'state') throw new Error('invalid response')
      submittedQuery.current = search
      setPage(previous => ({ ...listed, rows: more ? [...previous.rows, ...listed.rows] : listed.rows }))
      setState(status)
      if (!more && !dirty.current) setDraft(status.refs)
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }
  useEffect(() => {
    if (owner.current !== sessionId) { owner.current = sessionId; dirty.current = false; setDraft([]); setState(undefined) }
    setDetail(undefined)
    setHistory([])
    setHistoryNext(null)
    setPage({ action: 'browse', rows: [], next: null })
    void reload()
    return () => { reads.current?.abort(); writes.current?.abort() }
  }, [sessionId, level, call, tab.signal])

  const save = async (refs: MemoryRef[], automatic: boolean, preserveDraft = false): Promise<void> => {
    if (writes.current !== null && !writes.current.signal.aborted) return
    const controller = lifetime()
    writes.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await call({ action: 'select', sessionId, refs, automatic }, controller.signal)
      if (controller.signal.aborted) return
      if (result.action !== 'select') throw new Error('invalid response')
      if (!preserveDraft) { dirty.current = false; setDraft(result.refs) }
      await reload()
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }
  const show = async (row: PanelRow): Promise<void> => {
    reads.current?.abort()
    const controller = lifetime()
    reads.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const result = row.ref === null ? null : await call({ action: 'detail', sessionId, ref: row.ref }, controller.signal)
      if (controller.signal.aborted) return
      const current = result?.action === 'detail' ? result.row : row
      if (current === null) throw new Error('conflict')
      const sameMemory = current.ref !== null && detail?.ref !== undefined && detail.ref !== null && current.ref.id === detail.ref.id
      setDetail(current)
      if (!sameMemory) { setHistory([]); setHistoryNext(null) }
      if (current.ref !== null && !current.shared && !sameMemory) {
        const versions = await call({ action: 'history', sessionId, id: current.ref.id, before: Number.MAX_SAFE_INTEGER }, controller.signal)
        if (!controller.signal.aborted && versions.action === 'history') { setHistory(versions.refs); setHistoryNext(versions.next) }
      }
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }

  const older = async (): Promise<void> => {
    if (detail?.ref === undefined || detail.ref === null || historyNext === null) return
    reads.current?.abort()
    const controller = lifetime()
    reads.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const versions = await call({ action: 'history', sessionId, id: detail.ref.id, before: historyNext }, controller.signal)
      if (!controller.signal.aborted && versions.action === 'history') {
        setHistory(previous => [...previous, ...versions.refs])
        setHistoryNext(versions.next)
      }
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }

  return <section className={css.root} aria-label={t('title')} data-memory-panel="true">
    <header className={css.header}>
      {state !== undefined && <div>{t('project', { project: state.projectId })}</div>}
      <nav className={css.levels} aria-label={t('title')}>
        {(['L0', 'L1', 'L2', 'L3'] as const).map(item => <Button key={item} aria-pressed={level === item} onClick={() => { setLevel(item) }}>{item}</Button>)}
      </nav>
      <form className={css.search} onSubmit={event => { event.preventDefault(); void reload(false, query) }}>
        <Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => { setQuery(event.target.value) }} />
        <Button type="submit" disabled={busy}>{t('search')}</Button>
        <Button disabled={busy} onClick={() => { void reload() }}>{t('retry')}</Button>
      </form>
    </header>
    <div className={css.body} aria-busy={busy}>
      {failure !== undefined && <p role="alert">{t(failure)}</p>}
      {state?.valid === false && <p role="status">{t('stale')}</p>}
      {busy && page.rows.length === 0 && <div className={css.skeleton} aria-hidden="true" />}
      {!busy && failure === undefined && page.rows.length === 0 && <p>{t('empty')}</p>}
      {page.rows.map(row => <article className={css.row} key={row.ref === null ? row.title : `${row.ref.id}:${row.ref.revision}`}>
        <Button className={css.title} onClick={() => { void show(row) }} aria-label={`${t('detail')}: ${row.title}`}>{row.title}</Button>
        <div>{row.ref === null ? row.level : `${row.level} · v${row.ref.revision}`} · {t(row.state)}{row.shared && ` · ${t('shared')}`}</div>
        <pre className={css.preview}>{row.body}</pre>
        {row.selectable && row.ref !== null && <Checkbox label={t('select')} checked={draft.some(ref => same(ref, row.ref!))}
          disabled={busy} onChange={checked => { dirty.current = true; setDraft(previous => checked ? [...previous.filter(ref => !same(ref, row.ref!)), row.ref!] : previous.filter(ref => !same(ref, row.ref!))) }} />}
      </article>)}
      {page.next !== null && <Button disabled={busy} onClick={() => { void reload(true) }}>{t('more')}</Button>}
      {detail !== undefined && <article className={css.row}>
        <Button onClick={() => { setDetail(undefined) }}>{t('close')}</Button>
        <h3>{detail.title}</h3><pre>{detail.body}</pre>
        <div>{detail.ref === null ? detail.level : `${detail.level} · v${detail.ref.revision}`} · {t(detail.state)}{detail.shared && ` · ${t('shared')}`}</div>
        <h4>{t('source')}</h4><pre>{JSON.stringify(detail.sources, null, 2)}</pre>
        {history.length > 0 && <div>{t('history')}: {history.map(ref => <Button key={ref.revision} aria-pressed={detail.ref?.revision === ref.revision} onClick={() => { void show({ ...detail, ref }) }}>v{ref.revision}</Button>)}</div>}
        {historyNext !== null && <Button disabled={busy} onClick={() => { void older() }}>{t('older')}</Button>}
      </article>}
      {state !== undefined && state.used.length > 0 && <details className={css.row}>
        <summary>{t('used')}</summary>
        {state.used.map(used => <div key={used.turn}><div>{t('turn', { turn: used.turn })}</div><pre>{used.body}</pre></div>)}
      </details>}
    </div>
    <footer className={css.footer}>
      {state !== undefined && !state.injectionReady && <div role="status">{t('unavailable')}</div>}
      <div>{t('selected', { count: draft.length })}</div>
      {state !== undefined && <div>{t('pending', { count: state.refs.length, bytes: state.bytes, maxBytes: state.maxBytes })} · {t('limit', { limit: state.limit })}</div>}
      <div>{t('automatic')} <Switch label={t('automatic')} checked={state?.automatic ?? false} disabled={busy || state === undefined || !state.injectionReady}
        onChange={automatic => { void save(state?.refs ?? [], automatic, true) }} /></div>
      <Button disabled={busy || state === undefined} onClick={() => { void save(draft, state?.automatic ?? false) }}>{t('apply')}</Button>
      <Button disabled={busy || state === undefined} onClick={() => { void save([], state?.automatic ?? false) }}>{t('cancel')}</Button>
    </footer>
  </section>
}
