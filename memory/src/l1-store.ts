/** SQLite-owned L1 scans, leased tasks, candidate checkpoints and immutable versions. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { l1Key } from './l1-config.ts'
import { integer, json, object, parseCandidate, storedReason, storedSpec, textValue } from './l1-validation.ts'
import type { EventRef, L1Candidate, L1Failure, L1Memory, L1Spec, L1Task, L1TaskStatus, MemoryId, MemoryRef, OperationId } from './l1-types.ts'

/** Version-2 tables; called only inside the owning schema migration transaction. */
export const L1_SCHEMA = `
CREATE TABLE l1_scans (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  cursor INTEGER NOT NULL, open_turn INTEGER, open_from INTEGER
) STRICT;
CREATE TABLE l1_tasks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, turn INTEGER NOT NULL, reason TEXT NOT NULL,
  config TEXT NOT NULL, memory_id TEXT NOT NULL, expected_revision INTEGER,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER NOT NULL DEFAULT 0,
  failure TEXT, candidate TEXT, lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT
) STRICT;
CREATE INDEX l1_tasks_due ON l1_tasks(project, status, next_retry_at);
CREATE TABLE l1_memories (
  id TEXT NOT NULL, revision INTEGER NOT NULL, project TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES l1_tasks(id), summary TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(id, revision)
) STRICT;`

function taskRefs(task: Pick<L1Task, 'sessionId' | 'from' | 'to'>): (ref: EventRef) => boolean {
  return ref => ref.sessionId === task.sessionId && ref.seq >= task.from && ref.seq < task.to
}

function decodeTask(value: unknown): L1Task {
  const row = object(value)
  const from = SessionLogOffset(integer(row.from_seq))
  const to = SessionLogOffset(integer(row.to_seq))
  if (from >= to) throw new MemoryError('corrupt', 'L1 task source interval is empty')
  const sessionId = SessionId(textValue(row.session_id))
  const reason = storedReason(json(row.reason))
  const status = textValue(row.status)
  if (!['pending', 'running', 'prepared', 'retry', 'failed', 'done', 'empty'].includes(status)) throw new MemoryError('corrupt', 'L1 task status is invalid')
  const failure = row.failure === null ? null : object(json(row.failure))
  if (failure !== null && typeof failure.retryable !== 'boolean') throw new MemoryError('corrupt', 'L1 retry classification is invalid')
  return {
    operationId: textValue(row.id) as OperationId, memoryId: textValue(row.memory_id) as MemoryId,
    projectId: textValue(row.project) as ProjectId, sessionId, from, to, turn: integer(row.turn), reason,
    config: storedSpec(json(row.config)), expectedRevision: row.expected_revision === null ? null : integer(row.expected_revision),
    status: status as L1TaskStatus, attempts: integer(row.attempts), calls: integer(row.calls), nextRetryAt: integer(row.next_retry_at),
    failure: failure === null ? null : { code: textValue(failure.code), retryable: failure.retryable === true },
    candidate: row.candidate === null ? null : parseCandidate(json(row.candidate), taskRefs({ sessionId, from, to }), reason),
    leaseUntil: integer(row.lease_until),
  }
}

