/** Project-scoped browsing and exact-version selection shared by trusted UI adapters. */
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryId, MemoryRef } from './l1-types.ts'
import type { KnowledgeFilter, OwnedMemory, SharedMemory } from './knowledge-types.ts'
import type { SqliteMemory } from './sqlite.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { renderRecall } from './retrieval.ts'
import type { RetrievalHit } from './retrieval.ts'
import { vectorDocument } from './vector-store.ts'
import type { MemorySelection } from './selection-store.ts'

/** Deployment limits for browsing and combined manual/automatic admission. */
export interface BrowserConfig { pageSize?: number; maxQueryBytes?: number; limit?: number; maxBytes?: number; refreshIntervalMs?: number; stateCacheSessions?: number }
/** Resolved browser settings. */
export type BrowserSpec = Readonly<Required<BrowserConfig>>
/** @param input - deployment limits.
 * @returns complete validated settings.
 */
export function resolveBrowserConfig(input: BrowserConfig): BrowserSpec {
  const spec = { pageSize: input.pageSize ?? 50, maxQueryBytes: input.maxQueryBytes ?? 8192, limit: input.limit ?? 5,
    maxBytes: input.maxBytes ?? 8192,
    refreshIntervalMs: input.refreshIntervalMs ?? 3000, stateCacheSessions: input.stateCacheSessions ?? 32 }
  for (const [key, value] of Object.entries(spec)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new MemoryError('config', `memory browser ${key} must be a positive bounded integer`)
  }
  return Object.freeze(spec)
}

/** Raw records carry source metadata; derived records retain their exact version and owned lineage. */
export type BrowserItem = { readonly level: 'L0'; readonly header: SessionHeader; readonly event: SessionEvent } | OwnedMemory | SharedMemory
/** Cursor is scoped to the requested level by the trusted browser adapter. */
export type BrowserPosition = { readonly level: 'L0'; readonly sessionId: SessionId; readonly seq: number }
  | { readonly level: 'L1' | 'L2' | 'L3'; readonly id: MemoryId }
/** One bounded page; the query remains identical across its cursor chain. */
export interface BrowserPage { readonly items: readonly BrowserItem[]; readonly next: BrowserPosition | null }

/** Reuses storage authorization; UI callers never supply the project of a different Session. */
export class MemoryBrowser {
  private readonly injectors = new Set<symbol>()
  /** Whether a live Injector consumes this browser's pending selections. */
  get injectionReady(): boolean { return this.injectors.size > 0 }
  /** Register an Injector lifetime for panel status.
   * @returns idempotent disposer which withdraws this registration.
   */
  attachInjector(): () => void {
    const token = Symbol()
    this.injectors.add(token)
    return () => { this.injectors.delete(token) }
  }
  /** @param provider - caller-owned ready SQLite provider.
   * @param spec - resolved deployment limits.
   */
  constructor(private readonly provider: SqliteMemory | ((project: ProjectId) => SqliteMemory), readonly spec: BrowserSpec) {}

  private providerFor(project: ProjectId): SqliteMemory {
    return typeof this.provider === 'function' ? this.provider(project) : this.provider
  }

  /** @param project - authoritative requesting Session owner.
   * @param level - L0 through L3.
   * @param query - literal case-insensitive substring.
   * @param after - previous page position, or null.
   * @param filter - optional scenario and stable memory kind; retained across paging.
   * @returns bounded visible records and the next position.
   */
  browse(project: ProjectId, level: 'L0' | 'L1' | 'L2' | 'L3', query = '', after: BrowserPosition | null = null, filter: KnowledgeFilter = {}): BrowserPage {
    if (Buffer.byteLength(query, 'utf8') > this.spec.maxQueryBytes) throw new MemoryError('budget', 'memory browser query exceeds configured byte limit')
    if (after !== null && after.level !== level) throw new MemoryError('config', 'memory browser cursor belongs to another level')
    if (level === 'L0') {
      const rows = this.providerFor(project).browseRaw(project, after?.level === 'L0' ? after : null, this.spec.pageSize + 1, query)
      const items: BrowserItem[] = rows.slice(0, this.spec.pageSize).map(row => ({ level: 'L0', ...row }))
      const last = rows[this.spec.pageSize - 1]
      return { items, next: rows.length <= this.spec.pageSize || last === undefined ? null : { level, sessionId: last.header.id, seq: last.event.seq } }
    }
    const rows = this.providerFor(project).knowledge.browse(project, level, after !== null && after.level !== 'L0' ? after.id : '', this.spec.pageSize + 1, query, filter)
    const items = rows.slice(0, this.spec.pageSize)
    return { items, next: rows.length <= this.spec.pageSize ? null : { level, id: items.at(-1)!.id } }
  }

  /** @param project - requester.
   * @param ref - exact memory version.
   * @returns visible detail, including owned sources; shared details omit private lineage.
   */
  detail(project: ProjectId, ref: MemoryRef): OwnedMemory | SharedMemory | null { return this.providerFor(project).knowledge.getMemory(project, ref) }

