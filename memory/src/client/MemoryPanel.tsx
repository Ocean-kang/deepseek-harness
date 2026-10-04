/** Sidebar content with cancellable project-scoped reads and durable next-turn choices. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MemoryRef } from '../l1-types.ts'
import type { PanelResponse, PanelRow } from '../panel-protocol.ts'
import type { PanelCall, PanelState, PanelStateRefresh, PanelStateWatch } from './state-observer.ts'
import type {} from './locales.ts'
import css from './MemoryPanel.module.css'

export type { PanelCall } from './state-observer.ts'
/** Injected endpoint and the existing tab/locale seats. */
export type MemoryPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'memoryPanel'> & {
  call: PanelCall
  watch: PanelStateWatch
  refresh: PanelStateRefresh
}
type Page = Extract<PanelResponse, { action: 'browse' }>
const same = (left: MemoryRef, right: MemoryRef): boolean => left.id === right.id && left.revision === right.revision
const rowKey = (row: PanelRow): string => row.ref === null ? JSON.stringify(row.sources) : `${row.ref.id}:${row.ref.revision}`

function highlight(text: string, query: string): ReactNode {
  if (!query) return text
  const lower = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const parts: ReactNode[] = []
  let start = 0
  let index = lower.indexOf(needle)
  while (index !== -1) {
    parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + query.length)}</mark>)
    start = index + query.length
    index = lower.indexOf(needle, start)
  }
  parts.push(text.slice(start))
  return parts
}

/** @param props - framework Session/tab lifetime, typed copy and validated endpoint.
 * @returns L0–L3 browser, pending selection and the exact committed recall text.
 */