/** Owns no connection lifetime; the parent provider closes SQLite after all workers stop. */
export class L1Store {
  /**
   * @param db - the parent provider's version-2 connection.
   * @param changed - nonthrowing post-commit notification.
   * @param assertOpen - parent-owned lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void, private readonly changed: () => void = () => {}) {}

  private transaction<T>(run: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try { result = run(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.changed()
    return result
  }

  /**
   * Read a scan checkpoint, creating no state and exposing no other project.
   * @param project - owning project.
   * @param session - source identity.
   * @returns next event position, or zero for a new scan.
   */
  cursor(project: ProjectId, session: SessionId): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT s.cursor FROM l1_scans s JOIN sessions r ON r.id = s.session_id WHERE r.project = ? AND s.session_id = ?').get(project, session)
    return row === undefined ? 0 : integer(row.cursor)
  }

  /**
   * Atomically advance the scan and enqueue only complete, committed turns.
   * @param project - owning project.
   * @param session - source Session.
   * @param config - immutable extraction configuration.
   * @param events - contiguous decoded L0 page beginning at the scan cursor.
   * @returns number of newly enqueued tasks.
   */
  scanPage(project: ProjectId, session: SessionId, config: L1Spec, events: readonly SessionEvent[]): number {
    if (events.length === 0) return 0
    return this.transaction(() => {
      const source = this.db.prepare('SELECT project, committed_to, inherited_count FROM sessions WHERE id = ?').get(session)
      if (source === undefined || source.project !== project) throw new MemoryError('source', 'L1 source Session is unavailable')
      const checkpoint = this.db.prepare('SELECT * FROM l1_scans WHERE session_id = ?').get(session)
      let cursor = checkpoint === undefined ? 0 : integer(checkpoint.cursor)
      let turn = checkpoint === undefined || checkpoint.open_turn === null ? null : integer(checkpoint.open_turn)
      let start = checkpoint === undefined || checkpoint.open_from === null ? null : integer(checkpoint.open_from)
      let inserted = 0
      if ((turn === null) !== (start === null)) throw new MemoryError('corrupt', 'L1 incomplete scan checkpoint')
      for (const event of events) {
        if (event.seq !== cursor || event.seq >= integer(source.committed_to)) throw new MemoryError('gap', 'L1 scan requires a complete committed L0 page')
        if (event.type === 'turn/start') {
          if (turn !== null) throw new MemoryError('source', 'L1 overlapping turns')
          turn = event.data.turn
          start = event.seq
        } else if (event.type === 'turn/end') {
          if (turn !== event.data.turn || start === null) throw new MemoryError('source', 'L1 end event has no matching turn start')
          if (event.seq >= integer(source.inherited_count)) {
            const memoryId = l1Key('L1', project, session, start, cursor + 1) as MemoryId
            const id = l1Key(memoryId, config) as OperationId
            const revision = this.currentRevision(project, memoryId)
            inserted += Number(this.db.prepare(`INSERT OR IGNORE INTO l1_tasks
              (id, project, session_id, from_seq, to_seq, turn, reason, config, memory_id, expected_revision, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, project, session, start, cursor + 1, turn, JSON.stringify(event.data.reason), JSON.stringify(config), memoryId, revision).changes)
          }
          turn = null
          start = null
        }
        cursor++
      }
      this.db.prepare(`INSERT INTO l1_scans VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET cursor = excluded.cursor, open_turn = excluded.open_turn, open_from = excluded.open_from`).run(session, cursor, turn, start)
      return inserted
    })
  }

  /**
   * Read an operation scoped to its project.
   * @param project - owning project.
   * @param operation - stable operation id.
   * @returns durable task or null when invisible.
   */
  getTask(project: ProjectId, operation: OperationId): L1Task | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM l1_tasks WHERE project = ? AND id = ?').get(project, operation)
    return row === undefined ? null : decodeTask(row)
  }

  /**
   * Page tasks by stable operation identity, including failures and empty results.
   * @param project - owning project.
   * @param after - exclusive previous operation id; empty string starts the page.
   * @param limit - positive page size.
   * @returns ordered tasks, at most limit entries.
   */
  listTasks(project: ProjectId, after: string, limit: number): L1Task[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'L1 task page limit must be positive')
    return this.db.prepare('SELECT * FROM l1_tasks WHERE project = ? AND id > ? ORDER BY id LIMIT ?').all(project, after, limit).map(decodeTask)
  }

  /**
   * Locate the next pending retry or expired lease without claiming it.
   * @param project - owning project.
   * @param session - available writable source Session.
   * @returns operation and earliest eligible time, or null when no work remains.
   */
  nextDue(project: ProjectId, session: SessionId): { operationId: OperationId; at: number } | null {
    this.assertOpen()
    const row = this.db.prepare(`SELECT id, CASE WHEN status IN ('running', 'prepared') THEN lease_until ELSE next_retry_at END AS due
      FROM l1_tasks WHERE project = ? AND session_id = ? AND status IN ('pending', 'retry', 'running', 'prepared') ORDER BY due, id LIMIT 1`).get(project, session)
    return row === undefined ? null : { operationId: textValue(row.id) as OperationId, at: integer(row.due) }
  }

  /**
   * Claim one due task for a writable Session; expired work can be recovered.
   * @param project - owning project.
   * @param session - available source Session.
   * @param owner - unique worker incarnation.
   * @param now - current epoch milliseconds.
   * @returns leased task or null when none is due.
   */
  claim(project: ProjectId, session: SessionId, owner: string, now: number): L1Task | null {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM l1_tasks WHERE project = ? AND session_id = ? AND
        ((status IN ('pending', 'retry') AND next_retry_at <= ?) OR (status IN ('running', 'prepared') AND lease_until <= ?))
        ORDER BY from_seq, id`).all(project, session, now, now)
      for (const row of rows) {
        const task = decodeTask(row)
        if (task.attempts >= task.config.maxAttempts) {
          this.db.prepare("UPDATE l1_tasks SET status = 'failed', owner = NULL, lease_until = 0, failure = ? WHERE id = ?").run(JSON.stringify({ code: 'ATTEMPTS_EXHAUSTED', retryable: false }), task.operationId)
          continue
        }
        const lease = now + task.config.timeoutMs * task.config.maxCalls + task.config.retryMaxMs
        this.db.prepare("UPDATE l1_tasks SET status = 'running', attempts = attempts + 1, owner = ?, lease_until = ? WHERE id = ?").run(owner, lease, task.operationId)
        return this.getTask(project, task.operationId)
      }
      return null
    })
  }

  private owned(project: ProjectId, operation: OperationId, owner: string): L1Task {
    const row = this.db.prepare('SELECT * FROM l1_tasks WHERE project = ? AND id = ? AND owner = ?').get(project, operation, owner)
    if (row === undefined || (row.status !== 'running' && row.status !== 'prepared')) throw new MemoryError('conflict', 'L1 task lease is no longer owned')
    return decodeTask(row)
  }

  /**
   * Charge a dispatch durably before model I/O, including across restarts and retries.
   * @param project - owning project.
   * @param operation - claimed extraction.
   * @param owner - worker incarnation.
   */
  reserveCall(project: ProjectId, operation: OperationId, owner: string): void {
    this.transaction(() => {
      const task = this.owned(project, operation, owner)
      if (task.calls >= task.config.maxCalls) throw new MemoryError('budget', 'L1 task exhausted its durable model-call budget; explicit re-extraction is required')
      this.db.prepare('UPDATE l1_tasks SET calls = calls + 1 WHERE id = ?').run(operation)
    })
  }

  /**
   * Persist a fully validated candidate before the final memory transaction.
   * @param project - owning project.
   * @param operation - claimed task.
   * @param owner - worker incarnation.
   * @param candidate - complete extractor result.
   */
  prepare(project: ProjectId, operation: OperationId, owner: string, candidate: L1Candidate): void {
    this.transaction(() => {
      const task = this.owned(project, operation, owner)
      const valid = parseCandidate(candidate, taskRefs(task), task.reason)
      if (task.candidate !== null && !isDeepStrictEqual(task.candidate, valid)) throw new MemoryError('conflict', 'L1 operation already has another candidate')
      this.db.prepare("UPDATE l1_tasks SET candidate = ?, status = 'prepared' WHERE id = ?").run(JSON.stringify(valid), operation)
    })
  }

  /**
   * Commit the saved candidate and completion together; query this operation after uncertainty.
   * @param project - owning project.
   * @param operation - stable operation id.
   * @param owner - worker holding the lease.
   * @param now - commit timestamp.
   * @returns committed memory or null for an empty turn; repeated commits are idempotent.
   */
  commitMemory(project: ProjectId, operation: OperationId, owner: string, now: number): L1Memory | null {
    return this.transaction(() => {
      const existing = this.byOperation(project, operation)
      if (existing !== null) return existing
      if (this.getTask(project, operation)?.status === 'empty') return null
      const task = this.owned(project, operation, owner)
      if (task.candidate === null) throw new MemoryError('conflict', 'L1 task has no prepared candidate')
      if (task.candidate.kind === 'memory') {
        const current = this.currentRevision(project, task.memoryId)
        if (current !== task.expectedRevision) throw new MemoryError('conflict', 'L1 memory revision changed')
        this.db.prepare('INSERT INTO l1_memories VALUES (?, ?, ?, ?, ?, ?)').run(task.memoryId, (current ?? 0) + 1, project, operation, JSON.stringify(task.candidate.summary), now)
      }
      this.db.prepare('UPDATE l1_tasks SET status = ?, owner = NULL, lease_until = 0, failure = NULL WHERE id = ?').run(task.candidate.kind === 'empty' ? 'empty' : 'done', operation)
      return this.byOperation(project, operation)
    })
  }

  /**
   * Release work after failure or cancellation without discarding a prepared result.
   * @param project - owning project.
   * @param operation - leased operation.
   * @param owner - worker incarnation.
   * @param failure - classified body-free error; null means cancellation.
   * @param now - current epoch milliseconds.
   */
  fail(project: ProjectId, operation: OperationId, owner: string, failure: L1Failure | null, now: number): void {
    this.transaction(() => {
      const task = this.owned(project, operation, owner)
      const retry = failure === null || (failure.retryable && task.attempts < task.config.maxAttempts)
      const delay = failure === null ? 0 : Math.min(task.config.retryMaxMs, task.config.retryBaseMs * 2 ** Math.min(30, task.attempts - 1))
      this.db.prepare('UPDATE l1_tasks SET status = ?, attempts = ?, next_retry_at = ?, failure = ?, owner = NULL, lease_until = 0 WHERE id = ?').run(
        retry ? 'retry' : 'failed', failure === null ? Math.max(0, task.attempts - 1) : task.attempts, now + delay,
        failure === null ? null : JSON.stringify(failure), operation,
      )
    })
  }

  /**
   * Requeue a failed task or create a new extraction with an expected current version.
   * @param project - owning project.
   * @param operation - original task.
   * @param mode - retry preserves candidate/id; reextract creates a fresh operation.
   * @param config - explicit resolved settings for a fresh extraction.
   * @returns operation to inspect or process next.
   */
  rerun(project: ProjectId, operation: OperationId, mode: 'retry' | 'reextract', config: L1Spec): OperationId {
    return this.transaction(() => {
      const task = this.getTask(project, operation)
      if (task === null) throw new MemoryError('source', 'L1 task is unavailable')
      if (task.status === 'running' || task.status === 'prepared') throw new MemoryError('conflict', 'L1 task is still leased')
      if (mode === 'retry') {
        if (task.status !== 'failed' && task.status !== 'retry') throw new MemoryError('conflict', 'L1 retry requires a failed or deferred task')
        this.db.prepare("UPDATE l1_tasks SET status = 'pending', attempts = 0, next_retry_at = 0, failure = NULL WHERE id = ?").run(operation)
        return operation
      }
      const id = randomUUID() as OperationId
      this.db.prepare(`INSERT INTO l1_tasks (id, project, session_id, from_seq, to_seq, turn, reason, config, memory_id, expected_revision, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, project, task.sessionId, task.from, task.to, task.turn, JSON.stringify(task.reason), JSON.stringify(config), task.memoryId, this.currentRevision(project, task.memoryId))
      return id
    })
  }

  private currentRevision(project: ProjectId, id: MemoryId): number | null {
    const value = this.db.prepare('SELECT MAX(revision) AS revision FROM l1_memories WHERE project = ? AND id = ?').get(project, id)?.revision
    return value === null ? null : integer(value)
  }

  /**
   * Look up a committed operation before repeating an uncertain commit.
   * @param project - owning project.
   * @param operation - stable operation id.
   * @returns exact committed version or null.
   */
  byOperation(project: ProjectId, operation: OperationId): L1Memory | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT id, revision FROM l1_memories WHERE project = ? AND operation_id = ?').get(project, operation)
    return row === undefined ? null : this.getMemory(project, { id: textValue(row.id) as MemoryId, revision: integer(row.revision) })
  }

  /**
   * Read a concrete version without exposing another project's content.
   * @param project - owning project.
   * @param ref - exact memory identity and version.
   * @returns historical or active memory, or null when invisible.
   */
  getMemory(project: ProjectId, ref: MemoryRef): L1Memory | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM l1_memories WHERE project = ? AND id = ? AND revision = ?').get(project, ref.id, ref.revision)
    if (row === undefined) return null
    const task = this.getTask(project, textValue(row.operation_id) as OperationId)
    if (task === null || task.memoryId !== ref.id || task.status !== 'done') throw new MemoryError('corrupt', 'L1 memory has no matching completed task')
    const candidate = parseCandidate({ kind: 'memory', summary: json(row.summary) }, taskRefs(task), task.reason)
    if (candidate.kind !== 'memory') throw new MemoryError('corrupt', 'L1 memory has no summary')
    return { ...ref, projectId: project, operationId: task.operationId, level: 'L1', sessionId: task.sessionId,
      turn: task.turn, reason: task.reason, range: { from: task.from, to: task.to }, config: task.config,
      summary: candidate.summary, createdAt: integer(row.created_at), state: this.currentRevision(project, ref.id) === ref.revision ? 'active' : 'superseded' }
  }
}
