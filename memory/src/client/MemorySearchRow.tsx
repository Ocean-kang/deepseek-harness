/** Readable memory-search results derived only from durable call and result data. */
import { z } from 'zod'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './MemoryPanel.module.css'

const results = z.array(z.object({ id: z.string(), revision: z.number().int(), level: z.enum(['L1', 'L2', 'L3']),
  shared: z.boolean(), evidenceStatus: z.enum(['claimed', 'model_supported', 'user_confirmed', 'execution_verified', 'externally_verified', 'conflicted', 'stale', 'shared_approved']), summary: z.string() }))

/** @param props - logged tool slice and locale seat.
 * @returns expandable historical references, with visible failure and pending states.
 */
export function MemorySearchRow(props: ToolCallViewProps & PropsLocale<'memoryPanel'>) {
  if (props.phase === 'preparing' || !('kind' in props.block)) return <div className={css.dock} role="status">{props.t('memorySearchRunning')}</div>
  const { block, t } = props
  const text = block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  if (block.isError) return <details className={css.dock}><summary>{t('memorySearchFailed')}</summary><pre>{text}</pre></details>
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { return <div className={css.dock}>{t('memorySearchUnreadable')}</div> }
  const parsed = results.safeParse(value)
  if (!parsed.success) return <div className={css.dock}>{t('memorySearchUnreadable')}</div>
  return <details className={css.dock} data-tool="memory_search"><summary>{t('memorySearchResults', { count: parsed.data.length })}</summary>
    {parsed.data.length === 0 ? <p>{t('empty')}</p> : parsed.data.map(item => <article className={css.row} key={`${item.id}:${item.revision}`}>
      <span className={css.badge}>{t('versionMetadata', { level: item.level, revision: item.revision })}</span>
      <p className={css.metadata}>{t(item.evidenceStatus === 'shared_approved' ? 'memorySearchShared' : item.evidenceStatus === 'stale' ? 'evidenceStale' : item.evidenceStatus)}</p>
      <p className={css.summary}>{item.summary}</p><span className={css.metadata}>{item.id}</span>
    </article>)}
  </details>
}