  /** @param project - requester.
   * @param item - visible owned or shared version.
   * @returns whether every private source remains current; shared authorization already checks ancestry.
   */
  sourcesCurrent(project: ProjectId, item: OwnedMemory | SharedMemory): boolean {
    return 'shared' in item || item.level === 'L1' || item.knowledge.sources.every(source => this.providerFor(project).knowledge.sourcesCurrent(project, source.ref))
  }

  /** @param project - owner.
   * @returns committed revision and project-wide durable extraction counters.
   */
  status(project: ProjectId) { return this.providerFor(project).learningStatus(project) }

  /** @param project - requester.
   * @param id - memory identity.
   * @param before - exclusive revision, initially the maximum safe integer.
   * @returns owned history page; foreign memory history is never disclosed.
   */
  history(project: ProjectId, id: MemoryId, before = Number.MAX_SAFE_INTEGER): MemoryRef[] {
    return this.providerFor(project).knowledge.revisions(project, id, before, this.spec.pageSize)
  }

  /** @param project - requester.
   * @param refs - selected L2/L3 versions in user order.
   * @returns complete eligible text; rejects stale, private, unsupported or over-budget selections.
   */
  manual(project: ProjectId, refs: readonly MemoryRef[]): RetrievalHit[] {
    if (refs.length > this.spec.limit) throw new MemoryError('budget', 'Selected memory count exceeds the injection limit')
    const unique = new Map(refs.map(ref => [JSON.stringify([ref.id, ref.revision]), ref]))
    const hits = [...unique.values()].map(ref => {
      const memory = this.detail(project, ref)
      if (memory === null || memory.level === 'L1') throw new MemoryError('conflict', 'Selected L2/L3 memory is unavailable; select it again')
      const document = vectorDocument(memory)
      if (!this.providerFor(project).vectors.current(project, document)) throw new MemoryError('conflict', 'Selected memory changed or is no longer eligible; select it again')
      return { ref: { id: memory.id, revision: memory.revision }, projectId: memory.projectId, shared: 'shared' in memory,
        text: document.text, similarity: null }
    })
    if (Buffer.byteLength(renderRecall(hits), 'utf8') > this.spec.maxBytes) throw new MemoryError('budget', 'Selected memory text exceeds the injection byte budget')
    return hits
  }

  /** Recover selection consumption from committed messages after a process loss.
   * @param project - authoritative Session owner.
   * @param session - loaded canonical log.
   * @returns pending versions and automatic preference; null when none is saved.
   */
  selection(project: ProjectId, session: Session): MemorySelection | null {
    return this.selectionFromEvents(project, session.id, session.snapshotEvents())
  }

  /** Recover a pending selection from a persisted Session without creating an Agent.
   * @param project - authoritative captured owner.
   * @param sessionId - Session whose committed events were read.
   * @param events - committed log from that same Session.
   * @returns pending versions and automatic preference; null when none is saved.
   */
  selectionFromEvents(project: ProjectId, sessionId: SessionId, events: readonly SessionEvent[]): MemorySelection | null {
    const pending = this.providerFor(project).selections.get(project, sessionId)
    if (pending === null) return null
    for (const event of events) this.committed(project, sessionId, event)
    return this.providerFor(project).selections.get(project, sessionId)
  }

  /** @param project - authoritative Session owner.
   * @param sessionId - captured Session.
   * @param refs - exact user-selected versions; empty cancels pending selection.
   * @param automatic - explicit automatic recall preference.
   * @returns durable next-turn receipt, without waking the agent.
   */
  select(project: ProjectId, sessionId: SessionId, refs: readonly MemoryRef[], automatic: boolean): MemorySelection {
    const unique = [...new Map(refs.map(ref => [JSON.stringify([ref.id, ref.revision]), { id: ref.id, revision: ref.revision }])).values()]
    this.manual(project, unique)
    return this.providerFor(project).selections.replace(project, sessionId, unique, automatic)
  }

  /** Save recall preference independently of stale pending versions.
   * @param project - authoritative Session owner.
   * @param sessionId - captured Session.
   * @param automatic - explicit automatic recall preference.
   * @returns unchanged pending receipt with the saved preference.
   */
  setAutomatic(project: ProjectId, sessionId: SessionId, automatic: boolean): MemorySelection {
    return this.providerFor(project).selections.setAutomatic(project, sessionId, automatic)
  }

  /** Observe a committed recall; never consumes a newer pending receipt.
   * @param project - authoritative owner.
   * @param sessionId - log identity.
   * @param event - already committed event.
   */
  committed(project: ProjectId, sessionId: SessionId, event: SessionEvent): void {
    if (event.type === 'user/message' && event.data.source.kind === 'memory-recall' && event.data.source.selectionId !== undefined) {
      this.providerFor(project).selections.consume(project, sessionId, event.data.source.selectionId)
    }
  }
}
