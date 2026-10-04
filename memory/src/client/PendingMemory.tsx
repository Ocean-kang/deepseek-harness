/** Composer reminder for saved next-turn memory, including committed admission receipts. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PanelState, PanelStateWatch } from './state-observer.ts'
import type {} from './locales.ts'
import css from './MemoryPanel.module.css'

/** Resident composer identity, localized copy and the authenticated endpoint. */
export type PendingMemoryProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'memoryPanel'> & {
  watch: PanelStateWatch
}

/** @param props - current conversation and plugin-owned selection notifications.
 * @returns saved pending memory before sending, and the last recorded model-context receipt.
 */
export function PendingMemory({ sessionId, t, watch }: PendingMemoryProps): ReactNode {
  const [state, setState] = useState<PanelState>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setState(undefined)
    setFailed(false)
    return watch(sessionId, update => {
      if (update.kind === 'state') {
        setState(update.state)
        setFailed(false)
      } else if (!(update.error instanceof Error && update.error.message === 'excluded')) setFailed(true)
    })
  }, [sessionId, watch, retry])
  if (state === undefined && failed) return <div className={css.dock} role="status">{t('failed')}
    <Button onClick={() => { setRetry(value => value + 1) }}>{t('retry')}</Button></div>
  if (state === undefined || (state.refs.length === 0 && state.used.length === 0)) return null
  const used = state.used.at(-1)
  return <div className={css.dock} data-memory-pending="true">
    {state.refs.length > 0 && <details>
      <summary>{t('beforeSend', { count: state.refs.length, bytes: state.bytes, maxBytes: state.maxBytes })}</summary>
      <p>{t('pendingHelp')}</p>
      {(!state.valid || failed) && <p role="status">{t(failed ? 'failed' : 'stale')}</p>}
      {!state.injectionReady && <p role="status">{t('unavailable')}</p>}
      <div className={css.pending}>{state.pending.map(row => <article key={`${row.ref?.id}:${row.ref?.revision}`}><div>{row.title}</div><div>{row.body}</div></article>)}</div>
    </details>}
    {used !== undefined && <details><summary>{t('lastUsed', { turn: used.turn, count: used.refs.length })}</summary>
      <p>{t('usedHelp')}</p><pre className={css.pending}>{used.body}</pre></details>}
  </div>
}
