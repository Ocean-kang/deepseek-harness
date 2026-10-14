/** Loads one bounded trace text page at a time after the user expands execution details. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryRef } from '../l1-types.ts'
import type { PanelResponse } from '../panel-protocol.ts'
import type { MemoryPanelProps } from './MemoryPanel.tsx'

type Trace = Extract<PanelResponse, { action: 'trace' }>

/** @param props - exact owned version and authenticated tab lifetime.
 * @returns lazily loaded execution details; previous text is replaced when paging.
 */
export function TracePanel({ sessionId, memory, signal, call, t }: Pick<MemoryPanelProps, 'sessionId' | 'call' | 't'> & {
  memory: MemoryRef; signal: AbortSignal
}): ReactNode {
  const [page, setPage] = useState<Trace>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [sessionId, memory.id, memory.revision])
  const load = async (cursor: Trace['nextCursor'] = null): Promise<void> => {
    if (pending.current !== null && !pending.current.signal.aborted) return
    const controller = new AbortController()
    pending.current = controller
    const stop = (): void => { controller.abort() }
    signal.addEventListener('abort', stop, { once: true, signal: controller.signal })
    if (signal.aborted) controller.abort()
    setBusy(true); setFailed(false)
    try {
      const response = await call({ action: 'trace', sessionId, ref: memory, cursor }, controller.signal)
      controller.signal.throwIfAborted()
      if (response.action === 'trace') {
        if (!response.found) setFailed(true)
        else setPage(response)
      }
    } catch (error) { if (!controller.signal.aborted) setFailed(true) } finally {
      if (!controller.signal.aborted) setBusy(false)
      controller.abort()
    }
  }
  return <details onToggle={event => { if (event.currentTarget.open && page === undefined) void load() }}>
    <summary>{t('trace')}</summary>
    {failed && <p role="alert">{t('operationFailed')}</p>}
    {page !== undefined && (page.text === '' ? <p>{t('noActions')}</p> : <pre>{page.text}</pre>)}
    <Button disabled={busy} onClick={() => { void load() }}>{t('traceLoad')}</Button>
    {page?.nextCursor !== undefined && page.nextCursor !== null && <Button disabled={busy} onClick={() => { void load(page.nextCursor) }}>{t('more')}</Button>}
  </details>
}
