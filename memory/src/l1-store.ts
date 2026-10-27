/** SQLite-owned L1 scans, leased tasks, candidate checkpoints and immutable versions. */
import { randomUUID } from 'node:crypto'
import { executionSucceeded, traceIncludes, utf8End } from './evidence.ts'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { adoptSessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { l1Key } from './l1-config.ts'
import { integer, json, object, parseCandidate, storedReason, storedSpec, textValue } from './l1-validation.ts'
import type { EventRef, L1Candidate, L1Failure, L1Memory, L1Spec, L1Task, L1TaskStatus, MemoryId, MemoryRef, OperationId, TraceCursor, TracePage } from './l1-types.ts'

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

const COMPACT_TASK_COLUMNS = `id, project, session_id, from_seq, to_seq, turn, reason, config, memory_id, expected_revision,
  status, attempts, calls, next_retry_at, failure, lease_until, owner,
  COALESCE((SELECT candidate FROM l1_candidate_projections WHERE operation_id = l1_tasks.id),
    CASE WHEN candidate IS NULL THEN NULL WHEN json_valid(candidate) THEN json_remove(candidate, '$.summary.trace') END) AS candidate,
  CASE WHEN EXISTS(SELECT 1 FROM l1_candidate_projections WHERE operation_id = l1_tasks.id) THEN 1
    ELSE (candidate IS NULL OR json_valid(candidate)) END AS candidate_valid`

interface LegacyTraceSource {
  readonly table: 'l1_memories' | 'l1_tasks'
  readonly path: '$.trace' | '$.summary.trace'
  readonly id: MemoryId | OperationId
  readonly revision?: number
}

/** Version-6 immutable trace stream; old inline JSON remains untouched. */
export const TRACE_SCHEMA = `
CREATE TABLE l1_trace_chunks (
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL, chunk_index INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(memory_id, revision, chunk_index),
  FOREIGN KEY(memory_id, revision) REFERENCES l1_memories(id, revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE l1_summary_projections (
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL, summary TEXT NOT NULL,
  PRIMARY KEY(memory_id, revision),
  FOREIGN KEY(memory_id, revision) REFERENCES l1_memories(id, revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE l1_candidate_projections (
  operation_id TEXT PRIMARY KEY REFERENCES l1_tasks(id) ON DELETE CASCADE, candidate TEXT NOT NULL
) STRICT;`

/** Version-7 audit records preserve historical summaries and the exact rule used to check them. */
export const EVIDENCE_SCHEMA = `
CREATE TABLE memory_execution_audits (
 memory_id TEXT NOT NULL, revision INTEGER NOT NULL, policy INTEGER NOT NULL CHECK(policy>0),
 status TEXT NOT NULL CHECK(status IN ('valid','invalid','unavailable')), reason TEXT,
 PRIMARY KEY(memory_id,revision,policy),
 FOREIGN KEY(memory_id,revision) REFERENCES l1_memories(id,revision) ON DELETE CASCADE
) STRICT;`

/** Current execution-evidence interpretation; older audits cannot authorize this policy. */
export const EXECUTION_POLICY = 2

function executionEvent(value: unknown, seq: number): SessionEvent {
  const event = object(json(value))
  if (event.seq !== seq || typeof event.type !== 'string' || !Number.isSafeInteger(event.time)) throw new MemoryError('corrupt', 'Invalid recorded execution event envelope')
  if (event.type === 'tool/call') {
    const data = object(event.data)
    for (const field of ['callId', 'name', 'arguments']) textValue(data[field])
  }
  try { return adoptSessionEvent(event as SessionEvent) }
  catch (error) { throw new MemoryError('corrupt', 'Invalid recorded execution event data') }
}

function taskRefs(task: Pick<L1Task, 'sessionId' | 'from' | 'to'>): (ref: EventRef) => boolean {
  return ref => ref.sessionId === task.sessionId && ref.seq >= task.from && ref.seq < task.to
}

function decodeTask(value: unknown): L1Task {
  const row = object(value)
  if (row.candidate_valid === 0) throw new MemoryError('output', 'L1 invalid JSON')
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
   * @param traceChunkBytes - maximum UTF-8 bytes per immutable trace chunk.
   * @param assertOpen - parent-owned lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void, private readonly changed: () => void = () => {},
    private readonly traceChunkBytes = 65536) {}

  /** Read the execution audit without changing immutable source content.
   * @param project - owning project. @param ref - exact L1 version.
   * @returns audit status, or pending when a historical success has not been checked.
   */
  executionAudit(project: ProjectId, ref: MemoryRef): { status: 'valid' | 'invalid' | 'unavailable' | 'pending'; reason: string | null } {
    this.assertOpen()
    const memory = this.getMemory(project, ref)
    if (memory === null) return { status: 'unavailable', reason: 'Source memory is unavailable' }
    if (memory.summary.outcome !== 'success') return { status: 'valid', reason: null }
    const row = this.db.prepare('SELECT status,reason FROM memory_execution_audits WHERE memory_id=? AND revision=? AND policy=?').get(ref.id, ref.revision, EXECUTION_POLICY)
    if (row === undefined) return { status: 'pending', reason: 'Execution evidence has not been rechecked' }
    return { status: textValue(row.status) as 'valid' | 'invalid' | 'unavailable', reason: row.reason === null ? null : textValue(row.reason) }
  }

  /** @param project - owner. @param ref - exact version. @returns whether it may support recall or derived knowledge. */
  evidenceUsable(project: ProjectId, ref: MemoryRef): boolean { return this.executionAudit(project, ref).status === 'valid' }

  private auditMemory(project: ProjectId, ref: MemoryRef): void {
    const memory = this.getMemory(project, ref)
    if (memory === null || memory.summary.outcome !== 'success') return
    let status: 'valid' | 'invalid' | 'unavailable' = 'invalid'
    let reason: string | null = 'No consistent successful execution was cited'
    try {
      const refs = memory.summary.executionEvidence ?? memory.summary.sources
      const verified = this.successfulRefs(project, memory.operationId, refs)
      if (verified.length > 0 && (memory.summary.executionEvidence === undefined || verified.length === refs.length)) { status = 'valid'; reason = null }
    } catch (error) {
      if (!(error instanceof MemoryError) || !['gap', 'source', 'corrupt', 'output'].includes(error.code)) throw error
      status = 'unavailable'; reason = 'Recorded execution evidence is unavailable or invalid'
    }
    this.db.prepare('INSERT OR REPLACE INTO memory_execution_audits VALUES (?,?,?,?,?)').run(ref.id, ref.revision, EXECUTION_POLICY, status, reason)
  }

  private checkExecution(task: L1Task, summary: L1Memory['summary']): void {
    if (summary.outcome !== 'success' && summary.executionEvidence === undefined) return
    const refs = summary.executionEvidence ?? summary.sources
    const verified = this.successfulRefs(task.projectId, task.operationId, refs)
    if (summary.outcome !== 'success' || verified.length === 0
      || (summary.executionEvidence !== undefined && verified.length !== refs.length)) {
      throw new MemoryError('output', 'Invalid program-owned execution evidence')
    }
  }

  /** Recheck one bounded page; committed rows also serve as the restart checkpoint.
   * @param limit - maximum historical success versions per transaction.
   * @returns checked count and whether another page remains.
   */
  auditEvidencePage(limit: number): { checked: number; pending: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'Evidence audit page size must be positive')
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT m.id,m.revision,m.project FROM l1_memories m
        WHERE json_extract(m.summary,'$.outcome')='success' AND NOT EXISTS
          (SELECT 1 FROM memory_execution_audits a WHERE a.memory_id=m.id AND a.revision=m.revision AND a.policy=?)
        ORDER BY m.id,m.revision LIMIT ?`).all(EXECUTION_POLICY, limit)
      for (const row of rows) this.auditMemory(textValue(row.project) as ProjectId, { id: textValue(row.id) as MemoryId, revision: integer(row.revision) })
      return { checked: rows.length, pending: rows.length === limit }
    })
  }

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
   * @param excludeInheritedTurns - omit turns whose start is part of inherited history.
   * @returns number of newly enqueued tasks.
   */
  scanPage(project: ProjectId, session: SessionId, config: L1Spec, events: readonly SessionEvent[], excludeInheritedTurns = false): number {
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
          if ((excludeInheritedTurns ? start : event.seq) >= integer(source.inherited_count)) {
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
    this.projectLegacyCandidate(project, operation)
    const row = this.db.prepare(`SELECT ${COMPACT_TASK_COLUMNS} FROM l1_tasks WHERE project = ? AND id = ?`).get(project, operation)
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
    const tasks = this.db.prepare(`SELECT ${COMPACT_TASK_COLUMNS} FROM l1_tasks WHERE project = ? AND id > ? ORDER BY id LIMIT ?`).all(project, after, limit).map(decodeTask)
    for (const task of tasks) this.projectLegacyCandidate(project, task.operationId)
    return tasks
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
      const rows = this.db.prepare(`SELECT ${COMPACT_TASK_COLUMNS} FROM l1_tasks WHERE project = ? AND session_id = ? AND
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
    const row = this.db.prepare(`SELECT ${COMPACT_TASK_COLUMNS} FROM l1_tasks WHERE project = ? AND id = ? AND owner = ?`).get(project, operation, owner)
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
      if (valid.kind === 'memory') this.checkExecution(task, valid.summary)
      const compact = valid.kind === 'empty' ? valid : { kind: 'memory', summary: this.compactSummary(valid.summary) }
      if (task.candidate !== null) {
        if (!isDeepStrictEqual(task.candidate, compact)) throw new MemoryError('conflict', 'L1 operation already has another candidate')
        if (valid.kind === 'memory' && valid.summary.trace !== undefined) {
          const equal = this.db.prepare(`WITH stored AS (
            SELECT fullkey, type, atom FROM json_tree((SELECT candidate FROM l1_tasks WHERE id = ?), '$.summary.trace')
          ), incoming AS (
            SELECT '$.summary.trace' || substr(fullkey, 2) AS fullkey, type, atom FROM json_tree(?)
          ) SELECT NOT EXISTS(SELECT * FROM stored EXCEPT SELECT * FROM incoming)
            AND NOT EXISTS(SELECT * FROM incoming EXCEPT SELECT * FROM stored) AS equal`)
            .get(operation, JSON.stringify(valid.summary.trace))?.equal
          if (equal !== 1) throw new MemoryError('conflict', 'L1 operation already has another trace')
        }
        this.db.prepare("UPDATE l1_tasks SET status = 'prepared' WHERE id = ?").run(operation)
      } else this.db.prepare("UPDATE l1_tasks SET candidate = ?, status = 'prepared' WHERE id = ?").run(JSON.stringify(valid), operation)
      this.db.prepare('INSERT OR REPLACE INTO l1_candidate_projections VALUES (?, ?)').run(operation, JSON.stringify(compact))
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
        this.checkExecution(task, task.candidate.summary)
        const current = this.currentRevision(project, task.memoryId)
        if (current !== task.expectedRevision) throw new MemoryError('conflict', 'L1 memory revision changed')
        const revision = (current ?? 0) + 1
        const summary = task.candidate.summary
        this.db.prepare('INSERT INTO l1_memories VALUES (?, ?, ?, ?, ?, ?)').run(task.memoryId, revision, project, operation, JSON.stringify(summary), now)
        const traceType = this.db.prepare(`SELECT json_type(candidate, '$.summary.trace') AS type FROM l1_tasks WHERE id = ?`).get(operation)?.type
        if (traceType === null) this.writeTrace(task, revision)
        else {
          if (traceType !== 'object') throw new MemoryError('output', 'L1 expected a trace object')
          this.copyStoredTrace(project, { id: task.memoryId, revision }, { table: 'l1_tasks', path: '$.summary.trace', id: operation })
        }
        this.db.prepare('INSERT INTO l1_summary_projections VALUES (?, ?, ?)').run(task.memoryId, revision, JSON.stringify(summary))
      }
      this.db.prepare('UPDATE l1_tasks SET status = ?, owner = NULL, lease_until = 0, failure = NULL WHERE id = ?').run(task.candidate.kind === 'empty' ? 'empty' : 'done', operation)
      if (task.candidate.kind === 'memory') this.auditMemory(project, { id: task.memoryId, revision: this.currentRevision(project, task.memoryId)! })
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
    this.projectLegacyMemory(project, ref)
    const row = this.db.prepare(`SELECT m.id, m.revision, m.project, m.operation_id, m.created_at, p.summary
      FROM l1_memories m JOIN l1_summary_projections p ON p.memory_id = m.id AND p.revision = m.revision
      WHERE m.project = ? AND m.id = ? AND m.revision = ?`).get(project, ref.id, ref.revision)
    if (row === undefined) return null
    const task = this.getTask(project, textValue(row.operation_id) as OperationId)
    if (task === null || task.memoryId !== ref.id || task.status !== 'done') throw new MemoryError('corrupt', 'L1 memory has no matching completed task')
    const candidate = parseCandidate({ kind: 'memory', summary: json(row.summary) }, taskRefs(task), task.reason)
    if (candidate.kind !== 'memory') throw new MemoryError('corrupt', 'L1 memory has no summary')
    return { ...ref, projectId: project, operationId: task.operationId, level: 'L1', sessionId: task.sessionId,
      turn: task.turn, reason: task.reason, range: { from: task.from, to: task.to }, config: task.config,
      summary: this.compactSummary(candidate.summary), createdAt: integer(row.created_at), state: this.currentRevision(project, ref.id) === ref.revision ? 'active' : 'superseded' }
  }

  private compactSummary(summary: L1Memory['summary']): L1Memory['summary'] {
    const { trace: _trace, ...compact } = summary
    return compact
  }

  private projectLegacyCandidate(project: ProjectId, operation: OperationId): void {
    if (this.db.prepare('SELECT 1 FROM l1_candidate_projections WHERE operation_id = ?').get(operation) !== undefined) return
    this.db.prepare(`INSERT OR IGNORE INTO l1_candidate_projections
      SELECT id, json_remove(candidate, '$.summary.trace') FROM l1_tasks
      WHERE project = ? AND id = ? AND candidate IS NOT NULL AND json_valid(candidate)`).run(project, operation)
  }

  /** Populate compatibility projections while the owning schema transaction is open.
   * @param db - connection owned by the schema migration.
   * @param maxTraceBytes - configured immutable chunk byte limit.
   * @returns completion after each legacy record's compact metadata and trace are durable.
   */
  static backfillProjections(db: DatabaseSync, maxTraceBytes: number): void {
    const store = new L1Store(db, () => {}, () => {}, maxTraceBytes)
    db.prepare(`INSERT OR IGNORE INTO l1_candidate_projections
      SELECT id, json_remove(candidate, '$.summary.trace') FROM l1_tasks WHERE candidate IS NOT NULL AND json_valid(candidate)`).run()
    for (const row of db.prepare('SELECT project, id, revision FROM l1_memories').iterate()) {
      store.projectLegacyMemory(textValue(row.project) as ProjectId, { id: textValue(row.id) as MemoryId, revision: integer(row.revision) })
    }
  }

  private projectLegacyMemory(project: ProjectId, ref: MemoryRef): void {
    if (this.db.prepare(`SELECT 1 FROM l1_summary_projections p JOIN l1_memories m ON p.memory_id = m.id AND p.revision = m.revision
      WHERE m.project = ? AND p.memory_id = ? AND p.revision = ?`).get(project, ref.id, ref.revision) !== undefined) return
    const row = this.db.prepare(`SELECT CASE WHEN json_valid(summary) THEN json_remove(summary, '$.trace') END AS summary,
      json_valid(summary) AS valid FROM l1_memories WHERE project = ? AND id = ? AND revision = ?`).get(project, ref.id, ref.revision)
    if (row === undefined) return
    if (row.valid !== 1) throw new MemoryError('output', 'L1 invalid JSON')
    this.db.exec('SAVEPOINT memory_legacy_projection')
    try {
      const modern = this.db.prepare('SELECT 1 FROM l1_trace_chunks WHERE memory_id = ? AND revision = ? LIMIT 1').get(ref.id, ref.revision) !== undefined
      if (!modern) {
        this.copyStoredTrace(project, ref, { table: 'l1_memories', path: '$.trace', id: ref.id, revision: ref.revision })
      }
      this.db.prepare('INSERT INTO l1_summary_projections VALUES (?, ?, ?)').run(ref.id, ref.revision, textValue(row.summary))
      this.db.exec('RELEASE memory_legacy_projection')
    } catch (error) {
      this.db.exec('ROLLBACK TO memory_legacy_projection')
      this.db.exec('RELEASE memory_legacy_projection')
      throw error
    }
  }

  /** Verify cited results against their preceding recorded tool invocation.
   * @param project - source owner.
   * @param operation - extraction task.
   * @param refs - exact citations, bounded by model output.
   * @returns only successful matched result identities.
   */
  successfulRefs(project: ProjectId, operation: OperationId, refs: readonly EventRef[]): EventRef[] {
    this.assertOpen()
    const task = this.getTask(project, operation)
    if (task === null) throw new MemoryError('source', 'L1 task is unavailable')
    const verified: EventRef[] = []
    for (const ref of refs) {
      if (!taskRefs(task)(ref)) throw new MemoryError('source', 'Execution citation is outside the source turn')
      const row = this.db.prepare('SELECT body FROM events WHERE session_id = ? AND seq = ?').get(task.sessionId, ref.seq)
      if (row === undefined) throw new MemoryError('gap', 'Execution citation is unavailable')
      const result = executionEvent(row.body, ref.seq)
      if (result.type !== 'tool/result') continue
      const callRow = this.db.prepare(`SELECT seq,body FROM events WHERE session_id = ? AND seq >= ? AND seq < ?
        AND CASE WHEN json_valid(body) THEN json_extract(body, '$.type') = 'tool/call'
          AND json_extract(body, '$.data.callId') = ? ELSE 0 END ORDER BY seq DESC LIMIT 1`)
        .get(task.sessionId, task.from, ref.seq, result.data.message.toolCallId)
      if (callRow === undefined) throw new MemoryError('gap', 'Execution invocation is unavailable')
      const call = executionEvent(callRow.body, integer(callRow.seq))
      if (call.type === 'tool/call' && executionSucceeded(call, result)) verified.push(ref)
    }
    return verified
  }

  private writeTrace(task: L1Task, revision: number): void {
    const insert = this.db.prepare('INSERT INTO l1_trace_chunks VALUES (?, ?, ?, ?)')
    let chunk = ''
    let chunkBytes = 0
    let index = 0
    const append = (text: string): void => {
      let offset = 0
      while (offset < text.length) {
        const end = utf8End(text, offset, this.traceChunkBytes - chunkBytes)
        if (end === offset) {
          if (chunk === '') throw new MemoryError('config', 'Trace chunk budget cannot contain a Unicode code point')
          insert.run(task.memoryId, revision, index++, chunk)
          chunk = ''; chunkBytes = 0
          continue
        }
        const part = text.slice(offset, end)
        chunk += part; chunkBytes += Buffer.byteLength(part); offset = end
      }
    }
    append('{"actions":' + JSON.stringify(task.candidate?.kind === 'memory' ? task.candidate.summary.actions : []))
    for (const category of ['commands', 'files', 'errors'] as const) {
      append(',"' + category + '":[')
      let first = true
      const item = (value: string): void => { if (!first) append(','); first = false; append(JSON.stringify(value)) }
      for (const row of this.db.prepare('SELECT body FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq').iterate(task.sessionId, task.from, task.to)) {
        const event = object(json(row.body)) as SessionEvent
        if (traceIncludes(event, category)) item(JSON.stringify(event))
      }
      append(']')
    }
    append('}')
    if (chunk !== '') insert.run(task.memoryId, revision, index, chunk)
  }

  /** Read byte-bounded JSON text from an exact immutable trace, including legacy inline trace.
   * @param project - owning project.
   * @param ref - exact L1 version.
   * @param cursor - previous nextCursor, omitted for the beginning.
   * @param maxBytes - maximum UTF-8 response bytes.
   * @returns JSON stream page; concatenate all pages before decoding.
   */
  readTrace(project: ProjectId, ref: MemoryRef, cursor: TraceCursor = { chunk: 0, offset: 0 }, maxBytes = this.traceChunkBytes): TracePage {
    this.assertOpen()
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || !Number.isSafeInteger(cursor.chunk) || cursor.chunk < 0
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new MemoryError('config', 'Invalid trace page budget or cursor')
    this.projectLegacyMemory(project, ref)
    const memory = this.db.prepare('SELECT 1 FROM l1_memories WHERE project = ? AND id = ? AND revision = ?').get(project, ref.id, ref.revision)
    if (memory === undefined) return { found: false, text: '', nextCursor: null }
    const modern = this.db.prepare('SELECT 1 FROM l1_trace_chunks WHERE memory_id = ? AND revision = ? LIMIT 1').get(ref.id, ref.revision) !== undefined
    if (!modern) return this.readStoredTrace(project, { table: 'l1_memories', path: '$.trace', id: ref.id, revision: ref.revision }, cursor, maxBytes)
    const read = (index: number): string | undefined => {
      const row = this.db.prepare('SELECT body FROM l1_trace_chunks WHERE memory_id = ? AND revision = ? AND chunk_index = ?').get(ref.id, ref.revision, index)
      return row === undefined ? undefined : textValue(row.body)
    }
    let index = cursor.chunk
    let offset = cursor.offset
    let text = ''
    let remaining = maxBytes
    for (;;) {
      const body = read(index)
      if (body === undefined) return { found: true, text, nextCursor: null }
      if (offset > body.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(body[offset]!))) throw new MemoryError('config', 'Trace cursor is outside a Unicode boundary')
      const end = utf8End(body, offset, remaining)
      const part = body.slice(offset, end)
      text += part; remaining -= Buffer.byteLength(part)
      if (end < body.length) return { found: true, text, nextCursor: { chunk: index, offset: end } }
      index++; offset = 0
      if (remaining < 4) return { found: true, text, nextCursor: read(index) === undefined ? null : { chunk: index, offset: 0 } }
    }
  }

  private copyStoredTrace(project: ProjectId, ref: MemoryRef, source: LegacyTraceSource): void {
    let cursor: TraceCursor | undefined
    let index = 0
    do {
      const page = this.readStoredTrace(project, source, cursor ?? { chunk: 0, offset: 0 }, this.traceChunkBytes)
      if (page.text !== '') this.db.prepare('INSERT INTO l1_trace_chunks VALUES (?, ?, ?, ?)').run(ref.id, ref.revision, index++, page.text)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
  }

  private readStoredTrace(project: ProjectId, source: LegacyTraceSource, cursor: TraceCursor, maxBytes: number): TracePage {
    // SQLite may materialize the legacy TEXT internally; only a bounded Unicode window enters JavaScript.
    const count = Math.max(1, Math.floor(maxBytes / 4))
    const column = source.table === 'l1_memories' ? 'summary' : 'candidate'
    const row = this.db.prepare(`SELECT substr(json_extract(${column}, '${source.path}'), ?, ?) AS fragment,
      length(json_extract(${column}, '${source.path}')) AS total
      FROM ${source.table} WHERE project = ? AND id = ? ${source.revision === undefined ? '' : 'AND revision = ?'}`)
      .get(cursor.offset + 1, count, project, source.id, ...source.revision === undefined ? [] : [source.revision])
    if (row?.fragment === null || row === undefined) return { found: true, text: '', nextCursor: null }
    if (cursor.chunk !== 0 || cursor.offset > integer(row.total)) throw new MemoryError('config', 'Trace cursor is outside a Unicode boundary')
    if (typeof row.fragment !== 'string') throw new MemoryError('output', 'L1 expected trace JSON text')
    const offset = cursor.offset + Array.from(row.fragment).length
    return { found: true, text: row.fragment, nextCursor: offset === row.total ? null : { chunk: 0, offset } }
  }
}
