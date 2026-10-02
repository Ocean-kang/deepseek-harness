/** Durability, pagination and transaction failure checks against real SQLite. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { SqliteMemory } from '../src/sqlite.ts'
import { batch, event, fixture, header } from './helpers.ts'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })

async function setup() {
  const item = await fixture()
  owned.push(item)
  return { ...item, provider: await item.open() }
}

function read(projectId: ReturnType<typeof batch>['projectId'], to: number, limit = 10) {
  return { projectId, sessionId: header().id, from: SessionLogOffset(0), to: SessionLogOffset(to), limit }
}

it('reopens complete events and distinguishes missing tails from pagination', async () => {
  const { provider, spec, open } = await setup()
  const events = [event(0), event(1), event(2)]
  expect(await provider.appendRaw(batch(spec, events))).toMatchObject({ inserted: 3, duplicates: 0, committedTo: 3 })
  await provider.close()
  const reopened = await open()
  const first = await reopened.readRaw(read(spec.projectId, 5, 2))
  expect(first).toMatchObject({ events: events.slice(0, 2), nextCursor: 2, committedTo: 3, missing: [{ from: 3, to: 5 }] })
  expect(await reopened.readRaw({ ...read(spec.projectId, 5, 2), cursor: SessionLogOffset(2) })).toMatchObject({ events: [events[2]], nextCursor: null, missing: [{ from: 3, to: 5 }] })
  expect(await reopened.readRaw(read(spec.projectId, 0))).toMatchObject({ events: [], missing: [], nextCursor: null })
})

it('deduplicates JSON values regardless of object property insertion order', async () => {
  const { provider, spec } = await setup()
  const original = event(0)
  await provider.appendRaw(batch(spec, [original]))
  const reordered = { data: original.data, time: original.time, seq: original.seq, type: original.type }
  expect(await provider.appendRaw(batch(spec, [reordered]))).toMatchObject({ inserted: 0, duplicates: 1, committedTo: 1 })
  await expect(provider.appendRaw(batch(spec, [{ ...original, time: 900 }, event(1)]))).rejects.toMatchObject({ code: 'conflict' })
  expect((await provider.readRaw(read(spec.projectId, 2))).committedTo).toBe(1)
})

it('accepts the documented absent zero delegation depth without rewriting source metadata', async () => {
  const { provider, spec } = await setup()
  const initial = batch(spec, [event(0)])
  await provider.appendRaw(initial)
  expect(await provider.appendRaw({ ...initial, header: { ...initial.header, delegationDepth: 0 } })).toMatchObject({ duplicates: 1, committedTo: 1 })
  await expect(provider.appendRaw({ ...initial, header: { ...initial.header, delegationDepth: 1 } })).rejects.toMatchObject({ code: 'conflict' })
  const db = new DatabaseSync(spec.databasePath, { readOnly: true })
  try { expect(JSON.parse(String(db.prepare('SELECT header FROM sessions WHERE id = ?').get(initial.header.id)?.header))).not.toHaveProperty('delegationDepth') } finally { db.close() }
})

it('rolls back inserted rows and position after a later statement fails', async () => {
  const { provider, spec } = await setup()
  const external = new DatabaseSync(spec.databasePath)
  try {
    external.exec("CREATE TRIGGER reject_second BEFORE INSERT ON events WHEN NEW.seq = 1 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    await expect(provider.appendRaw(batch(spec, [event(0), event(1)]))).rejects.toThrow()
    expect(external.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0)
    expect(external.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0)
    external.exec('DROP TRIGGER reject_second')
    expect((await provider.appendRaw(batch(spec, [event(0), event(1)]))).committedTo).toBe(2)
  } finally {
    external.close()
  }
})

it('rejects gaps and conflicting project ownership without exposing another project', async () => {
  const { provider, spec } = await setup()
  await expect(provider.appendRaw(batch(spec, [event(1)]))).rejects.toMatchObject({ code: 'gap' })
  await provider.appendRaw(batch(spec, [event(0)]))
  const other = await resolveConfig({ projectId: 'another-project', databasePath: spec.databasePath })
  await expect(provider.appendRaw(batch(other, [event(0)]))).rejects.toMatchObject({ code: 'conflict' })
  expect(await provider.readRaw(read(other.projectId, 1))).toMatchObject({ found: false, events: [], committedTo: 0 })
  expect(await provider.readRaw({ ...read(other.projectId, 1), sessionId: SessionId('absent') })).toMatchObject({ found: false, events: [], committedTo: 0 })
})

it('refuses a newer schema without changing its stamp', async () => {
  const { provider, spec } = await setup()
  await provider.close()
  const external = new DatabaseSync(spec.databasePath)
  try {
    external.exec('PRAGMA user_version = 999')
    await expect(SqliteMemory.open(spec)).rejects.toMatchObject({ code: 'schema' })
    expect(external.prepare('PRAGMA user_version').get()?.user_version).toBe(999)
  } finally {
    external.close()
  }
})

it('refuses an unrelated unstamped database', async () => {
  const item = await fixture()
  owned.push(item)
  const external = new DatabaseSync(item.spec.databasePath)
  external.exec('CREATE TABLE unrelated (id INTEGER)')
  external.close()
  await expect(SqliteMemory.open(item.spec)).rejects.toMatchObject({ code: 'schema' })
})

it('reports a corrupt committed prefix instead of presenting a complete page', async () => {
  const { provider, spec } = await setup()
  await provider.appendRaw(batch(spec, [event(0), event(1)]))
  const external = new DatabaseSync(spec.databasePath)
  try { external.exec('DELETE FROM events WHERE seq = 0') } finally { external.close() }
  await expect(provider.readRaw(read(spec.projectId, 2))).rejects.toMatchObject({ code: 'corrupt' })
})

it('cancels before commit and rejects use after close', async () => {
  const { provider, spec } = await setup()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(provider.appendRaw({ ...batch(spec, [event(0)]), signal: controller.signal })).rejects.toThrow('cancelled')
  expect((await provider.readRaw(read(spec.projectId, 1))).found).toBe(false)
  await provider.close()
  await provider.close()
  await expect(provider.readRaw(read(spec.projectId, 1))).rejects.toMatchObject({ code: 'closed' })
})