export function MemoryPanel({ sessionId, useTabInfo, t, call, watch, refresh }: MemoryPanelProps): ReactNode {
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
  const body = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string | undefined; offset: number; scroll: number } | null>(null)
  const observe = useRef<(status: PanelState) => Promise<void>>(async () => {})
  const listedRevision = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    if (anchor.current === null || body.current === null) return
    const saved = anchor.current
    anchor.current = null
    const item = [...body.current.querySelectorAll<HTMLElement>('[data-row-key]')].find(row => row.dataset.rowKey === saved.key)
    body.current.scrollTop = item === undefined ? saved.scroll
      : body.current.scrollTop + item.getBoundingClientRect().top - body.current.getBoundingClientRect().top - saved.offset
  }, [page])

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
  const reload = async (more = false, search = submittedQuery.current, preserve = false): Promise<void> => {
    reads.current?.abort()
    const controller = lifetime()
    reads.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const [first, status] = await Promise.all([
        call({ action: 'browse', sessionId, level, query: search, after: more ? page.next : null }, controller.signal),
        call({ action: 'state', sessionId }, controller.signal),
      ])
      if (controller.signal.aborted) return
      if (first.action !== 'browse' || status.action !== 'state') throw new Error('invalid response')
      let listed = first
      if (preserve) {
        const previousLast = page.rows.at(-1)
        const previousEvent = previousLast?.sources.find(source => source.kind === 'event')
        const beforeLast = (): boolean => {
          const last = listed.rows.at(-1)
          if (previousLast?.ref !== undefined && previousLast.ref !== null) return (last?.ref?.id ?? '') < previousLast.ref.id
          const event = last?.sources.find(source => source.kind === 'event')
          return previousEvent !== undefined && (event === undefined || event.sessionId < previousEvent.sessionId
            || (event.sessionId === previousEvent.sessionId && event.seq < previousEvent.seq))
        }
        while (listed.next !== null && (listed.rows.length < page.rows.length
          || beforeLast())) {
          const following = await call({ action: 'browse', sessionId, level, query: search, after: listed.next }, controller.signal)
          controller.signal.throwIfAborted()
          if (following.action !== 'browse') throw new Error('invalid response')
          listed = { ...following, rows: [...listed.rows, ...following.rows] }
        }
        if (detail?.ref !== undefined && detail.ref !== null) {
          const refreshed = await call({ action: 'detail', sessionId, ref: detail.ref }, controller.signal)
          controller.signal.throwIfAborted()
          if (refreshed.action === 'detail' && refreshed.row !== null) setDetail(refreshed.row)
        }
        if (body.current !== null) {
          const top = body.current.getBoundingClientRect().top
          const visible = [...body.current.querySelectorAll<HTMLElement>('[data-row-key]')].find(row => row.getBoundingClientRect().bottom > top)
          anchor.current = { key: visible?.dataset.rowKey, offset: (visible?.getBoundingClientRect().top ?? top) - top,
            scroll: body.current.scrollTop }
        }
      }
      submittedQuery.current = search
      listedRevision.current = status.revision
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
    listedRevision.current = undefined
    setDetail(undefined)
    setHistory([])
    setHistoryNext(null)
    setPage({ action: 'browse', rows: [], next: null })
    void reload()
    return () => { reads.current?.abort(); writes.current?.abort() }
  }, [sessionId, level, call, tab.signal])

  observe.current = async (status) => {
    if ((reads.current !== null && !reads.current.signal.aborted) || (writes.current !== null && !writes.current.signal.aborted)) return
    const controller = lifetime()
    reads.current = controller
    try {
      setState(status)
      if (!dirty.current) setDraft(status.refs)
      if (listedRevision.current !== status.revision) {
        controller.abort()
        await reload(false, submittedQuery.current, true)
      }
    } catch (error) { if (!controller.signal.aborted) failed(error) } finally { controller.abort() }
  }
  useEffect(() => {
    if (tab.signal.aborted) return
    const stop = watch(sessionId, update => {
      if (update.kind === 'state') void observe.current(update.state)
      else failed(update.error)
    })
    tab.signal.addEventListener('abort', stop, { once: true })
    return () => { tab.signal.removeEventListener('abort', stop); stop() }
  }, [sessionId, watch, tab.signal])

  const save = async (
    refs: MemoryRef[], automatic: boolean, preserveDraft = false, added?: MemoryRef, preferenceOnly = false,
  ): Promise<void> => {
    if (writes.current !== null && !writes.current.signal.aborted) return
    const controller = lifetime()
    writes.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await call(preferenceOnly ? { action: 'automatic', sessionId, automatic } : { action: 'select', sessionId, refs, automatic }, controller.signal)
      if (controller.signal.aborted) return
      if (result.action !== 'select' && result.action !== 'automatic') throw new Error('invalid response')
      if (!preserveDraft) { dirty.current = false; setDraft(result.refs) }
      else if (added !== undefined) setDraft(previous => [...previous.filter(ref => !same(ref, added)), added])
      await reload(false, submittedQuery.current, true)
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
        controller.signal.throwIfAborted()
        if (versions.action === 'history') { setHistory(versions.refs); setHistoryNext(versions.next) }
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

  const content = (row: PanelRow, full = false): ReactNode => <>
    {!full && row.description && <p className={css.summary}>{highlight(row.description, submittedQuery.current)}</p>}
    {(full || !row.description ? row.sections : []).map((section, index) => {
      const query = submittedQuery.current
      const match = section.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      const start = full || !query || match < 0 ? 0 : Math.max(0, match - 60)
      const text = full ? section.text : section.text.slice(start, start + 280)
      return <div key={index} className={css.field}><span className={css.label}>{t(section.label)}</span>
        <div>{highlight(`${start > 0 ? '…' : ''}${text || (section.label === 'actions' ? t('noActions') : '')}${!full && start + 280 < section.text.length ? '…' : ''}`, query)}</div></div>
    })}
    {row.outcome !== null && <div>{t(row.outcome)}</div>}
    {row.sourceStatus === 'needs-review' && <div role="status">{t('needsReview')}</div>}
    {submittedQuery.current && ![row.title, row.description ?? '', ...row.sections.map(section => section.text)].some(text => text.toLocaleLowerCase().includes(submittedQuery.current.toLocaleLowerCase())) && <div>{t('rawMatch')}</div>}
  </>

  return <section className={css.root} aria-label={t('title')} data-memory-panel="true">
    <header className={css.header}>
      <div className={css.masthead}><h2>{t('title')}</h2><span>{t('description')}</span></div>
      {state !== undefined && <div className={css.project}>{t('project', { project: state.projectId })}</div>}
      <nav className={css.levels} aria-label={t('title')}>
        {(['L0', 'L1', 'L2', 'L3'] as const).map(item => <Button key={item} aria-pressed={level === item} onClick={() => { setLevel(item) }}>{item}</Button>)}
      </nav>
      <h3 className={css.sectionTitle}>{t(level)}</h3>
      <p>{t(level === 'L0' || level === 'L1' ? 'readOnly' : 'selectionHelp')}</p>
      <form className={css.search} onSubmit={(event) => { event.preventDefault(); void reload(false, query) }}>
        <Input className={css.searchInput ?? ''} aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <Button className={css.primary} size="sm" type="submit" disabled={busy}>{t('search')}</Button>
        <Button className={css.link} size="sm" disabled={busy} onClick={() => {
          refresh(sessionId)
          void reload(false, submittedQuery.current, true)
        }}>{t('retry')}</Button>
      </form>
      <p>{t('searchScope', { level })}</p>
      {state !== undefined && <div className={css.learning} role="status" aria-live="polite">
        {!state.learning.enabled && <div>{t('learningDisabled')}</div>}
        {state.learning.enabled && state.learning.pending + state.learning.running > 0 && <div>{t('learning', { count: state.learning.pending + state.learning.running })}</div>}
        {state.learning.failed > 0 && <div className={css.warning}>{t('learningFailed', { count: state.learning.failed })}</div>}
        <div>{t('learned', { count: state.learning.generated })}</div>
      </div>}
    </header>
    <div className={css.body} ref={body} aria-busy={busy}>
      {failure !== undefined && <p role="alert">{t(failure)}</p>}
      {state?.valid === false && <p role="status">{t('stale')}</p>}
      {busy && page.rows.length === 0 && <div className={css.skeleton} aria-hidden="true" />}
      {!busy && failure === undefined && page.rows.length === 0 && <p className={css.empty}>{t('empty')}</p>}
      {submittedQuery.current && <p>{t('searchMatches', { count: page.rows.length, query: submittedQuery.current })}</p>}
      {page.rows.map((row, index) => {
        const selected = row.ref
        return <article className={css.row} key={rowKey(row)} data-row-key={selected?.id ?? rowKey(row)}>
          <div className={css.entryHeading}>
            {row.selectable && selected !== null && <Checkbox className={css.selection} label={t('select')}
              title={t('selectRow', { title: row.title })} checked={draft.some(ref => same(ref, selected))}
              disabled={busy} onChange={(checked) => {
                dirty.current = true
                setDraft(previous => checked ? [...previous.filter(ref => !same(ref, selected)), selected]
                  : previous.filter(ref => !same(ref, selected)))
              }} />}
            <span className={css.ordinal}>[{index + 1}]</span>
            <Button className={css.title} onClick={() => { void show(row) }} aria-label={`${t('detail')}: ${row.title}`}>{highlight(row.title, submittedQuery.current)}</Button></div>
          <div className={css.metadata}>{row.ref === null ? row.level : `${row.level} · v${row.ref.revision}`} · {t(row.state)}{row.shared && ` · ${t('shared')}`}</div>
          {content(row)}
          <div className={css.rowActions}>
            {row.selectable && selected !== null && <Button aria-label={t('applyRow', { title: row.title })}
              className={css.link} size="sm"
              disabled={busy || state === undefined || state.refs.some(ref => same(ref, selected))}
              onClick={() => { void save([...state?.refs ?? [], selected], state?.automatic ?? false, true, selected) }}>{t('apply')}</Button>}
          </div>
        </article>
      })}
      {page.next !== null && <Button disabled={busy} onClick={() => { void reload(true) }}>{t('more')}</Button>}
      {detail !== undefined && <article className={css.row}>
        <Button onClick={() => { setDetail(undefined) }}>{t('close')}</Button>
        <h3>{detail.title}</h3>
        {detail.description && <p className={css.summary}>{highlight(detail.description, submittedQuery.current)}</p>}
        {content(detail, true)}
        <div>{detail.ref === null ? detail.level : `${detail.level} · v${detail.ref.revision}`} · {t(detail.state)}{detail.shared && ` · ${t('shared')}`}</div>
        {detail.trust !== null && <dl className={css.trust}>
          <dt>{t('importance', { score: detail.trust.score, min: detail.trust.scoreMin, max: detail.trust.scoreMax })}</dt><dd>{t('trustHelp')}</dd>
          <dt>{t('evidence')}</dt><dd>{t(detail.trust.evidence)}</dd>
          <dd>{t('evidenceHelp')}</dd>
          <dt>{t('category')}</dt><dd>{t(detail.trust.category)}</dd>
          <dt>{t('rationale')}</dt><dd>{detail.trust.rationale}</dd>
        </dl>}
        {detail.generation !== null && <p>{t('generation')}: {detail.generation.provider} / {detail.generation.model}</p>}
        <h4>{t('source')}</h4>
        {detail.shared && <p>{t('sharedPrivacy')}</p>}
        <div>{t(detail.sourceStatus === 'needs-review' ? 'reviewHelp' : 'currentSources')}</div>
        <ul>{detail.sources.map((source, index) => <li key={index}>{source.kind === 'memory'
          ? <Button onClick={() => { void show({ ...detail, ref: source.ref }) }}>{source.ref.id} · v{source.ref.revision}</Button>
          : `${source.sessionId} #${source.seq}`}</li>)}</ul>
        {detail.raw !== null && <details><summary>{t('raw')}</summary><pre>{highlight(detail.raw, submittedQuery.current)}</pre></details>}
        {history.length > 0 && <div>{t('history')}: {history.map(ref => <Button key={ref.revision} aria-pressed={detail.ref?.revision === ref.revision} onClick={() => { void show({ ...detail, ref }) }}>v{ref.revision}</Button>)}</div>}
        {historyNext !== null && <Button disabled={busy} onClick={() => { void older() }}>{t('older')}</Button>}
      </article>}
      {state !== undefined && state.used.length > 0 && <details className={css.row}>
        <summary>{t('used')}</summary>
        <p>{t('usedHelp')}</p>
        {state.used.map((used, index) => <div key={index}><div>{t('turn', { turn: used.turn })}</div><pre>{used.body}</pre>
          <ul>{used.refs.map(ref => <li key={`${ref.id}:${ref.revision}`}>{ref.id} · v{ref.revision}</li>)}</ul></div>)}
      </details>}
    </div>
    <footer className={css.footer}>
      {state !== undefined && !state.injectionReady && <div role="status">{t('unavailable')}</div>}
      <div className={css.pendingHeading}><h3>{t('pendingTitle')}</h3><span>{t('selected', { count: draft.length })}</span></div>
      {state !== undefined && <div className={css.metadata}>{t('pending', { count: state.refs.length, bytes: state.bytes, maxBytes: state.maxBytes })} · {t('limit', { limit: state.limit })}</div>}
      {state !== undefined && <div className={css.pending}>{state.pending.map(row => <article key={rowKey(row)}>
        <div>{row.title}</div><div>{row.body}</div>
        {row.sourceStatus === 'needs-review' && <div>{t('needsReview')}</div>}
        <Button disabled={busy} onClick={() => { void save(state.refs.filter(ref => row.ref === null || !same(ref, row.ref)), state.automatic) }}>{t('remove')}</Button>
      </article>)}</div>}
      <div className={css.automatic}>{t('automatic')} <Switch label={t('automatic')} checked={state?.automatic ?? false} disabled={busy || state === undefined || !state.injectionReady}
        onChange={(automatic) => { void save([], automatic, true, undefined, true) }} /></div>
      <details><summary>{t('recallHelp')}</summary><p>{t('pendingHelp')}</p><p>{t('searchHelp')}</p>
        {state !== undefined && <p>{t(state.recallMethod === 'trigram' ? 'textHelp' : state.recallMethod === 'unicode61' ? 'unicodeHelp' : state.recallMethod === 'vector' ? 'vectorHelp' : 'disabledHelp')}</p>}
      </details>
      <div className={css.footerActions}>
        <Button className={css.primary} size="sm" disabled={busy || state === undefined} onClick={() => { void save(draft, state?.automatic ?? false) }}>{t('applySelection')}</Button>
        <Button className={css.link} size="sm" disabled={busy || state === undefined} onClick={() => { void save([], state?.automatic ?? false) }}>{t('cancel')}</Button>
      </div>
    </footer>
  </section>
}
