/** Memory panel adapter over the existing authenticated Connection RPC registry. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { BrowserItem, MemoryBrowser } from './browser.ts'
import { panelRequest } from './panel-protocol.ts'
import type { PanelRequest, PanelResponse, PanelRow } from './panel-protocol.ts'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import { renderRecall } from './retrieval.ts'
import type {} from './index.ts'

type PanelUsed = Extract<PanelResponse, { action: 'state' }>['used']
interface StateProjection {
  offset: number
  used: PanelUsed
  tail: Promise<void>
}
const stateProjections = new WeakMap<MemoryBrowser, Map<SessionId, StateProjection>>()

async function recallState(ctx: Context, project: ProjectId, sessionId: SessionId,
  signal: AbortSignal): Promise<{ offset: number; used: PanelUsed }> {
  const browser = ctx.memory.browser
  let cache = stateProjections.get(browser)
  if (cache === undefined) { cache = new Map(); stateProjections.set(browser, cache) }
  let projection = cache.get(sessionId)
  projection ??= { offset: 0, used: [], tail: Promise.resolve() }
  cache.delete(sessionId)
  cache.set(sessionId, projection)
  while (cache.size > browser.spec.stateCacheSessions) cache.delete(cache.keys().next().value!)
  const current = projection
  const work = current.tail.then(async () => {
    signal.throwIfAborted()
    const stored = await ctx.memory.readRaw({ projectId: project, sessionId, from: SessionLogOffset(0), to: SessionLogOffset(0), limit: 1, signal })
    if (!stored.found) throw new MemoryError('source', 'Conversation memory capture is unavailable')
    if (stored.committedTo < current.offset) throw new MemoryError('source', 'Conversation memory is shorter than the observed prefix')
    if (current.offset !== stored.committedTo) {
      let offset = current.offset
      const used = [...current.used]
      while (offset < stored.committedTo) {
        signal.throwIfAborted()
        const page = await ctx.memory.readRaw({ projectId: project, sessionId, from: SessionLogOffset(current.offset),
          to: stored.committedTo, cursor: SessionLogOffset(offset), limit: browser.spec.pageSize, signal })
        if (!page.found || page.missing.length !== 0 || page.events.length === 0) throw new MemoryError('source', 'Conversation memory capture cannot supply the observed prefix')
        for (const event of page.events) {
          browser.committed(project, sessionId, event)
          if (event.type !== 'user/message' || event.data.source.kind !== 'memory-recall') continue
          used.push({ turn: event.data.source.turn,
            body: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
            refs: event.data.source.memories.map(memory => memory.ref) })
          if (used.length > browser.spec.pageSize) used.shift()
        }
        offset += page.events.length
      }
      signal.throwIfAborted()
      current.offset = offset
      current.used = used
    }
    return { offset: current.offset, used: [...current.used] }
  })
  // Each caller observes its own cancellation; a rejected read leaves the next caller free to retry.
  current.tail = work.then(() => {}, () => {})
  return work
}

function readable(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('\n')
  if (value === null || typeof value !== 'object') return ''
  return Object.entries(value).flatMap(([key, part]) => {
    if (['source', 'sources', 'stream', 'meta'].includes(key)) return []
    if (['text', 'content', 'command', 'output', 'message', 'result', 'arguments', 'reason', 'name', 'tool', 'path', 'status', 'kind', 'title', 'body', 'goal', 'actions', 'solution'].includes(key)) return [readable(part)]
    return typeof part === 'object' ? [readable(part)] : []
  }).filter(Boolean).join('\n')
}

function recordedText(text: string, preserveText = false): string {
  if (!/^[\s]*[\[{]/u.test(text)) return text
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    // Incomplete structured output remains available in the original event details.
    return preserveText ? text : ''
  }
  if (value !== null && typeof value === 'object' && 'memory' in value && 'text' in value && typeof value.text === 'string') return recordedText(value.text, true)
  return readable(value)
}

/** Produce browser text without following cross-project lineage.
 * @param item - authorized provider record.
 * @returns display fields; the adapter applies source eligibility before exposing selection.
 */
