/** Memory panel adapter over the existing authenticated Connection RPC registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserItem } from './browser.ts'
import { panelRequest } from './panel-protocol.ts'
import type { PanelRequest, PanelResponse, PanelRow } from './panel-protocol.ts'
import { MemoryError } from './types.ts'
import { renderRecall } from './retrieval.ts'
import type {} from './index.ts'

/** Produce browser text without following cross-project lineage.
 * @param item - authorized provider record.
 * @returns display fields; selectability follows the same policy as admission.
 */
export function panelRowOf(item: BrowserItem): PanelRow {
  if (item.level === 'L0') return { level: 'L0', title: `${item.header.id} #${item.event.seq} ${item.event.type}`,
    body: JSON.stringify(item.event, null, 2), projectId: '', shared: false, ref: null, state: 'active', selectable: false,
    sources: [{ kind: 'event', sessionId: item.header.id, seq: item.event.seq }] }
  const ref = { id: item.id, revision: item.revision }
  if ('shared' in item) return { level: 'L3', title: item.title, body: item.body, projectId: item.projectId,
    shared: true, ref, state: 'active', selectable: true, sources: [] }
  if (item.level === 'L1') return { level: 'L1', title: item.summary.goal, body: JSON.stringify(item.summary, null, 2),
    projectId: item.projectId, shared: false, ref, state: item.state, selectable: false,
    sources: item.summary.sources.map(source => ({ kind: 'event', ...source })) }
  return { level: item.level, title: item.knowledge.title, body: item.knowledge.body, projectId: item.projectId,
    shared: false, ref, state: item.state, selectable: item.state === 'active' && item.knowledge.evidence === 'supported', sources: [...item.knowledge.sources] }
}

/** Dispatch only for a loaded Session, after capture has settled.
 * @param ctx - Session and ready memory services.
 * @param request - validated wire request.
 * @param signal - transport cancellation.
 * @returns authorized result; project identity comes from captured Session ownership.
 */
export async function dispatchPanel(ctx: Context, request: PanelRequest, signal: AbortSignal): Promise<PanelResponse> {
  signal.throwIfAborted()
  const session = ctx.sessions.get(request.sessionId)
  if (session === undefined) throw new MemoryError('source', 'Open this conversation before browsing its memory')
  if (!ctx.memory.acceptsSession(session)) throw new MemoryError('excluded', 'Memory is disabled for Sessions created before Workspace storage activation')
  try { await ctx.sessions.flush(session) } catch (error) {
    throw new MemoryError('source', 'Session memory capture could not confirm the current log prefix', error)
  }
  signal.throwIfAborted()
  const project = ctx.memory.projectOfSession(session.id)
  if (project === undefined) throw new MemoryError('source', 'Session memory capture is not ready')
  const browser = ctx.memory.browser
  switch (request.action) {
    case 'browse': {
      const page = browser.browse(project, request.level, request.query, request.after)
      return { action: 'browse', rows: page.items.map(item => {
        const row = panelRowOf(item)
        return item.level === 'L0' ? { ...row, projectId: project } : row
      }), next: page.next }
    }
    case 'detail': {
      const item = browser.detail(project, request.ref)
      return { action: 'detail', row: item === null ? null : panelRowOf(item) }
    }
    case 'history': {
      const refs = browser.history(project, request.id, request.before)
      return { action: 'history', refs, next: refs.length === browser.spec.pageSize ? refs.at(-1)!.revision : null }
    }
    case 'select': {
      const saved = browser.select(project, session.id, request.refs, request.automatic)
      return { action: 'select', refs: [...saved.refs], automatic: saved.automatic }
    }
    case 'state': {
      const selection = browser.selection(project, session)
      let valid = true
      let bytes = 0
      try { bytes = Buffer.byteLength(renderRecall(browser.manual(project, selection?.refs ?? [])), 'utf8') } catch (error) {
        if (!(error instanceof MemoryError) || (error.code !== 'conflict' && error.code !== 'budget')) throw error
        valid = false
      }
      const used = session.snapshotEvents().flatMap(event => {
        if (event.type !== 'user/message' || event.data.source.kind !== 'memory-recall') return []
        return [{ turn: event.data.source.turn, body: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
          refs: event.data.source.memories.map(memory => memory.ref) }]
      }).slice(-browser.spec.pageSize)
      return { action: 'state', projectId: project, refs: [...selection?.refs ?? []], automatic: selection?.automatic ?? false,
        injectionReady: browser.injectionReady, valid, bytes, limit: browser.spec.limit, maxBytes: browser.spec.maxBytes, used }
    }
  }
}

/** Register one private plugin channel through Connection's existing authentication and disposal.
 * @param ctx - ready Connection and memory services.
 * @returns registry disposer; pending requests stop with their transport lifetime.
 */
export function installPanelHost(ctx: Context): () => Promise<void> {
  const abort = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const stop = ctx.connection.rpc.handle('/memory', async (endpoint, payload, signal) => {
    if (endpoint !== 'panel') return { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown memory endpoint', details: {} } }
    const parsed = panelRequest.safeParse(payload)
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid memory panel request', details: {} } }
    const work = (async () => {
      const lifetime = AbortSignal.any([abort.signal, signal])
      try { return { ok: true as const, value: await dispatchPanel(ctx, parsed.data, lifetime) } } catch (error) {
        lifetime.throwIfAborted()
        return { ok: false as const, error: { code: error instanceof MemoryError ? error.code : 'storage',
          message: error instanceof MemoryError ? error.message : 'Memory panel request failed', details: {} } }
      }
    })()
    pending.add(work)
    try { return await work } finally { pending.delete(work) }
  })
  return async () => { stop(); abort.abort(); await Promise.allSettled(pending) }
}
