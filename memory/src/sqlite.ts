/** Independent L0 database; events and their continuous prefix commit atomically. */
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { assertContiguous, materializeAppendBatch, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { memoryPath } from './config.ts'
import type { Spec } from './config.ts'
import { MemoryError } from './types.ts'
import type { AppendRawRequest, AppendRawResult, RawMemory, ReadRawRequest, ReadRawResult } from './types.ts'
import type { ProjectId } from './types.ts'
import type { L1Spec } from './l1-types.ts'
import { L1_SCHEMA, L1Store } from './l1-store.ts'
import { KNOWLEDGE_SCHEMA, KnowledgeStore } from './knowledge-store.ts'
import { VECTOR_SCHEMA, VectorStore } from './vector-store.ts'

/** Physical L0 schema version; future migrations must increase it. */
export const SCHEMA_VERSION = 4
const APPLICATION_ID = 0x4453484d

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new MemoryError('corrupt', 'invalid JSON in memory database', error)
  }
}

function parseProject(value: unknown): ProjectId {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new MemoryError('corrupt', 'invalid stored project identifier')
  }
  return value as ProjectId
}

/** Read and validate database-owned JSON before passing it to Session validation. */
function parseHeader(value: unknown): SessionHeader {
  if (typeof value !== 'string') throw new MemoryError('corrupt', 'invalid stored Session header')
  const parsed = parseJson(value)
  if (parsed === null || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string'
    || !('version' in parsed) || parsed.version !== SESSION_FORMAT_VERSION
    || !('createdAt' in parsed) || !Number.isSafeInteger(parsed.createdAt)
    || !('isSeeded' in parsed) || typeof parsed.isSeeded !== 'boolean') {
    throw new MemoryError('corrupt', 'unsupported or invalid stored Session header')
  }
  return materializeCreateHeader(parsed as SessionHeader)
}

function decodeEvent(value: unknown, header: SessionHeader, seq: number): SessionEvent {
  if (typeof value !== 'string') throw new MemoryError('corrupt', 'invalid stored event JSON')
  const event = parseJson(value)
  if (event === null || typeof event !== 'object' || !('seq' in event) || event.seq !== seq
    || !('type' in event) || typeof event.type !== 'string' || !('time' in event) || !Number.isSafeInteger(event.time)
    || !('data' in event)) throw new MemoryError('corrupt', `invalid event envelope at seq ${seq}`)
  const events = validateStoredEvents(header, [event as SessionEvent])
  return events[0]!
}

/** SQLite implementation of the minimal memory capability. */
export class SqliteMemory implements RawMemory {
  private closed = false
  /** L1 operations share this provider's connection and close lifetime. */
  readonly l1: L1Store

  /** Long-term operations share the provider connection and lifetime. */
  readonly knowledge: KnowledgeStore

  /** Version-bound vector storage. */
  readonly vectors: VectorStore
  private readonly changes = new Set<() => void>()
  private generation = 0

  /** Subscribe to committed memory changes; callbacks must not throw.
   * @param listener - nonthrowing scheduling notification.
   * @returns disposer.
   */
  onMemoryChange(listener: () => void): () => void { this.changes.add(listener); return () => { this.changes.delete(listener) } }

  private notify = (): void => {
    const generation = this.vectors.generation()
    if (generation === this.generation) return
    this.generation = generation
    for (const listener of this.changes) listener()
  }

  private constructor(private readonly db: DatabaseSync) {
    this.l1 = new L1Store(db, () => this.assertOpen(), this.notify)
    this.knowledge = new KnowledgeStore(db, this.l1, () => this.assertOpen(), this.notify)
    this.vectors = new VectorStore(db, this.knowledge, () => this.assertOpen())
    this.generation = this.vectors.generation()
  }