export function panelRowOf(item: BrowserItem): PanelRow {
  const extra = { description: null, trust: null, generation: null, raw: null, outcome: null, sourceStatus: 'current' as const }
  if (item.level === 'L0') {
    const event = item.event
    let sections: PanelRow['sections']
    if (event.type === 'memory/extraction-request') sections = [{ label: 'extractionRequest',
      text: `${event.data.level} · ${event.data.request.provider} / ${event.data.request.model}` }]
    else if (event.type === 'memory/extraction-result') sections = [{ label: event.data.outcome,
      text: recordedText(joinAssistantStreamText(event.data.stream)) }]
    else if (event.type === 'user/message' && event.data.source.kind === 'memory-recall') sections = [{ label: 'recalled',
      text: event.data.content.flatMap(block => block.type === 'text' ? [block.text.split('\n').map(text => recordedText(text, true)).filter(Boolean).join('\n')] : []).join('\n') }]
    else {
      const label = event.type === 'user/message' || event.type === 'assistant/message' ? 'conversation'
        : event.type.startsWith('tool/') ? 'execution' : 'record'
      sections = [{ label, text: readable(event.data) || event.type }]
    }
    const body = sections.map(section => section.text).join('\n')
    return { ...extra, level: 'L0', title: `${item.event.type} #${item.event.seq}`,
      body, raw: JSON.stringify(item.event, null, 2), sections,
      projectId: '', shared: false, ref: null, state: 'active', selectable: false,
      sources: [{ kind: 'event', sessionId: item.header.id, seq: item.event.seq }] }
  }
  const ref = { id: item.id, revision: item.revision }
  if ('shared' in item) return { ...extra, level: 'L3', title: item.title, body: item.body, projectId: item.projectId,
    shared: true, ref, state: 'active', selectable: true, sources: [], sections: [{ label: 'principle', text: item.body }] }
  const generation = { provider: item.config.provider, model: item.config.model, createdAt: item.createdAt }
  if (item.level === 'L1') return { ...extra, generation, level: 'L1', title: item.summary.goal, description: item.summary.description ?? null,
    body: [item.summary.goal, ...item.summary.actions, item.summary.result, item.summary.solution].filter(Boolean).join('\n'),
    raw: JSON.stringify(item, null, 2), outcome: item.summary.outcome,
    sections: [{ label: 'topic', text: item.summary.goal }, { label: 'actions', text: item.summary.actions.join('\n') },
      { label: 'result', text: item.summary.result }, ...item.summary.solution === null ? [] : [{ label: 'solution' as const, text: item.summary.solution }]],
    projectId: item.projectId, shared: false, ref, state: item.state, selectable: false,
    sources: item.summary.sources.map(source => ({ kind: 'event', ...source })) }
  return { ...extra, generation, raw: JSON.stringify(item, null, 2),
    trust: { score: item.knowledge.score, scoreMin: item.config.scoreMin, scoreMax: item.config.scoreMax,
      evidence: item.knowledge.evidence, rationale: item.knowledge.rationale, category: item.knowledge.category },
    sections: [{ label: item.level === 'L2' ? 'experience' : 'principle', text: item.knowledge.body }],
    level: item.level, title: item.knowledge.title, description: item.knowledge.description ?? null, body: item.knowledge.body, projectId: item.projectId,
    shared: false, ref, state: item.state, selectable: item.state === 'active' && item.knowledge.evidence === 'supported', sources: [...item.knowledge.sources] }
}

/** Dispatch for a captured live or persisted Session without starting an Agent.
 * @param ctx - Session and ready memory services.
 * @param request - validated wire request.
 * @param signal - transport cancellation.
 * @returns authorized result; project identity comes from captured Session ownership.
 */
