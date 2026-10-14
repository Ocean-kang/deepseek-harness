/** Workspace-verified historical copying with durable per-session progress and bounded pages. */
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { MaintenanceStore, ImportTask, ImportSource } from './maintenance-store.ts'
import type { OperationId } from './l1-types.ts'
import type { ProjectId, RawMemory } from './types.ts'
import { MemoryError } from './types.ts'

/** Async worker projection of maintenance operations. */
export type AsyncMaintenance = { [K in keyof MaintenanceStore]: MaintenanceStore[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never }
/** Minimum persistence capabilities used by the importer. */
export interface HistoryMemory extends Pick<RawMemory, 'appendRaw'> { readonly maintenance: AsyncMaintenance }
/** Creation-time filter and identity cursor for a project-local import preview. */
export interface ImportPreviewRequest {
  readonly projectId: ProjectId
  readonly fromCreatedAt?: number
  readonly toCreatedAt?: number
  readonly after?: SessionId
  readonly limit?: number
}
/** Body-free source preview; unsupported entries require fixing the source backend before import. */
export interface ImportPreviewItem {
  readonly sessionId: SessionId
  readonly createdAt: number
  readonly eventCount: number | null
  readonly status: 'available' | 'imported' | 'unsupported'
  readonly reason?: 'source' | 'schema' | 'conflict'
}
/** Only sources verified as belonging to the requested current workspace appear here. */
export interface ImportPreview {
  readonly items: readonly ImportPreviewItem[]
  readonly nextCursor: SessionId | null
  readonly autoLearning: boolean
}

/** Copies existing sources without creating Agents or rewriting immutable Session metadata. */
export class HistoryImporter {
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private readonly active = new Set<OperationId>()
  private readonly stopping = new AbortController()

  /** @param source - authoritative Session persistence.
   * @param memory - project-routed durable store.
   * @param resolveProject - header-to-current-workspace verifier; undefined excludes unbound workspaces.
   * @param committed - schedule extraction only when deployment enables it; must not throw.
   * @param pageSize - positive source event page count.
   * @param pageBytes - UTF-8 event bytes retained by each append page; one oversized event is allowed.
   * @param autoLearning - preview disclosure matching the deployment's extraction behavior.
   * @param report - body-free error notification; must not throw.
   */
  constructor(private readonly source: Pick<SessionPersistence, 'list' | 'stat' | 'open'>,
    private readonly memory: HistoryMemory,
    private readonly resolveProject: (header: SessionHeader) => Promise<ProjectId | undefined>,
    private readonly committed: (projectId: ProjectId) => void,
    private readonly pageSize: number,
    private readonly pageBytes: number,
    private readonly autoLearning: boolean,
    private readonly report: (error: MemoryError) => void = () => {}) {
    if (![pageSize, pageBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new MemoryError('config', 'Invalid import page budgets')
  }

  /** Preview creation-time-filtered metadata; copied sources without counts use a bounded tail read.
   * @param request - workspace identity, inclusive creation-time bounds and exclusive identity cursor.
   * @returns one page and an opaque identity continuation cursor.
   */
  async preview(request: ImportPreviewRequest): Promise<ImportPreview> {
    this.assertOpen()
    const limit = request.limit ?? this.pageSize
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.pageSize
      || [request.fromCreatedAt, request.toCreatedAt].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      || (request.fromCreatedAt !== undefined && request.toCreatedAt !== undefined && request.fromCreatedAt > request.toCreatedAt)) throw new MemoryError('config', 'Invalid historical preview filter')
    // SessionPersistence currently lists all lightweight metadata; uncopied sources remain unopened.
    const snapshots = [...await this.source.list({ signal: this.stopping.signal })].sort((a, b) => a.header.id < b.header.id ? -1 : a.header.id > b.header.id ? 1 : 0)
    const items: ImportPreviewItem[] = []
    let nextCursor: SessionId | null = null
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (header.id <= (request.after ?? '') || header.createdAt < (request.fromCreatedAt ?? 0)
        || header.createdAt > (request.toCreatedAt ?? Number.MAX_SAFE_INTEGER)) continue
      if (await this.resolveProject(header) !== request.projectId) continue
      if (items.length === limit) { nextCursor = items.at(-1)!.sessionId; break }
      const unsupported = header.version !== SESSION_FORMAT_VERSION || snapshot.formatStatus === 'migration-required'
      const copiedTo = await this.memory.maintenance.copiedPrefix(request.projectId, header.id)
      const state: Pick<ImportPreviewItem, 'status' | 'reason'> = unsupported ? { status: 'unsupported', reason: 'schema' }
        : copiedTo !== null && snapshot.eventCount === undefined ? await this.previewCopiedTail(request.projectId, header.id, copiedTo)
        : { status: copiedTo !== null && snapshot.eventCount !== undefined && copiedTo >= snapshot.eventCount ? 'imported' : 'available' }
      items.push({ sessionId: header.id, createdAt: header.createdAt, eventCount: snapshot.eventCount ?? null,
        ...state })
    }
    return { items, nextCursor, autoLearning: this.autoLearning }
  }

  private async previewCopiedTail(projectId: ProjectId, sessionId: SessionId, copiedTo: number): Promise<Pick<ImportPreviewItem, 'status' | 'reason'>> {
    let handle: SessionHandle | undefined
    try {
      handle = await this.source.open(sessionId, 'read', { signal: this.stopping.signal })
      await this.verify(handle, projectId)
      if (copiedTo > 0 && (await handle.read(copiedTo - 1, 1, { signal: this.stopping.signal })).events[0]?.seq !== copiedTo - 1) {
        return { status: 'unsupported', reason: 'source' }
      }
      const nextSeq = (await handle.read(copiedTo, 1, { signal: this.stopping.signal })).events[0]?.seq
      if (nextSeq !== undefined && nextSeq !== copiedTo) return { status: 'unsupported', reason: 'source' }
      return { status: nextSeq === undefined ? 'imported' : 'available' }
    } catch (error) {
      this.stopping.signal.throwIfAborted()
      return { status: 'unsupported', reason: 'source' }
    } finally { await handle?.close() }
  }

  /** Verify selected sources and freeze their prefixes before saving any import admission.
   * @param projectId - current bound workspace.
   * @param sessionIds - distinct sources selected from the preview.
   * @returns durable job state; copying continues asynchronously.
   */
  async start(projectId: ProjectId, sessionIds: readonly SessionId[]): Promise<ImportTask> {
    this.assertOpen()
    if (sessionIds.length === 0 || new Set(sessionIds).size !== sessionIds.length) throw new MemoryError('config', 'Import needs distinct selected sessions')
    const sources: ImportSource[] = []
    for (const sessionId of sessionIds) {
      let snapshot
      try { snapshot = await this.source.stat(sessionId, { signal: this.stopping.signal }) } catch (error) {
        this.stopping.signal.throwIfAborted()
        sources.push({ sessionId, targetTo: 0, failure: 'source' }); continue
      }
      if (snapshot === undefined) { sources.push({ sessionId, targetTo: 0, failure: 'source' }); continue }
      if (await this.resolveProject(snapshot.header) !== projectId) throw new MemoryError('source', 'Selected historical source is outside this workspace')
      if (snapshot.header.version !== SESSION_FORMAT_VERSION || snapshot.formatStatus === 'migration-required') {
        sources.push({ sessionId, targetTo: 0, failure: 'schema' }); continue
      }
      let targetTo = snapshot.eventCount
      if (targetTo === undefined) {
        let handle: SessionHandle | undefined
        try {
          handle = await this.source.open(sessionId, 'read', { signal: this.stopping.signal })
          await this.verify(handle, projectId)
          targetTo = 0
          // ponytail: source APIs have no byte-bounded read; one event bounds our retained slice.
          while ((await handle.read(targetTo, 1, { signal: this.stopping.signal })).events.length > 0) targetTo++
        } catch (error) {
          this.stopping.signal.throwIfAborted()
          sources.push({ sessionId, targetTo: 0, failure: 'source' }); continue
        } finally { await handle?.close() }
      }
      sources.push({ sessionId, targetTo })
    }
    const task = await this.memory.maintenance.startImport(projectId, sources)
    this.schedule(task)
    return task
  }

  /** @param projectId - owning workspace.
   * @param id - exact operation, or omitted for the latest operation after a panel remount.
   * @returns saved state or null.
   */
  status(projectId: ProjectId, id?: OperationId): Promise<ImportTask | null> {
    return id === undefined ? this.memory.maintenance.latestImport(projectId) : this.memory.maintenance.getImport(projectId, id)
  }

  /** @param projectId - owning workspace.
   * @param id - import to cancel.
   * @returns persisted cancellation; an already dispatched append may still commit before stopping.
   */
  cancel(projectId: ProjectId, id: OperationId): Promise<ImportTask> { return this.memory.maintenance.cancelImport(projectId, id) }

  /** Recover previously accepted imports once the project database is open.
   * @param projectId - registered workspace.
   * @returns completion of scheduling; copying is observed with status/flush.
   */
  async resume(projectId: ProjectId): Promise<void> {
    this.assertOpen()
    for (const task of await this.memory.maintenance.listImports(projectId)) this.schedule(task)
  }

  /** @returns completion of all work scheduled before this barrier. */
  flush(): Promise<void> { return this.tail }

  /** Stop new pages and await owned reads/appends; durable pending work remains resumable.
   * @returns quiescent completion before the database closes.
   */
  async close(): Promise<void> { this.closing = true; this.stopping.abort(); await this.tail }

  private assertOpen(): void { if (this.closing) throw new MemoryError('closed', 'History importer is closing') }

  private schedule(task: ImportTask): void {
    if (task.status === 'done' || task.status === 'cancelled' || this.active.has(task.id) || this.closing) return
    this.active.add(task.id)
    const work = this.tail.then(() => this.run(task)).catch(error => {
      this.report(new MemoryError('storage', 'Historical import stopped; durable progress remains available', error))
    }).finally(() => this.active.delete(task.id))
    this.tail = work
  }

  private async verify(handle: SessionHandle, projectId: ProjectId): Promise<void> {
    if (handle.header.version !== SESSION_FORMAT_VERSION || await this.resolveProject(handle.header) !== projectId) throw new MemoryError('source', 'Historical source ownership or format changed')
  }

  private async run(original: ImportTask): Promise<void> {
    for (const source of original.items) {
      if (this.closing) return
      let task = await this.memory.maintenance.getImport(original.projectId, original.id)
      if (task === null || task.status === 'cancelled' || task.status === 'done') return
      let item = task.items.find(candidate => candidate.sessionId === source.sessionId)!
      if (item.status === 'done' || item.status === 'failed') continue
      let handle: SessionHandle | undefined
      try {
        try { handle = await this.source.open(item.sessionId, 'read', { signal: this.stopping.signal }) } catch (error) {
          if (this.closing) return
          throw new MemoryError('source', 'Historical source could not be opened', error)
        }
        await this.verify(handle, task.projectId)
        const registration = await this.memory.appendRaw({ projectId: task.projectId, header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: [] })
        const confirmedTo = Math.min(item.targetTo, registration.committedTo)
        if (confirmedTo > item.committedTo) {
          task = await this.memory.maintenance.checkpointImport(task.projectId, task.id, item.sessionId,
            confirmedTo, confirmedTo >= item.targetTo ? 'done' : 'running')
          item = task.items.find(candidate => candidate.sessionId === item.sessionId)!
          if (this.autoLearning) this.committed(task.projectId)
        }
        while (item.committedTo < item.targetTo && !this.closing) {
          task = await this.memory.maintenance.getImport(original.projectId, original.id)
          if (task === null || task.status === 'cancelled') return
          const events = []
          let bytes = 0
          let cursor = item.committedTo
          while (cursor < item.targetTo && events.length < this.pageSize) {
            let next
            try { next = (await handle.read(cursor, 1, { signal: this.stopping.signal })).events[0] } catch (error) {
              if (this.closing) return
              throw new MemoryError('source', 'Historical source could not be read', error)
            }
            if (next === undefined || next.seq !== cursor) throw new MemoryError('gap', 'Historical source no longer has its selected prefix')
            const size = Buffer.byteLength(JSON.stringify(next), 'utf8')
            if (events.length > 0 && bytes + size > this.pageBytes) break
            events.push(next); bytes += size; cursor++
            if (bytes >= this.pageBytes) break
          }
          if (this.closing) return
          const result = await this.memory.appendRaw({ projectId: task.projectId, header: handle.header,
            inheritedEventCount: handle.inheritedEventCount, events })
          task = await this.memory.maintenance.checkpointImport(task.projectId, task.id, item.sessionId,
            Math.min(item.targetTo, result.committedTo), result.committedTo >= item.targetTo ? 'done' : 'running')
          item = task.items.find(candidate => candidate.sessionId === item.sessionId)!
          if (this.autoLearning) this.committed(task.projectId)
        }
        if (!this.closing && item.status !== 'done') {
          await this.memory.maintenance.checkpointImport(task.projectId, task.id, item.sessionId, item.targetTo, 'done')
          if (this.autoLearning) this.committed(task.projectId)
        }
      } catch (error) {
        if (this.closing) return
        // Unknown storage outcomes stay resumable rather than being reissued in this run.
        if (!(error instanceof MemoryError) || error.code === 'storage' || error.code === 'closed' || error.code === 'unknown-outcome') throw error
        await this.memory.maintenance.checkpointImport(original.projectId, original.id, item.sessionId, item.committedTo, 'failed', error.code)
      } finally { await handle?.close() }
    }
  }
}
