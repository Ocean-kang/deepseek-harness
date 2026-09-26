/** Atomic discovery, version migration and extraction recovery against real SQLite. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { resolveL1Config } from '../src/l1-config.ts'
import { SqliteMemory } from '../src/sqlite.ts'
import { batch, fixture, header } from './helpers.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import type { ProjectId } from '../src/types.ts'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })
const config = resolveL1Config({ provider: 'test', model: 'test' })

async function setup() {
  const item = await fixture()
  owned.push(item)
  const provider = await item.open()
  return { ...item, provider, project: item.spec.projectId }
}

it('waits for committed end events and resumes a split scan without duplicate tasks', async () => {
  const { provider, project, spec, open } = await setup()
  const events = turnEvents()
  await provider.appendRaw(batch(spec, events.slice(0, 2)))
  expect(provider.scanTurns(project, config, 1)).toBe(0)
  expect(provider.l1.listTasks(project, '', 10)).toEqual([])
  await provider.close()
  const recovered = await open()
  await recovered.appendRaw(batch(spec, events.slice(2)))
  expect(recovered.scanTurns(project, config, 1)).toBe(1)
  await recovered.appendRaw(batch(spec, events))
  expect(recovered.scanTurns(project, config, 1)).toBe(0)
  expect(recovered.l1.listTasks(project, '', 10)).toMatchObject([{ from: 0, to: 3, turn: 1, status: 'pending', config }])
})

it('rolls back the scan checkpoint when task insertion fails', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  const db = new DatabaseSync(spec.databasePath)
  try {
    db.exec("CREATE TRIGGER reject_task BEFORE INSERT ON l1_tasks BEGIN SELECT RAISE(ABORT, 'test'); END")
    expect(() => provider.scanTurns(project, config, 20)).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM l1_scans').get()?.n).toBe(0)
    db.exec('DROP TRIGGER reject_task')
    expect(provider.scanTurns(project, config, 20)).toBe(1)
  } finally { db.close() }
})

it('rejects missing committed events rather than advancing the scan', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  const db = new DatabaseSync(spec.databasePath)
  try { db.exec('DELETE FROM events WHERE seq = 1') } finally { db.close() }
  expect(() => provider.scanTurns(project, config, 20)).toThrow(/missing/)
  expect(provider.l1.cursor(project, header().id)).toBe(0)
})

it('omits fully inherited turns but retains a turn ending after the fork boundary', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw({ ...batch(spec, turnEvents()), inheritedEventCount: SessionLogOffset(3) })
  expect(provider.scanTurns(project, config, 1)).toBe(0)
  const second = { ...header('fork'), isSeeded: true }
  await provider.appendRaw({ ...batch(spec, turnEvents()), header: second, inheritedEventCount: SessionLogOffset(2) })
  expect(provider.scanTurns(project, config, 1)).toBe(1)
  expect(provider.l1.listTasks(project, '', 10)[0]?.sessionId).toBe(second.id)
})

it('keeps candidates through commit failure and recovers the exact operation after reopen', async () => {
  const { provider, project, spec, open } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  provider.scanTurns(project, config, 2)
  const task = provider.l1.claim(project, header().id, 'worker', 100)!
  provider.l1.prepare(project, task.operationId, 'worker', candidate(task))
  const db = new DatabaseSync(spec.databasePath)
  try {
    db.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON l1_memories BEGIN SELECT RAISE(ABORT, 'test'); END")
    expect(() => provider.l1.commitMemory(project, task.operationId, 'worker', 110)).toThrow()
    expect(provider.l1.getTask(project, task.operationId)?.status).toBe('prepared')
    expect(provider.l1.byOperation(project, task.operationId)).toBeNull()
    db.exec('DROP TRIGGER reject_memory')
  } finally { db.close() }
  await provider.close()
  const recovered = await open()
  expect(recovered.l1.claim(project, header().id, 'restarted', 101)).toBeNull()
  const resumed = recovered.l1.claim(project, header().id, 'restarted', task.leaseUntil + 1)!
  expect(resumed.candidate).toEqual(candidate(task))
  const memory = recovered.l1.commitMemory(project, task.operationId, 'restarted', task.leaseUntil + 2)!
  expect(memory).toMatchObject({ revision: 1, state: 'active', operationId: task.operationId })
  expect(recovered.l1.commitMemory(project, task.operationId, 'any', 999)).toEqual(memory)
  expect(recovered.l1.listTasks(project, '', 10)[0]?.status).toBe('done')
})

it('isolates projects and preserves old versions after an explicit re-extraction', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  provider.scanTurns(project, config, 2)
  const first = provider.l1.claim(project, header().id, 'worker', 0)!
  provider.l1.prepare(project, first.operationId, 'worker', candidate(first))
  const memory = provider.l1.commitMemory(project, first.operationId, 'worker', 1)!
  const other = 'other' as ProjectId
  expect(provider.l1.getMemory(other, memory)).toBeNull()
  expect(provider.l1.getTask(other, first.operationId)).toBeNull()
  expect(provider.l1.listTasks(other, '', 10)).toEqual([])
  const next = provider.l1.rerun(project, first.operationId, 'reextract', config)
  expect(next).not.toBe(first.operationId)
  const claimed = provider.l1.claim(project, header().id, 'worker', 2)!
  provider.l1.prepare(project, next, 'worker', candidate(claimed))
  expect(provider.l1.commitMemory(project, next, 'worker', 3)?.revision).toBe(2)
  expect(provider.l1.getMemory(project, memory)?.state).toBe('superseded')
})

it('rejects changed content for one operation and concurrent stale revisions', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  provider.scanTurns(project, config, 20)
  const task = provider.l1.claim(project, header().id, 'one', 0)!
  expect(provider.l1.claim(project, header().id, 'two', 0)).toBeNull()
  provider.l1.prepare(project, task.operationId, 'one', candidate(task))
  expect(provider.l1.claim(project, header().id, 'two', 0)).toBeNull()
  expect(() => provider.l1.prepare(project, task.operationId, 'one', { kind: 'empty' })).toThrow(/another candidate/)
  provider.l1.commitMemory(project, task.operationId, 'one', 1)
  provider.l1.rerun(project, task.operationId, 'reextract', config)
  provider.l1.rerun(project, task.operationId, 'reextract', config)
  const a = provider.l1.claim(project, header().id, 'one', 2)!
  const b = provider.l1.claim(project, header().id, 'two', 2)!
  provider.l1.prepare(project, a.operationId, 'one', candidate(a))
  provider.l1.prepare(project, b.operationId, 'two', candidate(b))
  provider.l1.commitMemory(project, a.operationId, 'one', 3)
  expect(() => provider.l1.commitMemory(project, b.operationId, 'two', 3)).toThrow(/revision changed/)
})

it('records empty turns without inserting a memory version', async () => {
  const { provider, project, spec } = await setup()
  const events = turnEvents()
  await provider.appendRaw(batch(spec, [events[0]!, { ...events[2]!, seq: SessionSeq(1) }]))
  provider.scanTurns(project, config, 1)
  const task = provider.l1.claim(project, header().id, 'worker', 0)!
  provider.l1.prepare(project, task.operationId, 'worker', { kind: 'empty' })
  expect(provider.l1.commitMemory(project, task.operationId, 'worker', 1)).toBeNull()
  expect(provider.l1.commitMemory(project, task.operationId, 'worker', 2)).toBeNull()
  expect(provider.l1.getTask(project, task.operationId)?.status).toBe('empty')
})

it('upgrades a populated schema 1 without rewriting its L0 events', async () => {
  const { provider, project, spec } = await setup()
  const events = turnEvents()
  await provider.appendRaw(batch(spec, events))
  await provider.close()
  const db = new DatabaseSync(spec.databasePath)
  try { db.exec('DROP TABLE l1_memories; DROP TABLE l1_tasks; DROP TABLE l1_scans; PRAGMA user_version = 1') } finally { db.close() }
  const migrated = await SqliteMemory.open(spec)
  try {
    expect((await migrated.readRaw({ projectId: project, sessionId: header().id, from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 10 })).events).toEqual(events)
    expect(migrated.scanTurns(project, config, 2)).toBe(1)
  } finally { await migrated.close() }
})

it('does not reinterpret previously scanned turns when model configuration changes', async () => {
  const { provider, project, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  provider.scanTurns(project, config, 2)
  const changed = resolveL1Config({ provider: 'test', model: 'different' })
  expect(provider.scanTurns(project, changed, 2)).toBe(0)
  expect(provider.l1.listTasks(project, '', 10)).toMatchObject([{ config: { model: 'test' } }])
})

it('rolls back a failed schema migration without advancing its version or changing L0', async () => {
  const { provider, spec } = await setup()
  await provider.appendRaw(batch(spec, turnEvents()))
  await provider.close()
  const db = new DatabaseSync(spec.databasePath)
  try {
    db.exec('DROP TABLE l1_memories; DROP TABLE l1_tasks; DROP TABLE l1_scans; CREATE TABLE l1_tasks (unrelated INTEGER); PRAGMA user_version = 1')
    await expect(SqliteMemory.open(spec)).rejects.toThrow()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'l1_scans'").get()).toBeUndefined()
  } finally { db.close() }
})

it('rejects reads through an L1 handle after its provider closes', async () => {
  const { provider, project } = await setup()
  await provider.close()
  expect(() => provider.l1.listTasks(project, '', 1)).toThrow(/closed/)
})
