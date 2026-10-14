/** Durable historical imports and whole-session retention on the owning SQLite connection. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { MemoryRef, OperationId } from './l1-types.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'

/** Version-6 tables; the parent commits these with the physical schema upgrade. */
export const MAINTENANCE_SCHEMA = `
CREATE TABLE memory_imports (id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL) STRICT;
CREATE TABLE memory_admissions (session_id TEXT PRIMARY KEY, project TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('admitted','cleaned'))) STRICT;
CREATE TABLE memory_cleanup_runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL) STRICT;
CREATE INDEX memory_import_projects ON memory_imports(project);
`

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const selectionReferences = z.array(z.object({ id: z.string().refine(value => value.trim().length > 0), revision: safeInteger.positive() }))
const importItemSchema = z.object({ sessionId: z.string().min(1), targetTo: safeInteger, committedTo: safeInteger,
  status: z.enum(['pending', 'running', 'done', 'failed']), failure: z.string().nullable() })
const importTaskSchema = z.object({ id: z.string().min(1), projectId: z.string().min(1),
  status: z.enum(['pending', 'running', 'done', 'cancelled']), createdAt: safeInteger, items: z.array(importItemSchema) })

/** One exact import prefix; failures remain visible while the other sources continue. */
export interface ImportItem {
  readonly sessionId: SessionId
  readonly targetTo: number
  readonly committedTo: number
  readonly status: 'pending' | 'running' | 'done' | 'failed'
  readonly failure: string | null
}
/** Import identity, durable progress, and cancellation state. */
export interface ImportTask {
  readonly id: OperationId
  readonly projectId: ProjectId
  readonly status: 'pending' | 'running' | 'done' | 'cancelled'
  readonly createdAt: number
  readonly items: readonly ImportItem[]
}
/** Session metadata is frozen by the importer before starting a task. */
export interface ImportSource {
  readonly sessionId: SessionId
  readonly targetTo: number
  /** Unavailable sources have no admission and a zero target. */
  readonly failure?: 'source' | 'schema' | 'conflict'
}
/** Retention is opt-in; callers supply a fresh active-session snapshot on each execution. */
export interface CleanupRequest {
  readonly maxAgeDays: number
  readonly now?: number
  readonly activeSessionIds?: readonly SessionId[]
}
/** Estimates exclude sessions whose sources still support a retained record or task. */
export interface CleanupPreview {
  readonly cutoff: number
  readonly eligibleSessions: number
  readonly protectedSessions: number
  readonly eventCount: number
  readonly bytes: number
  readonly protectedEventCount: number
  readonly protectedBytes: number
}
/** The last committed cleanup result, including its stable operation identity. */
export interface CleanupResult extends CleanupPreview {
  readonly id: OperationId
  readonly status: 'done'
  readonly deletedSessions: number
  readonly completedAt: number
}

function decodedTask(body: unknown): ImportTask {
  if (typeof body !== 'string') throw new MemoryError('corrupt', 'Invalid stored import body')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (error) {
    throw new MemoryError('corrupt', 'Invalid stored import JSON', error instanceof SyntaxError ? undefined : error)
  }
  const task = importTaskSchema.safeParse(parsed)
  if (!task.success) throw new MemoryError('corrupt', 'Invalid stored import progress')
  return { ...task.data, id: task.data.id as OperationId, projectId: task.data.projectId as ProjectId,
    items: task.data.items.map(item => ({ ...item, sessionId: SessionId(item.sessionId) })) }
}

function storedObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') throw new MemoryError('corrupt', 'Invalid maintenance source JSON')
  let result: unknown
  try { result = JSON.parse(body) } catch (error) {
    throw new MemoryError('corrupt', 'Invalid maintenance source JSON', error instanceof SyntaxError ? undefined : error)
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new MemoryError('corrupt', 'Invalid maintenance source fields')
  return result as Record<string, unknown>
}

/** Collect only program-owned references, including candidate/conflict ancestry. */
function references(value: unknown, memories: Map<string, MemoryRef>, sessions: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) references(item, memories, sessions); return }
  if (value === null || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  if (typeof item.sessionId === 'string' && typeof item.seq === 'number') sessions.add(item.sessionId)
  if (typeof item.id === 'string' && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0) {
    memories.set(JSON.stringify([item.id, item.revision]), { id: item.id as MemoryRef['id'], revision: item.revision })
  }
  for (const child of Object.values(item)) references(child, memories, sessions)
}