export async function dispatchPanel(ctx: Context, request: PanelRequest, signal: AbortSignal): Promise<PanelResponse> {
  signal.throwIfAborted()
  const session = ctx.sessions.get(request.sessionId)
  const stored = session === undefined ? await ctx.sessionPersistence.stat(request.sessionId, { signal }) : undefined
  const header = session?.header ?? stored?.header
  if (header === undefined) throw new MemoryError('source', 'Conversation is unavailable for memory browsing')
  if (!ctx.memory.acceptsSession({ header })) throw new MemoryError('excluded', 'Memory is disabled for Sessions created before Workspace storage activation')
  if (session !== undefined) {
    try { await ctx.sessions.flush(session) } catch (error) {
      throw new MemoryError('source', 'Session memory capture could not confirm the current log prefix', error)
    }
  }
  signal.throwIfAborted()
  const project = ctx.memory.projectOfSession(request.sessionId)
  if (project === undefined) throw new MemoryError('source', 'Session memory capture is not ready')
  const browser = ctx.memory.browser
  const rowOf = (item: BrowserItem): PanelRow => {
    const row = panelRowOf(item)
    if (item.level === 'L0') return { ...row, projectId: project }
    const current = browser.sourcesCurrent(project, item)
    return { ...row, sourceStatus: current ? 'current' : 'needs-review', selectable: row.selectable && current }
  }
  switch (request.action) {
    case 'browse': {
      const page = browser.browse(project, request.level, request.query, request.after)
      return { action: 'browse', rows: page.items.map(rowOf), next: page.next }
    }
    case 'detail': {
      const item = browser.detail(project, request.ref)
      return { action: 'detail', row: item === null ? null : rowOf(item) }
    }
    case 'history': {
      const refs = browser.history(project, request.id, request.before)
      return { action: 'history', refs, next: refs.length === browser.spec.pageSize ? refs.at(-1)!.revision : null }
    }
    case 'select': {
      const saved = browser.select(project, request.sessionId, request.refs, request.automatic)
      return { action: 'select', refs: [...saved.refs], automatic: saved.automatic }
    }
    case 'automatic': {
      const saved = browser.setAutomatic(project, request.sessionId, request.automatic)
      return { action: 'automatic', refs: [...saved.refs], automatic: saved.automatic }
    }
    case 'state': {
      const { offset, used } = await recallState(ctx, project, request.sessionId, signal)
      signal.throwIfAborted()
      const selection = browser.selectionFromEvents(project, request.sessionId, [])
      let valid = true
      let bytes = 0
      try { bytes = Buffer.byteLength(renderRecall(browser.manual(project, selection?.refs ?? [])), 'utf8') } catch (error) {
        if (!(error instanceof MemoryError) || (error.code !== 'conflict' && error.code !== 'budget')) throw error
        valid = false
      }
      const pending = (selection?.refs ?? []).flatMap((ref) => {
        const item = browser.detail(project, ref)
        return item === null ? [] : [rowOf(item)]
      })
      const { generation, ...learning } = browser.status(project)
      return { action: 'state', projectId: project, refs: [...selection?.refs ?? []], automatic: selection?.automatic ?? false,
        injectionReady: browser.injectionReady, valid, bytes, limit: browser.spec.limit, maxBytes: browser.spec.maxBytes, used, pending,
        revision: `${generation}:${offset}`, refreshIntervalMs: browser.spec.refreshIntervalMs,
        recallMethod: ctx.memory.recallMethod(project),
        learning: { ...learning, enabled: ctx.memory.learningEnabled(project) } }
    }
  }
}

/** Register one private plugin channel through Connection's existing authentication and disposal.
 * @param ctx - ready Connection and memory services.
 * @returns registry disposer; pending requests stop with their transport lifetime.
 */
export function installPanelHost(ctx: Context): () => Promise<void> {
  const browser = ctx.memory.browser
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
  return async () => { stop(); abort.abort(); await Promise.allSettled(pending); stateProjections.delete(browser) }
}