  /**
   * Read immutable ownership before adopting a Session.
   * @param sessionId - canonical Session identity.
   * @returns stored project, or undefined for a Session not yet copied.
   */
  getSessionProject(sessionId: SessionId): ProjectId | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT project FROM sessions WHERE id = ?').get(sessionId)
    return row === undefined ? undefined : parseProject(row.project)
  }

  /**
   * Enumerate owners for startup L1 recovery, including unloaded Sessions.
   * @returns distinct stored projects in identifier order.
   */
  listProjects(): ProjectId[] {
    this.assertOpen()
    return this.db.prepare('SELECT DISTINCT project FROM sessions ORDER BY project').all().map(row => parseProject(row.project))
  }

  /**
   * Open a database without overwriting another database's schema.
   * @param spec - configuration already resolved by resolveConfig.
   * @returns ready provider; callers must await close before disposal completes.
   */
  static async open(spec: Spec): Promise<SqliteMemory> {
    const path = await memoryPath(spec.databasePath)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await memoryPath(path)
    for (const suffix of ['-wal', '-shm', '-journal']) await memoryPath(path + suffix)
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const db = new DatabaseSync(path)
    try {
      db.exec(`PRAGMA busy_timeout = ${spec.busyTimeoutMs}`)
      db.exec('PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON')
      db.exec('BEGIN IMMEDIATE')
      try {
        const version = db.prepare('PRAGMA user_version').get()?.user_version
        const identity = db.prepare('PRAGMA application_id').get()?.application_id
        if (version === 0 && identity === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) {
          db.exec(`CREATE TABLE sessions (
            id TEXT PRIMARY KEY, project TEXT NOT NULL, header TEXT NOT NULL,
            inherited_count INTEGER NOT NULL CHECK(inherited_count >= 0),
            committed_to INTEGER NOT NULL CHECK(committed_to >= 0)
          ) STRICT;
          CREATE TABLE events (
            session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL CHECK(seq >= 0),
            body TEXT NOT NULL, PRIMARY KEY(session_id, seq)
          ) STRICT;
          CREATE INDEX sessions_project ON sessions(project, id);
          PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`)
        } else if ((version !== 1 && version !== 2 && version !== 3 && version !== SCHEMA_VERSION) || identity !== APPLICATION_ID) {
          throw new MemoryError('schema', 'unrecognized memory database identity or schema version')
        }
        // Prepare exact columns before accepting a stamped but malformed database.
        db.prepare('SELECT id, project, header, inherited_count, committed_to FROM sessions LIMIT 0').all()
        db.prepare('SELECT session_id, seq, body FROM events LIMIT 0').all()
        if (version === 0 || version === 1) {
          db.exec(L1_SCHEMA)
        }
        if (version === 0 || version === 1 || version === 2) {
          db.exec(KNOWLEDGE_SCHEMA)
        }
        if (version !== SCHEMA_VERSION) { db.exec(VECTOR_SCHEMA); db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`) }
        db.prepare('SELECT space,id,revision,digest,vector FROM memory_vectors LIMIT 0').all()
        db.prepare('SELECT space,status,failure FROM memory_index_state LIMIT 0').all()
        db.prepare('SELECT generation FROM memory_generation WHERE singleton = 1').get()
        db.prepare('SELECT session_id, cursor, open_turn, open_from FROM l1_scans LIMIT 0').all()
        db.prepare('SELECT id, project, session_id, from_seq, to_seq, turn, reason, config, memory_id, expected_revision, status, attempts, calls, next_retry_at, failure, candidate, lease_until, owner FROM l1_tasks LIMIT 0').all()
        db.prepare('SELECT id, revision, project, operation_id, summary, created_at FROM l1_memories LIMIT 0').all()
        db.prepare('SELECT id, revision, project, level, operation_id, content_key, knowledge, config, created_at, state FROM knowledge_versions LIMIT 0').all()
        db.prepare('SELECT id, project, body FROM knowledge_tasks LIMIT 0').all()
        db.prepare('SELECT id, request, result FROM knowledge_operations LIMIT 0').all()
        db.prepare('SELECT id, receipt_id, request FROM knowledge_share_actions LIMIT 0').all()
        db.prepare('SELECT id, revision, action_id FROM knowledge_grants LIMIT 0').all()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      db.exec(`PRAGMA journal_mode = ${spec.journalMode}; PRAGMA synchronous = FULL`)
      return new SqliteMemory(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /**
   * Commit the batch and prefix together, or roll back all changes.
   * @param request - ordered batch with immutable source identity.
   * @returns committed counts and prefix.
   */
  async appendRaw(request: AppendRawRequest): Promise<AppendRawResult> {
    this.assertOpen()
    request.signal?.throwIfAborted()
    const header = materializeCreateHeader(request.header)
    if (header.version !== SESSION_FORMAT_VERSION) throw new MemoryError('schema', 'unsupported source Session format')
    const events = materializeAppendBatch(request.events)
    const start = events[0]?.seq
    if (start !== undefined) assertContiguous(header.id, events, start)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(header.id)
      if (row === undefined) {
        this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, 0)').run(header.id, request.projectId, JSON.stringify(header), request.inheritedEventCount)
        row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(header.id)!
      }
      if (row.project !== request.projectId || !isDeepStrictEqual(parseHeader(row.header), header)
        || row.inherited_count !== request.inheritedEventCount) {
        throw new MemoryError('conflict', `Session ${header.id} already has different project or source metadata`)
      }
      let committedTo = this.offset(row.committed_to)
      if (start !== undefined && start > committedTo) throw new MemoryError('gap', `Session ${header.id} requires seq ${committedTo}`)
      let inserted = 0
      let duplicates = 0
      for (const event of events) {
        const body = JSON.stringify(event)
        if (event.seq < committedTo) {
          const old = this.db.prepare('SELECT body FROM events WHERE session_id = ? AND seq = ?').get(header.id, event.seq)
          if (old === undefined) throw new MemoryError('corrupt', `Session ${header.id} is missing committed seq ${event.seq}`)
          if (!isDeepStrictEqual(decodeEvent(old.body, header, event.seq), event)) throw new MemoryError('conflict', `Session ${header.id} conflicts at seq ${event.seq}`)
          duplicates++
        } else {
          this.db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(header.id, event.seq, body)
          committedTo = SessionLogOffset(event.seq + 1)
          inserted++
        }
      }
      this.db.prepare('UPDATE sessions SET committed_to = ? WHERE id = ?').run(committedTo, header.id)
      request.signal?.throwIfAborted()
      this.db.exec('COMMIT')
      return { range: { from: SessionLogOffset(start ?? committedTo), to: SessionLogOffset(start === undefined ? committedTo : start + events.length) }, inserted, duplicates, committedTo }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Read one transactionally consistent page; corrupt rows reject.
   * @param request - requested project, interval and page.
   * @returns ordered data and interval-wide missing ranges.
   */
  async readRaw(request: ReadRawRequest): Promise<ReadRawResult> {
    this.assertOpen()
    request.signal?.throwIfAborted()
    const cursor = request.cursor ?? request.from
    if (![request.from, request.to, cursor].every(n => Number.isSafeInteger(n) && n >= 0)
      || request.to < request.from || cursor < request.from || cursor > request.to
      || !Number.isSafeInteger(request.limit) || request.limit < 1) throw new MemoryError('config', 'invalid raw read interval or page')
    this.db.exec('BEGIN')
    try {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ? AND project = ?').get(request.sessionId, request.projectId)
      const committedTo = row === undefined ? SessionLogOffset(0) : this.offset(row.committed_to)
      const end = Math.min(request.to, committedTo, cursor + request.limit)
      const rows = row === undefined ? [] : this.db.prepare('SELECT seq, body FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq').all(request.sessionId, cursor, end)
      if (rows.length !== Math.max(0, end - cursor)) throw new MemoryError('corrupt', `Session ${request.sessionId} has a gap in its committed prefix`)
      const header = row === undefined ? undefined : parseHeader(row.header)
      const events = rows.map((event, i) => {
        if (event.seq !== cursor + i || header === undefined || header.id !== request.sessionId) throw new MemoryError('corrupt', 'stored Session identity or sequence mismatch')
        return decodeEvent(event.body, header, cursor + i)
      })
      this.db.exec('COMMIT')
      const missingFrom = Math.max(request.from, committedTo)
      return {
        found: row !== undefined, events, committedTo,
        nextCursor: end > cursor && end < Math.min(request.to, committedTo) ? SessionLogOffset(end) : null,
        missing: missingFrom < request.to ? [{ from: SessionLogOffset(missingFrom), to: request.to }] : [],
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Close the connection once; no operations are accepted afterwards.
   * @returns resolution after SQLite releases all file handles.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * Discover ended turns exclusively from complete committed L0 pages.
   * @param project - owning project; other projects are not scanned.
   * @param config - immutable extraction settings saved on every new task.
   * @param pageSize - positive maximum decoded events per scan transaction.
   * @returns number of newly created extraction tasks.
   */
  scanTurns(project: ProjectId, config: L1Spec, pageSize: number): number {
    this.assertOpen()
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new MemoryError('config', 'L1 scan page size must be positive')
    let created = 0
    for (const row of this.db.prepare('SELECT id, header, committed_to FROM sessions WHERE project = ? ORDER BY id').all(project)) {
      const header = parseHeader(row.header)
      let position = this.l1.cursor(project, header.id)
      const end = this.offset(row.committed_to)
      if (position > end) throw new MemoryError('corrupt', 'L1 scan checkpoint exceeds L0 prefix')
      while (position < end) {
        const stop = Math.min(end, position + pageSize)
        const rows = this.db.prepare('SELECT body FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq').all(header.id, position, stop)
        if (rows.length !== stop - position) throw new MemoryError('gap', 'L1 source has missing committed events')
        const events = rows.map((event, i) => decodeEvent(event.body, header, position + i))
        created += this.l1.scanPage(project, header.id, config, events)
        position = stop
      }
    }
    return created
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryError('closed', 'memory database is closed')
  }

  private offset(value: unknown): SessionLogOffset {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MemoryError('corrupt', 'invalid committed position')
    return SessionLogOffset(value)
  }
}
