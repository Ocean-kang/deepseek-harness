/** Actual source-entry workers, durable restart, byte pages and host callback responsiveness. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SqliteMemory, StorageWorker, SCHEMA_VERSION } from '../src/sqlite.ts'
import { SqliteMemory as Backend } from '../src/sqlite-backend.ts'
import { batch, fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import { candidate } from './l1-fixtures.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import type { TraceCursor } from '../src/l1-types.ts'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

async function setup() {
  const item = await fixture()
  resources.push(() => item.close())
  return item
}
async function asynchronous(item: Awaited<ReturnType<typeof fixture>>) {
  const memory = await SqliteMemory.open(item.spec)
  resources.push(() => memory.close())
  return memory
}

it('boots the real source worker, upgrades schema 5 and restores the same raw events after restart', async () => {
  const item = await setup()
  const backend = await item.open()
  const events = turnEvents()
  await backend.appendRaw(batch(item.spec, events))
  await backend.close()
  const legacy = new DatabaseSync(item.spec.databasePath)
  try {
    legacy.exec('DROP TABLE l1_trace_chunks; DROP TABLE l1_summary_projections; DROP TABLE l1_candidate_projections; DROP TABLE memory_imports; DROP TABLE memory_admissions; DROP TABLE memory_cleanup_runs; PRAGMA user_version = 5')
  } finally { legacy.close() }
  const memory = await asynchronous(item)
  expect(await memory.listProjects()).toEqual([item.spec.projectId])
  expect((await memory.readRaw({ projectId: item.spec.projectId, sessionId: header().id,
    from: SessionLogOffset(0), to: SessionLogOffset(events.length), limit: 10 })).events).toEqual(events)
  await memory.close()
  const inspect = new DatabaseSync(item.spec.databasePath)
  try { expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION) } finally { inspect.close() }
  const reopened = await asynchronous(item)
  expect(await reopened.getSessionProject(header().id)).toBe(item.spec.projectId)
  expect((await reopened.appendRaw(batch(item.spec, events))).duplicates).toBe(events.length)
})

it('returns byte-bounded raw pages while allowing one oversized original event without truncation', async () => {
  const item = await setup()
  const memory = await asynchronous({ ...item, spec: { ...item.spec, pageMaxBytes: 2500 } })
  const base = turnEvents()
  const events: SessionEvent[] = [base[0]!]
  for (let seq = 1; seq <= 30; seq++) events.push({ type: 'user/message', seq: SessionSeq(seq), time: seq + 1,
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '🧪'.repeat(seq === 15 ? 3000 : 256) }] }), surfaceOp: 'append' })
  events.push({ ...base[2]!, seq: SessionSeq(events.length), time: events.length + 1 })
  await memory.appendRaw(batch(item.spec, events))
  let cursor = SessionLogOffset(0)
  const observed: SessionEvent[] = []
  let oversized = 0
  do {
    const page = await memory.readRaw({ projectId: item.spec.projectId, sessionId: header().id,
      from: SessionLogOffset(0), to: SessionLogOffset(events.length), cursor, limit: 100, maxBytes: 2500 })
    const bytes = page.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
    if (bytes > 2500) { expect(page.events).toHaveLength(1); oversized++ }
    observed.push(...page.events)
    if (page.nextCursor === null) break
    expect(page.nextCursor).toBeGreaterThan(cursor)
    cursor = page.nextCursor
  } while (true)
  expect(observed).toEqual(events)
  expect(oversized).toBe(1)
  let after: { sessionId: SessionId; seq: number } | null = null
  const browsed: SessionEvent[] = []
  do {
    const page = await memory.browseRaw(item.spec.projectId, after, 100, '')
    const bytes = page.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.event)), 0)
    if (bytes > 2500) expect(page.rows).toHaveLength(1)
    browsed.push(...page.rows.map(row => row.event))
    after = page.nextCursor
  } while (after !== null)
  expect(browsed).toEqual(events)
})

it('backfills a schema 5 large inline trace once without rewriting its immutable summary or candidate', async () => {
  const item = await setup()
  const backend = await item.open()
  await backend.appendRaw(batch(item.spec, turnEvents()))
  backend.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 2)
  const task = backend.l1.claim(item.spec.projectId, header().id, 'migration', Date.now())!
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('fixture')
  const trace = { actions: [], commands: [], files: ['🧪'.repeat(32768)], errors: [] }
  const legacySummary = JSON.stringify({ ...value.summary, trace })
  const legacyCandidate = JSON.stringify({ kind: 'memory', summary: JSON.parse(legacySummary) })
  backend.l1.prepare(item.spec.projectId, task.operationId, 'migration', { ...value, summary: { ...value.summary, trace } })
  const ref = backend.l1.commitMemory(item.spec.projectId, task.operationId, 'migration', Date.now())!
  await backend.close()
  const legacy = new DatabaseSync(item.spec.databasePath)
  try {
    legacy.prepare('UPDATE l1_memories SET summary = ? WHERE id = ? AND revision = ?').run(legacySummary, ref.id, ref.revision)
    legacy.prepare('UPDATE l1_tasks SET candidate = ? WHERE id = ?').run(legacyCandidate, task.operationId)
    legacy.exec('DROP TABLE l1_trace_chunks; DROP TABLE l1_summary_projections; DROP TABLE l1_candidate_projections; DROP TABLE memory_imports; DROP TABLE memory_admissions; DROP TABLE memory_cleanup_runs; PRAGMA user_version = 5')
  } finally { legacy.close() }
  const memory = await asynchronous(item)
  const migrated = new DatabaseSync(item.spec.databasePath)
  try {
    expect(migrated.prepare('SELECT 1 FROM l1_summary_projections WHERE memory_id = ? AND revision = ?').get(ref.id, ref.revision)).toBeDefined()
    expect(migrated.prepare('SELECT 1 FROM l1_candidate_projections WHERE operation_id = ?').get(task.operationId)).toBeDefined()
    expect(migrated.prepare('SELECT count(*) AS count FROM l1_trace_chunks WHERE memory_id = ? AND revision = ?').get(ref.id, ref.revision)?.count).toBeGreaterThan(1)
  } finally { migrated.close() }
  expect((await memory.l1.getMemory(item.spec.projectId, ref))?.summary.trace).toBeUndefined()
  expect((await memory.l1.getTask(item.spec.projectId, task.operationId))?.candidate).toEqual(value)
  let cursor: TraceCursor | undefined
  let text = ''
  do {
    const page = await memory.l1.readTrace(item.spec.projectId, ref, cursor, 4096)
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(4096)
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    text += page.text
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  expect(JSON.parse(text)).toEqual(trace)
  const inspect = new DatabaseSync(item.spec.databasePath)
  try {
    expect(inspect.prepare('SELECT summary FROM l1_memories WHERE id = ? AND revision = ?').get(ref.id, ref.revision)?.summary).toBe(legacySummary)
    expect(inspect.prepare('SELECT candidate FROM l1_tasks WHERE id = ?').get(task.operationId)?.candidate).toBe(legacyCandidate)
    expect(inspect.prepare('SELECT length(summary) AS size FROM l1_summary_projections WHERE memory_id = ? AND revision = ?').get(ref.id, ref.revision)?.size).toBeLessThan(1024)
  } finally { inspect.close() }
})

it('keeps host callbacks responsive while an append contends on another connection', async () => {
  const item = await setup()
  const memory = await asynchronous(item)
  await memory.appendRaw(batch(item.spec, []))
  const blocker = new DatabaseSync(item.spec.databasePath)
  let locked = true
  blocker.exec('BEGIN IMMEDIATE')
  const started = performance.now()
  let settled = false
  const append = memory.appendRaw(batch(item.spec, turnEvents())).finally(() => { settled = true })
  // The request is queued before this host callback; a synchronous SQLite call prevents its release.
  await Promise.resolve()
  const callback = new Promise<{ delayMs: number; settledAtCallback: boolean }>((resolve, reject) => setImmediate(() => {
    const settledAtCallback = settled
    try { blocker.exec('ROLLBACK'); locked = false } catch (error) { reject(error); return }
    resolve({ delayMs: performance.now() - started, settledAtCallback })
  }))
  try {
    const { delayMs, settledAtCallback } = await callback
    expect(settledAtCallback).toBe(false)
    expect((await append).inserted).toBe(3)
    console.info('Async SQLite callback delay', JSON.stringify({ delayMs: Math.round(delayMs), busyTimeoutMs: item.spec.busyTimeoutMs }))
  } finally {
    if (locked) blocker.exec('ROLLBACK')
    blocker.close()
    await append.catch(() => undefined)
  }
})

it('shows the synchronous backend baseline blocking the callback until contention fails', async () => {
  const item = await setup()
  const memory = await Backend.open({ ...item.spec, busyTimeoutMs: 80 })
  resources.push(() => memory.close())
  await memory.appendRaw(batch(item.spec, []))
  const blocker = new DatabaseSync(item.spec.databasePath)
  blocker.exec('BEGIN IMMEDIATE')
  let settled = false
  const started = performance.now()
  const callback = new Promise<{ delayMs: number; settledAtCallback: boolean }>((resolve, reject) => setImmediate(() => {
    const settledAtCallback = settled
    try { blocker.exec('ROLLBACK') } catch (error) { reject(error); return }
    resolve({ delayMs: performance.now() - started, settledAtCallback })
  }))
  try {
    await expect(memory.appendRaw(batch(item.spec, turnEvents())).finally(() => { settled = true })).rejects.toMatchObject({ errcode: 5 })
    const { delayMs, settledAtCallback } = await callback
    expect(settledAtCallback).toBe(true)
    console.info('Synchronous SQLite callback delay', JSON.stringify({ delayMs: Math.round(delayMs), busyTimeoutMs: 80 }))
  } finally { await callback; blocker.close() }
})

it('drains queued work before ordinary close and keeps a shared worker available to another database', async () => {
  const item = await setup()
  const second = await setup()
  const worker = new StorageWorker(item.spec)
  resources.push(() => worker.close())
  const first = await SqliteMemory.open(item.spec, worker)
  resources.push(() => first.close())
  const other = await SqliteMemory.open(second.spec, worker)
  resources.push(() => other.close())
  const append = first.appendRaw(batch(item.spec, turnEvents()))
  const closing = first.close()
  expect((await append).inserted).toBe(3)
  await closing
  await first.close()
  await expect(first.listProjects()).rejects.toMatchObject({ code: 'closed' })
  expect((await other.appendRaw(batch(second.spec, turnEvents()))).inserted).toBe(3)
  await other.close()
  await worker.close()
})

it('reports an unconfirmed write after a malformed worker response and inspects the durable prefix without replaying it', async () => {
  const item = await setup()
  const owner = new StorageWorker(item.spec)
  resources.push(() => owner.close())
  const memory = await SqliteMemory.open(item.spec, owner)
  const thread: unknown = Object.getOwnPropertyDescriptor(owner, 'worker')?.value
  if (!(thread instanceof Worker)) throw new Error('Owned storage thread is unavailable')
  const events = turnEvents()
  const pending = memory.appendRaw(batch(item.spec, events))
  const failure = expect(pending).rejects.toMatchObject({ code: 'unknown-outcome' })
  await Promise.resolve()
  thread.emit('message', { kind: 'malformed' })
  await failure
  await expect(memory.close()).rejects.toMatchObject({ code: 'closed' })
  await owner.close()
  const reopened = await asynchronous(item)
  const observed = await reopened.readRaw({ projectId: item.spec.projectId, sessionId: header().id,
    from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 3 })
  expect([0, 3]).toContain(observed.committedTo)
  expect(observed.events).toEqual(events.slice(0, observed.committedTo))
})

it('drains a saturated worker queue before closing its database', async () => {
  const item = await setup()
  const memory = await asynchronous({ ...item, spec: { ...item.spec, storageQueueCapacity: 1 } })
  const events = turnEvents()
  const blocker = new DatabaseSync(item.spec.databasePath)
  blocker.exec('BEGIN IMMEDIATE')
  try {
    const pending = memory.appendRaw(batch(item.spec, events))
    await Promise.resolve()
    const closing = memory.close()
    blocker.exec('ROLLBACK')
    expect((await pending).inserted).toBe(3)
    await closing
  } finally { blocker.close() }
  const reopened = await asynchronous(item)
  expect((await reopened.readRaw({ projectId: item.spec.projectId, sessionId: header().id,
    from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 3 })).events).toEqual(events)
})