/** Shares the parent connection and lifetime; worker RPC exposes these methods asynchronously. */
export class MaintenanceStore {
  private readonly activeSources = new Map<ProjectId, Set<string>>()
  /** @param db - owning connection.
   * @param assertOpen - lifetime guard.
   * @param changed - committed-library notification; must not throw.
   */
  constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void, private readonly changed: () => void = () => {}) {}

  private transaction<T>(run: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /** Admit exact source prefixes and persist a new resumable import.
   * @param projectId - authoritative workspace owner.
   * @param sources - verified, duplicate-free Session prefixes.
   * @returns committed task, before any copying starts.
   */
  startImport(projectId: ProjectId, sources: readonly ImportSource[]): ImportTask {
    return this.transaction(() => {
      if (sources.length === 0 || new Set(sources.map(item => item.sessionId)).size !== sources.length) throw new MemoryError('config', 'Import needs distinct selected sessions')
      const items = sources.map(source => {
        if (!Number.isSafeInteger(source.targetTo) || source.targetTo < 0) throw new MemoryError('config', 'Invalid import target prefix')
        if (source.failure !== undefined && (!['source', 'schema', 'conflict'].includes(source.failure) || source.targetTo !== 0)) throw new MemoryError('config', 'Invalid failed import source')
        const owner = this.db.prepare('SELECT project,committed_to FROM sessions WHERE id = ?').get(source.sessionId)
        const admission = this.db.prepare('SELECT project FROM memory_admissions WHERE session_id = ?').get(source.sessionId)
        if ((owner !== undefined && owner.project !== projectId) || (admission !== undefined && admission.project !== projectId)) throw new MemoryError('conflict', 'Historical session belongs to another project')
        if (source.failure !== undefined) return { sessionId: source.sessionId, targetTo: 0, committedTo: 0, status: 'failed' as const, failure: source.failure }
        this.db.prepare(`INSERT INTO memory_admissions VALUES (?,?,'admitted') ON CONFLICT(session_id) DO UPDATE SET status='admitted'`).run(source.sessionId, projectId)
        const committedTo = Math.min(source.targetTo, owner === undefined ? 0 : Number(owner.committed_to))
        // Every explicit import validates metadata through appendRaw, including already-copied and empty prefixes.
        return { sessionId: source.sessionId, targetTo: source.targetTo, committedTo, status: 'pending' as const, failure: null }
      })
      const task: ImportTask = { id: randomUUID() as OperationId, projectId, createdAt: Date.now(),
        status: items.every(item => item.status === 'failed') ? 'done' : 'pending', items }
      this.db.prepare('INSERT INTO memory_imports VALUES (?,?,?)').run(task.id, projectId, JSON.stringify(task))
      return task
    })
  }

  /** @param projectId - requesting owner.
   * @param id - import operation.
   * @returns saved task or null without exposing other projects.
   */
  getImport(projectId: ProjectId, id: OperationId): ImportTask | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT body FROM memory_imports WHERE project=? AND id=?').get(projectId, id)
    return row === undefined ? null : decodedTask(row.body)
  }

  /** @param projectId - requesting owner.
   * @returns most recently created import, including cancelled and completed operations.
   */
  latestImport(projectId: ProjectId): ImportTask | null {
    this.assertOpen()
    const row = this.db.prepare(`SELECT body FROM memory_imports WHERE project=? ORDER BY json_extract(body,'$.createdAt') DESC,rowid DESC LIMIT 1`).get(projectId)
    return row === undefined ? null : decodedTask(row.body)
  }

  /** @param projectId - owning workspace.
   * @returns nonterminal tasks requiring startup recovery.
   */
  listImports(projectId: ProjectId): ImportTask[] {
    this.assertOpen()
    return this.db.prepare(`SELECT body FROM memory_imports WHERE project=? AND json_extract(body,'$.status') IN ('pending','running') ORDER BY id`).all(projectId).map(row => decodedTask(row.body))
  }

  /** Cancellation keeps committed events and admission; it never rewinds an append.
   * @param projectId - owning workspace.
   * @param id - operation to cancel.
   * @returns committed task state.
   */
  cancelImport(projectId: ProjectId, id: OperationId): ImportTask {
    return this.transaction(() => {
      const task = this.getImport(projectId, id)
      if (task === null) throw new MemoryError('source', 'Import operation is unavailable')
      const saved: ImportTask = task.status === 'done' ? task : { ...task, status: 'cancelled' }
      this.db.prepare('UPDATE memory_imports SET body=? WHERE id=? AND project=?').run(JSON.stringify(saved), id, projectId)
      return saved
    })
  }

  /** Record a prefix only after appendRaw resolves; cancellation cannot be overwritten.
   * @param projectId - owning workspace.
   * @param id - operation identity.
   * @param sessionId - selected source.
   * @param committedTo - acknowledged durable prefix.
   * @param status - source result.
   * @param failure - body-free failure category.
   * @returns updated task.
   */
  checkpointImport(projectId: ProjectId, id: OperationId, sessionId: SessionId, committedTo: number,
    status: ImportItem['status'] = 'running', failure: string | null = null): ImportTask {
    return this.transaction(() => {
      const task = this.getImport(projectId, id)
      if (task === null) throw new MemoryError('source', 'Import operation is unavailable')
      const source = task.items.find(item => item.sessionId === sessionId)
      if (source === undefined || !Number.isSafeInteger(committedTo) || committedTo < source.committedTo || committedTo > source.targetTo) throw new MemoryError('conflict', 'Invalid import progress')
      const row = this.db.prepare('SELECT committed_to FROM sessions WHERE id=? AND project=?').get(sessionId, projectId)
      if (committedTo > Number(row?.committed_to ?? 0)) throw new MemoryError('conflict', 'Import checkpoint exceeds stored prefix')
      const items = task.items.map(item => item.sessionId === sessionId ? { ...item, committedTo, status, failure } : item)
      const saved: ImportTask = { ...task, items, status: task.status === 'cancelled' ? 'cancelled'
        : items.every(item => item.status === 'done' || item.status === 'failed') ? 'done' : 'running' }
      this.db.prepare('UPDATE memory_imports SET body=? WHERE id=? AND project=?').run(JSON.stringify(saved), id, projectId)
      return saved
    })
  }

  /** @param projectId - authoritative owner.
   * @param sessionId - source identity.
   * @returns whether explicit historical import bypasses activation-time filtering.
   */
  admitted(projectId: ProjectId, sessionId: SessionId): boolean {
    this.assertOpen()
    return this.db.prepare(`SELECT 1 FROM memory_admissions WHERE session_id=? AND project=? AND status='admitted'`).get(sessionId, projectId) !== undefined
  }

  /** @param projectId - authoritative owner.
   * @param sessionId - canonical source identity.
   * @returns captured prefix, or null when this project has no source metadata.
   */
  copiedPrefix(projectId: ProjectId, sessionId: SessionId): number | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT committed_to FROM sessions WHERE id=? AND project=?').get(sessionId, projectId)
    return row === undefined ? null : Number(row.committed_to)
  }

  /** Startup snapshot includes cleanup exclusions as well as explicit historical admission.
   * @param projectId - authoritative owner.
   * @returns stored source decisions in identity order.
   */
  listAdmissions(projectId: ProjectId): Array<{ sessionId: SessionId; status: 'admitted' | 'cleaned' }> {
    this.assertOpen()
    return this.db.prepare('SELECT session_id,status FROM memory_admissions WHERE project=? ORDER BY session_id').all(projectId).map(row => {
      if (row.status !== 'admitted' && row.status !== 'cleaned') throw new MemoryError('corrupt', 'Invalid stored source admission')
      return { sessionId: SessionId(String(row.session_id)), status: row.status }
    })
  }

  /** Worker-local registrations linearize adoption before a queued cleanup operation.
   * @param projectId - source owner.
   * @param sessionId - active Session identity.
   * @param active - true before capture/adoption, false after its retirement flush.
   */
  setActive(projectId: ProjectId, sessionId: SessionId, active: boolean): void {
    this.assertOpen()
    const sessions = this.activeSources.get(projectId) ?? new Set<string>()
    if (active) { sessions.add(sessionId); this.activeSources.set(projectId, sessions) }
    else { sessions.delete(sessionId); if (sessions.size === 0) this.activeSources.delete(projectId) }
  }

  /** @param projectId - authoritative owner.
   * @param sessionId - source identity.
   * @returns whether automatic recovery must leave this deliberately cleaned source absent.
   */
  tombstoned(projectId: ProjectId, sessionId: SessionId): boolean {
    this.assertOpen()
    return this.db.prepare(`SELECT 1 FROM memory_admissions WHERE session_id=? AND project=? AND status='cleaned'`).get(sessionId, projectId) !== undefined
  }

  private protectedSessions(projectId: ProjectId, active: readonly SessionId[]): Set<string> {
    const sessions = new Set<string>([...active, ...(this.activeSources.get(projectId) ?? [])])
    const pending = new Map<string, MemoryRef>()
    const operations = new Set<string>()
    // Current knowledge is retained even when conflicted or currently unsuitable for recall.
    for (const row of this.db.prepare(`SELECT id,revision FROM knowledge_versions WHERE project=? AND state='active'
      UNION SELECT v.id,v.revision FROM knowledge_versions v JOIN knowledge_grants g ON g.id=v.id AND g.revision=v.revision WHERE v.project=?`).iterate(projectId, projectId)) {
      references({ id: String(row.id), revision: Number(row.revision) }, pending, sessions)
    }
    for (const row of this.db.prepare('SELECT session_id,refs FROM memory_selections WHERE project=?').iterate(projectId)) {
      let refs: unknown
      try { refs = JSON.parse(String(row.refs)) } catch (error) { throw new MemoryError('corrupt', 'Invalid pending memory selection', error instanceof SyntaxError ? undefined : error) }
      const selected = selectionReferences.safeParse(refs)
      if (!selected.success) throw new MemoryError('corrupt', 'Invalid pending memory selection references')
      if (selected.data.length > 0) sessions.add(String(row.session_id))
      references(selected.data, pending, sessions)
    }
    for (const row of this.db.prepare(`SELECT id,body FROM knowledge_tasks WHERE project=? AND json_extract(body,'$.status') != 'done'`).iterate(projectId)) {
      operations.add(String(row.id)); references(storedObject(row.body), pending, sessions)
    }
    for (const row of this.db.prepare(`SELECT id,session_id FROM l1_tasks WHERE project=? AND status NOT IN ('done','empty')`).iterate(projectId)) {
      sessions.add(String(row.session_id)); operations.add(String(row.id))
    }
    for (const task of this.listImports(projectId)) for (const item of task.items) if (item.status !== 'done' && item.status !== 'failed') sessions.add(item.sessionId)
    const visited = new Set<string>()
    const checkedOperations = new Set<string>()
    while (pending.size > 0 || [...operations].some(operation => !checkedOperations.has(operation))) {
      for (const operation of operations) {
        if (checkedOperations.has(operation)) continue
        checkedOperations.add(operation)
        const task = this.db.prepare('SELECT body FROM knowledge_tasks WHERE id=? AND project=?').get(operation, projectId)
        if (task !== undefined) references(storedObject(task.body), pending, sessions)
        const receipt = this.db.prepare('SELECT request,result FROM knowledge_operations WHERE id=?').get(operation)
        if (receipt !== undefined) {
          references(storedObject(receipt.request), pending, sessions)
          let result: unknown
          try { result = JSON.parse(String(receipt.result)) } catch (error) { throw new MemoryError('corrupt', 'Invalid retained operation result', error instanceof SyntaxError ? undefined : error) }
          references(result, pending, sessions)
        }
      }
      const entry = pending.entries().next().value
      if (entry === undefined) continue
      const [key, ref] = entry
      pending.delete(key)
      if (visited.has(key)) continue
      visited.add(key)
      const l1 = this.db.prepare(`SELECT p.summary,m.operation_id,t.session_id FROM l1_memories m
        JOIN l1_summary_projections p ON p.memory_id=m.id AND p.revision=m.revision
        JOIN l1_tasks t ON t.id=m.operation_id WHERE m.id=? AND m.revision=? AND m.project=?`).get(ref.id, ref.revision, projectId)
      if (l1 !== undefined) { sessions.add(String(l1.session_id)); operations.add(String(l1.operation_id)); references(storedObject(l1.summary), pending, sessions); continue }
      const knowledge = this.db.prepare('SELECT knowledge,operation_id FROM knowledge_versions WHERE id=? AND revision=? AND project=?').get(ref.id, ref.revision, projectId)
      if (knowledge === undefined) throw new MemoryError('source', 'Retained memory has missing ancestry; cleanup refused')
      operations.add(String(knowledge.operation_id))
      references(storedObject(knowledge.knowledge), pending, sessions)
    }
    // Auxiliary requests are the sole reconstructable record of each retained model call.
    for (const row of this.db.prepare(`SELECT e.session_id,json_extract(e.body,'$.data.operationId') AS operation_id
      FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.project=? AND json_extract(e.body,'$.type')='memory/extraction-request'`).iterate(projectId)) {
      if (typeof row.operation_id !== 'string') throw new MemoryError('corrupt', 'Invalid extraction journal operation')
      if (operations.has(row.operation_id)) sessions.add(String(row.session_id))
    }
    return sessions
  }

  private candidates(projectId: ProjectId, request: CleanupRequest): { preview: CleanupPreview; ids: string[] } {
    const now = request.now ?? Date.now()
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(request.maxAgeDays) || request.maxAgeDays <= 0
      || request.maxAgeDays > Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)) throw new MemoryError('config', 'Invalid retention age or clock')
    const cutoff = now - request.maxAgeDays * 86_400_000
    const protectedSources = this.protectedSessions(projectId, request.activeSessionIds ?? [])
    const preview = { cutoff, eligibleSessions: 0, protectedSessions: 0, eventCount: 0, bytes: 0, protectedEventCount: 0, protectedBytes: 0 }
    const ids: string[] = []
    for (const row of this.db.prepare(`SELECT s.id,s.committed_to,
      COALESCE((SELECT max(json_extract(body,'$.time')) FROM events WHERE session_id=s.id),json_extract(s.header,'$.createdAt')) AS last_time,
      COALESCE((SELECT sum(length(CAST(body AS BLOB))) FROM events WHERE session_id=s.id),0) AS bytes
      FROM sessions s WHERE s.project=?`).iterate(projectId)) {
      if (typeof row.last_time !== 'number' || !Number.isSafeInteger(row.last_time)) throw new MemoryError('corrupt', 'Session retention timestamp is invalid')
      if (row.last_time >= cutoff) continue
      if (protectedSources.has(String(row.id))) {
        preview.protectedSessions++; preview.protectedEventCount += Number(row.committed_to); preview.protectedBytes += Number(row.bytes)
      } else { ids.push(String(row.id)); preview.eligibleSessions++; preview.eventCount += Number(row.committed_to); preview.bytes += Number(row.bytes) }
    }
    return { preview, ids }
  }

  /** Preview exact whole-session candidates under a consistent transaction.
   * @param projectId - owning workspace.
   * @param request - age and active-session snapshot.
   * @returns estimated event bytes and protected counts; execution rechecks these facts.
   */
  cleanupPreview(projectId: ProjectId, request: CleanupRequest): CleanupPreview {
    return this.transaction(() => this.candidates(projectId, request).preview)
  }

  /** Remove only expired whole sessions with no retained ancestry, then save tombstones.
   * @param projectId - owning workspace.
   * @param request - freshly resolved age and active-session snapshot.
   * @returns transactionally committed result; rejection rolls back the entire cleanup.
   */
  cleanup(projectId: ProjectId, request: CleanupRequest): CleanupResult {
    const result = this.transaction(() => {
      const { preview, ids } = this.candidates(projectId, request)
      const removed = new Set(ids)
      const dead = new Set<string>()
      const deadOperations = new Set<string>()
      const dependsOnRemoved = (body: unknown): boolean => {
        const refs = new Map<string, MemoryRef>(); const sessions = new Set<string>()
        references(body, refs, sessions)
        return [...refs.keys()].some(ref => dead.has(ref)) || [...sessions].some(id => removed.has(id))
      }
      for (const id of ids) for (const row of this.db.prepare('SELECT m.id,m.revision FROM l1_memories m JOIN l1_tasks t ON t.id=m.operation_id WHERE t.session_id=?').iterate(id)) dead.add(JSON.stringify([row.id, row.revision]))
      // Retired knowledge can depend on other retired versions; expand deletion to avoid dangling ancestry.
      let changed = true
      while (changed) {
        changed = false
        for (const row of this.db.prepare(`SELECT id,revision,knowledge FROM knowledge_versions WHERE project=? AND state!='active'`).iterate(projectId)) {
          const key = JSON.stringify([row.id, row.revision])
          if (dead.has(key)) continue
          const refs = new Map<string, MemoryRef>(); const sessions = new Set<string>()
          references(storedObject(row.knowledge), refs, sessions)
          if ([...refs.keys()].some(ref => dead.has(ref)) || [...sessions].some(id => removed.has(id))) { dead.add(key); changed = true }
        }
        for (const row of this.db.prepare(`SELECT id,body FROM knowledge_tasks WHERE project=? AND json_extract(body,'$.status')='done'`).iterate(projectId)) {
          if (!dependsOnRemoved(storedObject(row.body))) continue
          deadOperations.add(String(row.id))
          for (const version of this.db.prepare(`SELECT id,revision FROM knowledge_versions WHERE project=? AND operation_id=?`).iterate(projectId, String(row.id))) {
            const key = JSON.stringify([version.id, version.revision])
            if (!dead.has(key)) { dead.add(key); changed = true }
          }
        }
      }
      for (const key of dead) {
        const pair: unknown = JSON.parse(key)
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'number') throw new MemoryError('corrupt', 'Invalid cleanup memory identity')
        this.db.prepare('DELETE FROM memory_vectors WHERE id=? AND revision=?').run(pair[0], pair[1])
        this.db.prepare('DELETE FROM l1_trace_chunks WHERE memory_id=? AND revision=?').run(pair[0], pair[1])
        this.db.prepare('DELETE FROM knowledge_versions WHERE id=? AND revision=? AND project=?').run(pair[0], pair[1], projectId)
      }
      for (const operation of deadOperations) {
        if (this.db.prepare('SELECT 1 FROM knowledge_versions WHERE operation_id=?').get(operation) !== undefined) throw new MemoryError('source', 'Retained memory still needs a deleted task; cleanup refused')
        this.db.prepare('DELETE FROM knowledge_tasks WHERE id=? AND project=?').run(operation, projectId)
        this.db.prepare('DELETE FROM knowledge_operations WHERE id=?').run(operation)
      }
      for (const row of this.db.prepare('SELECT id,request,result FROM knowledge_operations').iterate()) {
        const request = storedObject(row.request)
        if (request.project !== projectId && request.projectId !== projectId) continue
        let result: unknown
        try { result = JSON.parse(String(row.result)) } catch (error) { throw new MemoryError('corrupt', 'Invalid cleanup operation result', error instanceof SyntaxError ? undefined : error) }
        if (!dependsOnRemoved(request) && !dependsOnRemoved(result)) continue
        if (this.db.prepare('SELECT 1 FROM knowledge_versions WHERE operation_id=?').get(String(row.id)) !== undefined) throw new MemoryError('source', 'Retained memory still needs a deleted operation; cleanup refused')
        this.db.prepare('DELETE FROM knowledge_operations WHERE id=?').run(String(row.id))
      }
      for (const id of ids) {
        this.db.prepare('DELETE FROM l1_memories WHERE operation_id IN (SELECT id FROM l1_tasks WHERE session_id=?)').run(id)
        this.db.prepare('DELETE FROM l1_tasks WHERE session_id=?').run(id)
        this.db.prepare('DELETE FROM l1_scans WHERE session_id=?').run(id)
        this.db.prepare('DELETE FROM memory_selections WHERE session_id=?').run(id)
        this.db.prepare('DELETE FROM events WHERE session_id=?').run(id)
        this.db.prepare('DELETE FROM sessions WHERE id=? AND project=?').run(id, projectId)
        this.db.prepare(`INSERT INTO memory_admissions VALUES (?,?,'cleaned') ON CONFLICT(session_id) DO UPDATE SET status='cleaned'`).run(id, projectId)
      }
      if (ids.length > 0) this.db.prepare('UPDATE memory_generation SET generation=generation+1 WHERE singleton=1').run()
      const saved: CleanupResult = { ...preview, id: randomUUID() as OperationId, status: 'done', deletedSessions: ids.length, completedAt: request.now ?? Date.now() }
      this.db.prepare('INSERT INTO memory_cleanup_runs VALUES (?,?,?)').run(saved.id, projectId, JSON.stringify(saved))
      return saved
    })
    this.changed()
    return result
  }

  /** @param projectId - requesting workspace.
   * @returns last committed cleanup, or null before any successful run.
   */
  cleanupStatus(projectId: ProjectId): CleanupResult | null {
    this.assertOpen()
    const row = this.db.prepare(`SELECT body FROM memory_cleanup_runs WHERE project=? ORDER BY json_extract(body,'$.completedAt') DESC,rowid DESC LIMIT 1`).get(projectId)
    if (row === undefined) return null
    const value = storedObject(row.body)
    const parsed = z.object({ id: z.string().min(1), status: z.literal('done'), cutoff: z.number().finite(), eligibleSessions: safeInteger,
      protectedSessions: safeInteger, eventCount: safeInteger, bytes: safeInteger, protectedEventCount: safeInteger,
      protectedBytes: safeInteger, deletedSessions: safeInteger, completedAt: safeInteger }).safeParse(value)
    if (!parsed.success) throw new MemoryError('corrupt', 'Invalid stored cleanup result')
    return { ...parsed.data, id: parsed.data.id as OperationId }
  }

  /** Compact physical pages outside cleanup transactions; the dedicated worker owns the blocking work. */
  compact(): void { this.assertOpen(); this.db.exec('VACUUM') }
}
