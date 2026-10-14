/** Isolated in-memory SQLite retention and historical-copy recovery, with deterministic barriers. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { MAINTENANCE_SCHEMA, MaintenanceStore } from '../src/maintenance-store.ts'
import { HistoryImporter } from '../src/history.ts'
import type { AsyncMaintenance, HistoryMemory } from '../src/history.ts'
import { L1_SCHEMA, L1Store, TRACE_SCHEMA } from '../src/l1-store.ts'
import { KNOWLEDGE_SCHEMA, KnowledgeStore } from '../src/knowledge-store.ts'
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'
import type { OperationId } from '../src/l1-types.ts'
import { VECTOR_SCHEMA } from '../src/vector-store.ts'
import { SELECTION_SCHEMA } from '../src/selection-store.ts'
import { memoryPath } from '../src/config.ts'
import { MemoryService } from '../src/index.ts'
import type { MemoryRoutes } from '../src/index.ts'
import { WorkspaceMemory } from '../src/workspace-storage.ts'
import { SqliteMemory as SqliteBackend } from '../src/sqlite-backend.ts'
import { fixture } from './helpers.ts'
import { MemoryError } from '../src/types.ts'
import type { ProjectId } from '../src/types.ts'

const project = 'project-a' as ProjectId
const day = 86_400_000
function header(id: string, createdAt = 1): SessionHeader {
  return { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt, isSeeded: false, cwd: '/project-a' }
}
function events(count: number, startTime = 1): SessionEvent[] {
  return Array.from({ length: count }, (_, seq) => ({ type: 'session/end-seed' as const, seq: SessionSeq(seq), time: startTime + seq, data: {} }))
}
function setup(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,project TEXT NOT NULL,header TEXT NOT NULL,inherited_count INTEGER NOT NULL,committed_to INTEGER NOT NULL) STRICT;
    CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_id,seq)) STRICT;`)
  db.exec(L1_SCHEMA + KNOWLEDGE_SCHEMA + VECTOR_SCHEMA + SELECTION_SCHEMA + TRACE_SCHEMA + MAINTENANCE_SCHEMA)
  const store = new MaintenanceStore(db, () => {})
  function session(id: string, time = 1) {
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(id, project, JSON.stringify(header(id)), 0, 1)
    db.prepare('INSERT INTO events VALUES (?,?,?)').run(id, 0, JSON.stringify(events(1, time)[0]))
  }
  function l1(id: string, source: string, status = 'done') {
    db.prepare(`INSERT INTO l1_tasks(id,project,session_id,from_seq,to_seq,turn,reason,config,memory_id,status) VALUES (?,?,?,0,1,1,?,?,?,?)`).run('task-' + id, project, source,
      JSON.stringify({ kind: 'completed' }), JSON.stringify(resolveL1Config({ provider: 'test', model: 'test' })), id, status)
    const summary = { goal: 'Requested work', actions: [], outcome: 'unknown', result: 'No observed result', solution: null, sources: [{ sessionId: source, seq: 0 }] }
    db.prepare('INSERT INTO l1_memories VALUES (?,1,?,?,?,1)').run(id, project, 'task-' + id, JSON.stringify(summary))
    db.prepare('INSERT INTO l1_summary_projections VALUES (?,1,?)').run(id, JSON.stringify(summary))
    db.prepare('INSERT INTO l1_candidate_projections VALUES (?,?)').run('task-' + id, JSON.stringify({ kind: 'memory', summary }))
  }
  function knowledge(id: string, parents: string[], state = 'active', conflicts: string[] = []) {
    db.prepare('INSERT INTO knowledge_versions VALUES (?,1,?,?,?, ?,?,?,1,?)').run(id, project, 'L2', 'op-' + id, id,
      JSON.stringify({ sources: parents.map(id => ({ kind: 'memory', ref: { id, revision: 1 } })), conflicts: conflicts.map(id => ({ ref: { id, revision: 1 }, reason: 'conflict' })) }), '{}', state)
  }
  return { db, store, session, l1, knowledge }
}

it('keeps import checkpoints durable and cancellation monotonic, with exact project ownership', () => {
  const f = setup()
  try {
    const job = f.store.startImport(project, [{ sessionId: SessionId('history'), targetTo: 2 }])
    expect(f.store.admitted(project, SessionId('history'))).toBe(true)
    expect(() => f.store.checkpointImport(project, job.id, SessionId('history'), 1)).toThrow('stored prefix')
    f.session('history')
    f.store.checkpointImport(project, job.id, SessionId('history'), 1)
    f.store.cancelImport(project, job.id)
    expect(f.store.checkpointImport(project, job.id, SessionId('history'), 1).status).toBe('cancelled')
    expect(f.store.latestImport(project)?.items[0]?.committedTo).toBe(1)
    expect(f.store.getImport('other' as ProjectId, job.id)).toBeNull()
    expect(() => f.store.startImport('other' as ProjectId, [{ sessionId: SessionId('history'), targetTo: 2 }])).toThrow('another project')
  } finally { f.db.close() }
})

it('rechecks selection and conflict ancestry, retryable tasks, active sessions and exact age boundaries', () => {
  const f = setup()
  try {
    for (const id of ['selected', 'conflicted', 'retryable', 'active', 'expired', 'boundary']) f.session(id, id === 'boundary' ? day : 1)
    f.l1('a', 'selected'); f.l1('b', 'conflicted'); f.l1('c', 'retryable', 'failed')
    expect(f.store.cleanupPreview(project, { maxAgeDays: 1, now: day * 2 }).eligibleSessions).toBe(4)
    f.db.prepare(`INSERT INTO memory_selections VALUES (?,?,'token',?,0)`).run('active', project, JSON.stringify([{ id: 'a', revision: 1 }]))
    f.knowledge('conflict', [], 'active', ['b'])
    const result = f.store.cleanup(project, { maxAgeDays: 1, now: day * 2, activeSessionIds: [SessionId('active')] })
    expect(result).toMatchObject({ deletedSessions: 1, protectedSessions: 4, protectedEventCount: 4 })
    expect(f.db.prepare('SELECT id FROM sessions ORDER BY id').all().map(row => row.id)).toEqual(['active', 'boundary', 'conflicted', 'retryable', 'selected'])
    expect(f.store.tombstoned(project, SessionId('expired'))).toBe(true)
    expect(f.store.cleanupStatus(project)?.id).toBe(result.id)
    f.store.startImport(project, [{ sessionId: SessionId('expired'), targetTo: 1 }])
    expect(f.store.tombstoned(project, SessionId('expired'))).toBe(false)
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2, activeSessionIds: [SessionId('active')] }).deletedSessions).toBe(0)
  } finally { f.db.close() }
})

it('retains granted superseded ancestry and deletes unused descendants and their vectors atomically', () => {
  const f = setup()
  try {
    f.session('grant-source'); f.session('unused')
    f.l1('grant-l1', 'grant-source'); f.l1('unused-l1', 'unused')
    f.knowledge('granted', ['grant-l1'], 'superseded')
    f.knowledge('unused-l2', ['unused-l1'], 'invalidated')
    f.knowledge('unused-l3', ['unused-l2'], 'superseded')
    f.db.prepare(`INSERT INTO knowledge_share_actions VALUES ('approval','receipt','{}')`).run()
    f.db.prepare(`INSERT INTO knowledge_grants VALUES ('granted',1,'approval')`).run()
    f.db.prepare(`INSERT INTO memory_vectors VALUES ('space','unused-l3',1,'digest','[]')`).run()
    f.db.prepare(`INSERT INTO l1_trace_chunks VALUES ('unused-l1',1,0,'{"actions":[]}')`).run()
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toMatchObject({ deletedSessions: 1, protectedSessions: 1 })
    expect(f.db.prepare('SELECT id FROM knowledge_versions').all().map(row => row.id)).toEqual(['granted'])
    expect(f.db.prepare('SELECT * FROM memory_vectors').all()).toEqual([])
    expect(f.db.prepare('SELECT * FROM l1_trace_chunks').all()).toEqual([])
    expect(f.db.prepare('SELECT memory_id FROM l1_summary_projections').all().map(row => row.memory_id)).toEqual(['grant-l1'])
    expect(f.db.prepare('SELECT operation_id FROM l1_candidate_projections').all().map(row => row.operation_id)).toEqual(['task-grant-l1'])
    expect(f.db.prepare('SELECT id FROM l1_memories').all().map(row => row.id)).toEqual(['grant-l1'])
  } finally { f.db.close() }
})

it('rolls back source deletion and tombstones together on failure, and refuses missing retained ancestry', () => {
  const f = setup()
  try {
    f.session('source')
    f.db.exec(`CREATE TRIGGER refuse_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`)
    expect(() => f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toThrow('fixture failure')
    expect(f.store.tombstoned(project, SessionId('source'))).toBe(false)
    expect(f.db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(1)
    expect(f.store.cleanupStatus(project)).toBeNull()
    f.db.exec('DROP TRIGGER refuse_delete')
    f.knowledge('broken', ['missing'])
    expect(() => f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toThrow('missing ancestry')
    expect(f.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(1)
  } finally { f.db.close() }
})

function asyncMaintenance(store: MaintenanceStore): AsyncMaintenance {
  return {
    startImport: async (...args) => store.startImport(...args), getImport: async (...args) => store.getImport(...args),
    latestImport: async (...args) => store.latestImport(...args), listImports: async (...args) => store.listImports(...args),
    cancelImport: async (...args) => store.cancelImport(...args), checkpointImport: async (...args) => store.checkpointImport(...args),
    admitted: async (...args) => store.admitted(...args), tombstoned: async (...args) => store.tombstoned(...args),
    copiedPrefix: async (...args) => store.copiedPrefix(...args),
    listAdmissions: async (...args) => store.listAdmissions(...args), setActive: async (...args) => store.setActive(...args),
    cleanupPreview: async (...args) => store.cleanupPreview(...args), cleanup: async (...args) => store.cleanup(...args),
    cleanupStatus: async (...args) => store.cleanupStatus(...args), compact: async () => store.compact(),
  }
}

function importFixture() {
  const f = setup()
  const records = new Map<string, { header: SessionHeader; events: SessionEvent[]; inherited: number; missing?: boolean; needsMigration?: boolean; omitCount?: boolean; readFailure?: boolean }>()
  const closed = vi.fn()
  const readLengths: number[] = []
  const readRequests: Array<{ offset: number; length: number }> = []
  let beforeAppend: (() => Promise<void>) | undefined
  const source: Pick<SessionPersistence, 'list' | 'stat' | 'open'> = {
    list: async () => [...records.values()].map(record => ({ header: record.header, ...record.omitCount ? {} : { eventCount: record.events.length }, revision: SessionPersistenceRevision('revision'),
      ...record.needsMigration ? { formatStatus: 'migration-required' as const } : {} })),
    stat: async id => { const record = records.get(id); return record === undefined ? undefined : { header: record.header, ...record.omitCount ? {} : { eventCount: record.events.length }, revision: SessionPersistenceRevision('revision'),
      ...record.needsMigration ? { formatStatus: 'migration-required' as const } : {} } },
    open: async id => {
      const record = records.get(id)
      if (record === undefined || record.missing) throw new Error('missing source')
      const handle: SessionHandle = { id, header: record.header, inheritedEventCount: SessionLogOffset(record.inherited), access: 'read',
        read: async (offset = 0, length = record.events.length) => {
          readLengths.push(length); readRequests.push({ offset, length })
          if (record.readFailure) throw new Error('unreadable source')
          return { events: record.events.slice(offset, offset + length), eventState: 'detached' }
        },
        append: async () => { throw new Error('read only') }, flush: async () => { throw new Error('read only') },
        close: async () => { closed() }, [Symbol.asyncDispose]: async () => { closed() } }
      return handle
    },
  }
  const batches: number[] = []
  const inherited: number[] = []
  const memory: HistoryMemory = { maintenance: asyncMaintenance(f.store), appendRaw: async request => {
    await beforeAppend?.()
    let row = f.db.prepare('SELECT header,inherited_count,committed_to FROM sessions WHERE id=?').get(request.header.id)
    if (row === undefined) {
      f.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,0)').run(request.header.id, request.projectId, JSON.stringify(request.header), request.inheritedEventCount)
      row = { committed_to: 0, header: JSON.stringify(request.header), inherited_count: request.inheritedEventCount }
    }
    if (row.header !== JSON.stringify(request.header) || row.inherited_count !== request.inheritedEventCount) throw new MemoryError('conflict', 'Historical source metadata conflicts with captured source')
    const prefix = Number(row.committed_to)
    for (const event of request.events) f.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)').run(request.header.id, event.seq, JSON.stringify(event))
    const committedTo = Math.max(prefix, (request.events.at(-1)?.seq ?? (prefix - 1)) + 1)
    f.db.prepare('UPDATE sessions SET committed_to=? WHERE id=?').run(committedTo, request.header.id)
    batches.push(Buffer.byteLength(JSON.stringify(request.events))); inherited.push(request.inheritedEventCount)
    return { committedTo: SessionLogOffset(committedTo), inserted: Math.max(0, committedTo - prefix), duplicates: Math.max(0, request.events.length - (committedTo - prefix)),
      range: { from: SessionLogOffset(request.events[0]?.seq ?? prefix), to: SessionLogOffset(committedTo) } }
  } }
  const committed = vi.fn()
  const errors = vi.fn()
  const create = (learning = true) => new HistoryImporter(source, memory, async meta => meta.cwd === '/project-a' ? project : undefined, committed, 2, 128, learning, errors)
  return { ...f, records, create, memory, closed, readLengths, readRequests, batches, inherited, committed, errors,
    blockAppend(callback: () => Promise<void>) { beforeAppend = callback } }
}

it('imports old sources in byte-bounded pages, persists fork metadata, and deduplicates a repeated import', async () => {
  const f = importFixture(); const importer = f.create()
  try {
    f.records.set('old', { header: { ...header('old'), isSeeded: true }, events: events(5), inherited: 2 })
    f.records.set('other', { header: { ...header('other'), cwd: '/other' }, events: events(1), inherited: 0 })
    f.records.set('later', { header: header('later', 20), events: events(1), inherited: 0 })
    expect((await importer.preview({ projectId: project, toCreatedAt: 10 })).items.map(item => item.sessionId)).toEqual(['old'])
    const job = await importer.start(project, [SessionId('old')]); await importer.flush()
    expect((await importer.status(project, job.id))?.items[0]).toMatchObject({ targetTo: 5, committedTo: 5, status: 'done' })
    expect(f.readLengths.every(length => length === 1)).toBe(true)
    expect(f.batches.every(bytes => bytes <= 130)).toBe(true)
    expect(f.inherited.every(count => count === 2)).toBe(true)
    expect(f.committed).toHaveBeenCalled()
    await importer.start(project, [SessionId('old')]); await importer.flush()
    expect(f.db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(5)
    expect((await importer.preview({ projectId: project, toCreatedAt: 10 })).items[0]?.status).toBe('imported')
    await expect(importer.start(project, [SessionId('other')])).rejects.toThrow('outside this workspace')
  } finally { await importer.close(); f.db.close() }
})

it('cancels after an in-flight acknowledged append and resumes stopped durable work after restart', async () => {
  const f = importFixture(); let importer = f.create(false)
  let entered!: () => void; let release!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  try {
    f.records.set('source', { header: header('source'), events: events(4), inherited: 0 })
    let appends = 0
    f.blockAppend(async () => { if (++appends === 2) { entered(); await releasePromise } })
    const job = await importer.start(project, [SessionId('source')]); await enteredPromise
    await importer.cancel(project, job.id); release(); await importer.flush()
    expect((await importer.status(project, job.id))?.status).toBe('cancelled')
    expect((await importer.status(project, job.id))?.items[0]?.committedTo).toBe(2)
    expect(f.committed).not.toHaveBeenCalled()
    await importer.close()
    f.blockAppend(async () => {})
    const resumed = f.store.startImport(project, [{ sessionId: SessionId('source'), targetTo: 4 }])
    importer = f.create(false); await importer.resume(project); await importer.flush()
    expect((await importer.status(project, resumed.id))?.status).toBe('done')
    expect(f.db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(4)
    expect(f.closed).toHaveBeenCalledTimes(2)
  } finally { release(); await importer.close(); f.db.close() }
})

it('reports source failures per item and leaves unknown append outcomes resumable without blind retry', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    f.records.set('lost', { header: header('lost'), events: events(2), inherited: 0, missing: true })
    const missing = await importer.start(project, [SessionId('lost')]); await importer.flush()
    expect((await importer.status(project, missing.id))?.items[0]).toMatchObject({ status: 'failed', failure: 'source' })
    f.records.set('uncertain', { header: header('uncertain'), events: events(2), inherited: 0 })
    let calls = 0
    f.blockAppend(async () => { calls++; throw new MemoryError('unknown-outcome', 'Acknowledgement unavailable') })
    const unknown = await importer.start(project, [SessionId('uncertain')]); await importer.flush()
    expect(calls).toBe(1)
    expect((await importer.status(project, unknown.id))?.status).toBe('pending')
    expect(f.errors).toHaveBeenCalledTimes(1)
  } finally { await importer.close(); f.db.close() }
})

it('imports empty Session metadata, and paginates filtered previews without losing identity order', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    for (const id of ['c', 'a', 'b']) f.records.set(id, { header: header(id), events: [], inherited: 0 })
    const first = await importer.preview({ projectId: project, limit: 2 })
    expect(first.items.map(item => item.sessionId)).toEqual(['a', 'b'])
    expect(first.nextCursor).toBe('b')
    expect((await importer.preview({ projectId: project, after: first.nextCursor! })).items.map(item => item.sessionId)).toEqual(['c'])
    const job = await importer.start(project, [SessionId('a')]); await importer.flush()
    expect((await importer.status(project, job.id))?.status).toBe('done')
    expect(f.db.prepare('SELECT committed_to FROM sessions WHERE id=?').get('a')?.committed_to).toBe(0)
  } finally { await importer.close(); f.db.close() }
})

it('linearizes worker-local active registration against cleanup and restores admission decisions', () => {
  const f = setup()
  try {
    f.session('active')
    f.store.setActive(project, SessionId('active'), true)
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 }).deletedSessions).toBe(0)
    f.store.setActive(project, SessionId('active'), false)
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 }).deletedSessions).toBe(1)
    expect(f.store.listAdmissions(project)).toEqual([{ sessionId: 'active', status: 'cleaned' }])
    f.store.startImport(project, [{ sessionId: SessionId('active'), targetTo: 1 }])
    expect(f.store.listAdmissions(project)).toEqual([{ sessionId: 'active', status: 'admitted' }])
  } finally { f.db.close() }
})

it('recovers import checkpoints and cleaned exclusions after closing and reopening the SQLite file', async () => {
  const parent = await memoryPath(resolve(import.meta.dirname, '../.tmp/maintenance'))
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'restart-'))
  const path = join(root, 'memory.sqlite')
  let db: DatabaseSync | undefined
  try {
    const f = setup(path); db = f.db
    const job = f.store.startImport(project, [{ sessionId: SessionId('partial'), targetTo: 2 }])
    f.session('partial'); f.store.checkpointImport(project, job.id, SessionId('partial'), 1)
    f.session('deleted'); f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })
    db.close(); db = new DatabaseSync(path)
    const reopened = new MaintenanceStore(db, () => {})
    expect(reopened.listImports(project)[0]?.items[0]).toMatchObject({ committedTo: 1, targetTo: 2, status: 'running' })
    expect(reopened.admitted(project, SessionId('partial'))).toBe(true)
    expect(reopened.tombstoned(project, SessionId('deleted'))).toBe(true)
    expect(reopened.cleanupStatus(project)?.deletedSessions).toBe(1)
  } finally { db?.close(); await memoryPath(root); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

it('removes completed jobs and receipts with deleted input references so task readers still hydrate safely', () => {
  const f = setup()
  try {
    f.session('source'); f.l1('episode', 'source'); f.knowledge('retired', ['episode'], 'invalidated')
    f.db.prepare(`UPDATE knowledge_versions SET operation_id='completed-job' WHERE id='retired'`).run()
    const body = { operationId: 'completed-job', input: { projectId: project, level: 'L2', sources: [{ id: 'episode', revision: 1 }], existing: [] },
      config: resolveKnowledgeConfig({ provider: 'test', model: 'test' }), status: 'done', attempts: 1, calls: 1, nextRetryAt: 0, failure: null,
      candidates: null, result: [{ id: 'retired', revision: 1 }], owner: null, leaseUntil: 0 }
    f.db.prepare('INSERT INTO knowledge_tasks VALUES (?,?,?)').run('completed-job', project, JSON.stringify(body))
    f.db.prepare('INSERT INTO knowledge_operations VALUES (?,?,?)').run('completed-job', JSON.stringify({ project, ref: { id: 'retired', revision: 1 } }), 'null')
    f.db.prepare('INSERT INTO knowledge_operations VALUES (?,?,?)').run('invalidation', JSON.stringify({ project, ref: { id: 'episode', revision: 1 } }), 'null')
    const knowledge = new KnowledgeStore(f.db, new L1Store(f.db, () => {}), () => {})
    expect(knowledge.getTask(project, 'completed-job' as OperationId)?.input.sources[0]?.id).toBe('episode')
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 }).deletedSessions).toBe(1)
    expect(knowledge.getTask(project, 'completed-job' as OperationId)).toBeNull()
    expect(knowledge.listTasks(project)).toEqual([])
    expect(f.db.prepare('SELECT id FROM knowledge_operations').all()).toEqual([])
    expect(f.db.prepare('SELECT id FROM knowledge_versions').all()).toEqual([])
  } finally { f.db.close() }
})

it('retains model request journals for current ancestry, granted history and unfinished tasks', () => {
  const f = setup()
  try {
    f.session('source'); f.l1('episode', 'source'); f.knowledge('current', ['episode'])
    f.session('retry'); f.l1('failed-episode', 'retry', 'failed')
    f.session('shared-source'); f.l1('shared-episode', 'shared-source'); f.knowledge('shared', ['shared-episode'], 'superseded')
    f.db.prepare(`INSERT INTO knowledge_share_actions VALUES ('approval','receipt','{}')`).run()
    f.db.prepare(`INSERT INTO knowledge_grants VALUES ('shared',1,'approval')`).run()
    for (const [id, operation] of [['source-journal', 'task-episode'], ['current-journal', 'op-current'],
      ['retry-journal', 'task-failed-episode'], ['shared-journal', 'op-shared'], ['shared-source-journal', 'task-shared-episode'], ['unused-journal', 'unneeded-operation']]) {
      f.session(id!)
      f.db.prepare('UPDATE events SET body=? WHERE session_id=?').run(JSON.stringify({ type: 'memory/extraction-request', seq: 0, time: 1, data: { operationId: operation } }), id!)
    }
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toMatchObject({ deletedSessions: 1, protectedSessions: 8 })
    expect(f.db.prepare('SELECT 1 FROM sessions WHERE id=?').get('unused-journal')).toBeUndefined()
    expect(f.db.prepare('SELECT id FROM sessions WHERE id LIKE ? ORDER BY id').all('%journal').map(row => row.id)).toEqual(
      ['current-journal', 'retry-journal', 'shared-journal', 'shared-source-journal', 'source-journal'])
  } finally { f.db.close() }
})

it('keeps frozen completed-task context for a retained version and rejects malformed or unsafe retention ages', () => {
  const f = setup()
  try {
    f.session('source'); f.l1('episode', 'source'); f.knowledge('current', ['episode'])
    f.session('context'); f.l1('context-episode', 'context'); f.knowledge('retired-context', ['context-episode'], 'superseded')
    f.db.prepare('INSERT INTO knowledge_tasks VALUES (?,?,?)').run('op-current', project,
      JSON.stringify({ status: 'done', input: { sources: [{ id: 'episode', revision: 1 }], existing: [{ id: 'retired-context', revision: 1 }] } }))
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 }).deletedSessions).toBe(0)
    for (const maxAgeDays of [0, -1, 1.5, NaN, Infinity, Math.floor(Number.MAX_SAFE_INTEGER / day) + 1]) {
      expect(() => f.store.cleanupPreview(project, { maxAgeDays, now: day * 2 })).toThrow('retention age')
      expect(() => f.store.cleanup(project, { maxAgeDays, now: day * 2 })).toThrow('retention age')
    }
    expect(f.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(2)
  } finally { f.db.close() }
})

it('validates already-copied source metadata before reporting repeated imports as complete', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    const source = { header: { ...header('source'), isSeeded: true }, events: events(2), inherited: 1 }
    f.records.set('source', source)
    const first = await importer.start(project, [SessionId('source')]); await importer.flush()
    expect((await importer.status(project, first.id))?.status).toBe('done')
    source.header = { ...source.header, createdAt: 2 }
    const changedHeader = await importer.start(project, [SessionId('source')]); await importer.flush()
    expect((await importer.status(project, changedHeader.id))?.items[0]).toMatchObject({ status: 'failed', failure: 'conflict' })
    source.header = { ...source.header, createdAt: 1 }; source.inherited = 2
    const changedFork = await importer.start(project, [SessionId('source')]); await importer.flush()
    expect((await importer.status(project, changedFork.id))?.items[0]).toMatchObject({ status: 'failed', failure: 'conflict' })
    source.inherited = 1
    const repeated = await importer.start(project, [SessionId('source')]); await importer.flush()
    expect((await importer.status(project, repeated.id))?.items[0]).toMatchObject({ committedTo: 2, status: 'done' })
    expect(f.db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(2)
  } finally { await importer.close(); f.db.close() }
})

it('records missing and unsupported selected sources individually while importing valid sources without admitting failures', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    f.records.set('unsupported', { header: header('unsupported'), events: events(1), inherited: 0, needsMigration: true })
    f.records.set('valid', { header: header('valid'), events: events(2), inherited: 0 })
    const job = await importer.start(project, [SessionId('missing'), SessionId('unsupported'), SessionId('valid')]); await importer.flush()
    expect((await importer.status(project, job.id))?.items).toEqual([
      { sessionId: 'missing', targetTo: 0, committedTo: 0, status: 'failed', failure: 'source' },
      { sessionId: 'unsupported', targetTo: 0, committedTo: 0, status: 'failed', failure: 'schema' },
      { sessionId: 'valid', targetTo: 2, committedTo: 2, status: 'done', failure: null },
    ])
    expect(f.store.listAdmissions(project)).toEqual([{ sessionId: 'valid', status: 'admitted' }])
    expect(f.db.prepare('SELECT id FROM sessions').all().map(row => row.id)).toEqual(['valid'])
    const unavailableOnly = await importer.start(project, [SessionId('missing')]); await importer.flush()
    expect((await importer.status(project, unavailableOnly.id))?.status).toBe('done')
  } finally { await importer.close(); f.db.close() }
})

it('preserves a cleaned exclusion when explicit reimport cannot verify its source', () => {
  const f = setup()
  try {
    f.session('source'); f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })
    const job = f.store.startImport(project, [{ sessionId: SessionId('source'), targetTo: 0, failure: 'source' }])
    expect(job.items[0]).toMatchObject({ status: 'failed', failure: 'source' })
    expect(f.store.tombstoned(project, SessionId('source'))).toBe(true)
    expect(f.store.admitted(project, SessionId('source'))).toBe(false)
  } finally { f.db.close() }
})

it('rejects a cleaned Session owner conflict before central or workspace service writes reach another provider', async () => {
  const item = await fixture()
  const ctxCentral = new Context(); const ctxWorkspace = new Context()
  let second: SqliteBackend | undefined
  try {
    const first = await item.open()
    const owner = item.spec.projectId; const other = 'other-project' as ProjectId
    second = await SqliteBackend.open({ ...item.spec, projectId: other, databasePath: join(item.root, 'other.sqlite') })
    const meta = header('owned')
    const request = { projectId: owner, header: meta, inheritedEventCount: SessionLogOffset(0), events: events(1) }
    await first.appendRaw(request)
    const central = new MemoryService(ctxCentral, first, undefined, () => {}, item.spec.browser)
    await first.maintenance.cleanup(owner, { maxAgeDays: 1, now: day * 2 })
    expect(first.getSessionProject(meta.id)).toBe(owner)
    await expect(central.appendRaw({ ...request, projectId: other })).rejects.toMatchObject({ code: 'conflict' })
    await expect(first.appendRaw({ ...request, projectId: other })).rejects.toMatchObject({ code: 'conflict' })
    await expect(first.appendRaw(request)).rejects.toMatchObject({ code: 'excluded' })
    const otherProvider = second
    const routes: MemoryRoutes = { workspaceBound: () => true, accepts: () => true, admit: vi.fn(), refreshAdmissions: async () => {},
      get: () => ({ provider: otherProvider }), projectOfSession: id => id === meta.id ? owner : undefined }
    const workspace = new MemoryService(ctxWorkspace, first, undefined, () => {}, item.spec.browser, undefined, undefined, routes)
    const writes = vi.spyOn(second, 'appendRaw')
    await expect(workspace.appendRaw({ ...request, projectId: other })).rejects.toMatchObject({ code: 'conflict' })
    await expect(workspace.importHistory(other, [meta.id])).rejects.toMatchObject({ code: 'conflict' })
    expect(writes).not.toHaveBeenCalled()
    expect(second.getSessionProject(meta.id)).toBeUndefined()
    first.maintenance.startImport(owner, [{ sessionId: meta.id, targetTo: 1 }])
    await expect(first.appendRaw(request)).resolves.toMatchObject({ committedTo: 1 })
  } finally { await ctxCentral.fiber.dispose(); await ctxWorkspace.fiber.dispose(); await second?.close(); await item.close() }
})

it('keeps immutable project ownership for cleaned sources in the real Workspace route cache across restart', async () => {
  const item = await fixture(); const ctx = new Context()
  let routes = new WorkspaceMemory(ctx, { ...item.spec, projectId: project, storageMode: 'workspace', dataRoot: item.root }, 100, () => {})
  try {
    await routes.recover()
    const provider = routes.get(project).provider
    const meta = header('historical')
    const task = await provider.maintenance.startImport(project, [{ sessionId: meta.id, targetTo: 1 }])
    await provider.appendRaw({ projectId: project, header: meta, inheritedEventCount: SessionLogOffset(0), events: events(1) })
    await provider.maintenance.cancelImport(project, task.id)
    await routes.refreshAdmissions(project)
    expect(routes.accepts({ header: meta })).toBe(true)
    await provider.maintenance.cleanup(project, { maxAgeDays: 1, now: day * 2 })
    await routes.refreshAdmissions(project)
    expect(routes.projectOfSession(meta.id)).toBe(project)
    expect(routes.accepts({ header: meta })).toBe(false)
    expect(() => routes.admit('other-project' as ProjectId, meta.id)).toThrow('more than one memory project')
    await routes.close()
    routes = new WorkspaceMemory(ctx, { ...item.spec, projectId: project, storageMode: 'workspace', dataRoot: item.root }, 100, () => {})
    await routes.recover()
    expect(routes.projectOfSession(meta.id)).toBe(project)
    expect(routes.accepts({ header: meta })).toBe(false)
    expect(() => routes.admit('other-project' as ProjectId, meta.id)).toThrow('more than one memory project')
  } finally { await routes.close(); await ctx.fiber.dispose(); await item.close() }
})

it('retains the unloaded conversation holding pending selections until those references are cleared', () => {
  const f = setup()
  try {
    f.session('waiting'); f.session('evidence'); f.l1('selected', 'evidence')
    f.db.prepare(`INSERT INTO memory_selections VALUES ('waiting',?,'token',?,0)`).run(project, JSON.stringify([{ id: 'selected', revision: 1 }]))
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toMatchObject({ deletedSessions: 0, protectedSessions: 2 })
    expect(f.db.prepare('SELECT token FROM memory_selections WHERE session_id=?').get('waiting')?.token).toBe('token')
    f.db.prepare(`UPDATE memory_selections SET refs='[]' WHERE session_id='waiting'`).run()
    expect(f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 }).deletedSessions).toBe(2)
  } finally { f.db.close() }
})

it('refuses cleanup when durable pending references are malformed', () => {
  const f = setup()
  try {
    f.session('waiting')
    f.db.prepare(`INSERT INTO memory_selections VALUES ('waiting',?,'token','[]',0)`).run(project)
    for (const refs of ['{}', '[{}]', '[{"id":"memory","revision":0}]', '[{"id":" ","revision":1}]']) {
      f.db.prepare(`UPDATE memory_selections SET refs=? WHERE session_id='waiting'`).run(refs)
      expect(() => f.store.cleanup(project, { maxAgeDays: 1, now: day * 2 })).toThrow('selection references')
      expect(f.store.tombstoned(project, SessionId('waiting'))).toBe(false)
    }
  } finally { f.db.close() }
})

it('refreshes central exclusion after manual cleanup and restores it before service publication on restart', async () => {
  const item = await fixture(); const firstContext = new Context(); const restoredContext = new Context()
  let restored: SqliteBackend | undefined
  try {
    await firstContext.plugin(SessionStore); await restoredContext.plugin(SessionStore)
    const provider = await item.open()
    const excluded = new Set<string>()
    const policy = { accepts: (session: { header: SessionHeader }) => !excluded.has(session.header.id), refreshAdmissions: async (owner: ProjectId) => {
      for (const item of provider.maintenance.listAdmissions(owner)) if (item.status === 'cleaned') excluded.add(item.sessionId)
    } }
    const service = new MemoryService(firstContext, provider, undefined, () => {}, item.spec.browser, undefined, undefined, undefined, policy)
    const request = { projectId: item.spec.projectId, header: header('central-source'), inheritedEventCount: SessionLogOffset(0), events: events(1) }
    await service.appendRaw(request)
    await service.cleanup(item.spec.projectId, { maxAgeDays: 1, now: day * 2 })
    expect(service.acceptsSession({ header: request.header })).toBe(false)
    const writes = vi.spyOn(provider, 'appendRaw')
    await expect(service.appendRaw(request)).rejects.toMatchObject({ code: 'excluded' })
    expect(writes).not.toHaveBeenCalled()
    await provider.close(); restored = await SqliteBackend.open(item.spec)
    const restoredExcluded = new Set(restored.maintenance.listAdmissions(item.spec.projectId).filter(item => item.status === 'cleaned').map(item => item.sessionId))
    const restoredPolicy = { accepts: (session: { header: SessionHeader }) => !restoredExcluded.has(session.header.id), refreshAdmissions: async () => {} }
    const restarted = new MemoryService(restoredContext, restored, undefined, () => {}, item.spec.browser, undefined, undefined, undefined, restoredPolicy)
    expect(restarted.acceptsSession({ header: request.header })).toBe(false)
    await expect(restarted.appendRaw(request)).rejects.toMatchObject({ code: 'excluded' })
  } finally { await firstContext.fiber.dispose(); await restoredContext.fiber.dispose(); await restored?.close(); await item.close() }
})

it('recovers an acknowledged durable prefix after a lost checkpoint without replaying committed event writes', async () => {
  const f = importFixture(); const importer = f.create(true)
  try {
    const meta = header('recovered')
    f.records.set(meta.id, { header: meta, events: events(2), inherited: 0 })
    const task = f.store.startImport(project, [{ sessionId: meta.id, targetTo: 2 }])
    await f.memory.appendRaw({ projectId: project, header: meta, inheritedEventCount: SessionLogOffset(0), events: events(2) })
    expect(f.store.getImport(project, task.id)?.items[0]?.committedTo).toBe(0)
    const writes = vi.spyOn(f.memory, 'appendRaw')
    await importer.resume(project); await importer.flush()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(writes.mock.calls[0]?.[0].events).toEqual([])
    expect(f.readLengths).toEqual([])
    expect((await importer.status(project, task.id))?.items[0]).toMatchObject({ committedTo: 2, status: 'done' })
    expect(f.committed).toHaveBeenCalledExactlyOnceWith(project)
    expect(f.db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(2)
  } finally { await importer.close(); f.db.close() }
})

it('previews copied unknown-count sources with only a bounded tail, and detects subsequent growth', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    const record = { header: header('unknown-count'), events: events(3), inherited: 0, omitCount: true }
    f.records.set(record.header.id, record)
    expect((await importer.preview({ projectId: project })).items[0]?.status).toBe('available')
    expect(f.readRequests).toEqual([])
    expect(f.closed).not.toHaveBeenCalled()
    await importer.start(project, [record.header.id]); await importer.flush()
    f.readRequests.length = 0; f.closed.mockClear()
    const writes = vi.spyOn(f.memory, 'appendRaw')
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ eventCount: null, status: 'imported' })
    expect(f.readRequests).toEqual([{ offset: 2, length: 1 }, { offset: 3, length: 1 }])
    expect(f.closed).toHaveBeenCalledTimes(1)
    record.events.push(events(4)[3]!)
    expect((await importer.preview({ projectId: project })).items[0]?.status).toBe('available')
    expect(f.readRequests).toEqual([{ offset: 2, length: 1 }, { offset: 3, length: 1 }, { offset: 2, length: 1 }, { offset: 3, length: 1 }])
    expect(f.closed).toHaveBeenCalledTimes(2)
    expect(writes).not.toHaveBeenCalled()
  } finally { await importer.close(); f.db.close() }
})

it('reports truncated, missing and unreadable copied unknown-count sources without pretending they are imported', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    const record = { header: header('unknown-count'), events: events(3), inherited: 0, omitCount: true, missing: false, readFailure: false }
    f.records.set(record.header.id, record)
    await importer.start(project, [record.header.id]); await importer.flush()
    f.readRequests.length = 0; f.closed.mockClear()
    record.events = events(1)
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ status: 'unsupported', reason: 'source' })
    expect(f.readRequests).toEqual([{ offset: 2, length: 1 }])
    expect(f.closed).toHaveBeenCalledTimes(1)
    record.missing = true
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ status: 'unsupported', reason: 'source' })
    expect(f.closed).toHaveBeenCalledTimes(1)
    record.missing = false; record.events = events(3); record.readFailure = true
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ status: 'unsupported', reason: 'source' })
    expect(f.closed).toHaveBeenCalledTimes(2)
    expect(f.readRequests.every(request => request.length === 1)).toBe(true)
  } finally { await importer.close(); f.db.close() }
})

it('recognizes copied empty unknown-count sources with one EOF read', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    const meta = header('empty-count')
    f.records.set(meta.id, { header: meta, events: [], inherited: 0, omitCount: true })
    await importer.start(project, [meta.id]); await importer.flush()
    f.readRequests.length = 0; f.closed.mockClear()
    expect((await importer.preview({ projectId: project })).items[0]?.status).toBe('imported')
    expect(f.readRequests).toEqual([{ offset: 0, length: 1 }])
    expect(f.closed).toHaveBeenCalledTimes(1)
  } finally { await importer.close(); f.db.close() }
})

it('refuses unknown-count preview completion when the returned tail positions do not match the captured prefix', async () => {
  const f = importFixture(); const importer = f.create(false)
  try {
    const record = { header: header('unknown-count'), events: events(3), inherited: 0, omitCount: true }
    f.records.set(record.header.id, record)
    await importer.start(project, [record.header.id]); await importer.flush()
    f.readRequests.length = 0; f.closed.mockClear()
    record.events[2] = { ...events(3)[2]!, seq: SessionSeq(5) }
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ status: 'unsupported', reason: 'source' })
    expect(f.readRequests).toEqual([{ offset: 2, length: 1 }])
    record.events = [...events(3), { ...events(4)[3]!, seq: SessionSeq(5) }]
    expect((await importer.preview({ projectId: project })).items[0]).toMatchObject({ status: 'unsupported', reason: 'source' })
    expect(f.readRequests).toEqual([{ offset: 2, length: 1 }, { offset: 2, length: 1 }, { offset: 3, length: 1 }])
    expect(f.closed).toHaveBeenCalledTimes(2)
  } finally { await importer.close(); f.db.close() }
})
