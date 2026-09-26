/** Real Cordis and JSONL lifecycle, including plugin unload and inherited history. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as MemoryPlugin from '../src/index.ts'
import { fixture } from './helpers.ts'

it('captures real persisted events, unloads, and recovers missed events on reload', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('real-source'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const options = { projectId: item.spec.projectId, databasePath: item.spec.databasePath }
    const first = await ctx.plugin(MemoryPlugin, options)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    const request = { projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 }
    expect((await ctx.memory.readRaw(request)).events).toEqual(session.snapshotEvents())
    await first.dispose()
    const external = await item.open()
    const before = (await external.readRaw(request)).committedTo
    session.append('turn/start', { turn: 2 })
    await writer.flush()
    expect((await external.readRaw({ ...request, to: session.seq })).committedTo).toBe(before)
    await external.close()
    const second = await ctx.plugin(MemoryPlugin, options)
    await ctx.sessions.flush(session)
    expect((await ctx.memory.readRaw({ ...request, to: session.seq })).events).toEqual(session.snapshotEvents())
    await second.dispose()
    await writer.close()
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('recovers the complete inherited prefix of a restored fork', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const parent = ctx.sessions.create(SessionId('parent'))
    const parentWriter = await ctx.sessionPersistence.create(parent.header)
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = ctx.sessions.fork(parent)
    const writer = await ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
    await writer.append(child.snapshotEvents())
    await writer.flush()
    const plugin = await ctx.plugin(MemoryPlugin, { projectId: item.spec.projectId, databasePath: item.spec.databasePath })
    await ctx.sessions.flush(child)
    const page = await ctx.memory.readRaw({ projectId: item.spec.projectId, sessionId: child.id, from: SessionLogOffset(0), to: child.seq, limit: 100 })
    expect(page.events).toEqual(child.snapshotEvents())
    expect(page.missing).toEqual([])
    await plugin.dispose()
    await writer.close()
    await parentWriter.close()
    const restored = Session.fromRestore(child.id, page.events, child.header, child.inheritedEventCount, 'detached')
    expect(restored.inheritedEventCount).toBe(child.inheritedEventCount)
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})

it('drains a full queue while the root and source provider shut down', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.spec.projectId, databasePath: item.spec.databasePath, queueCapacity: 1, batchSize: 2, pageSize: 2 })
    const session = ctx.sessions.create(SessionId('root-close'))
    await ctx.sessionPersistence.create(session.header)
    for (let turn = 1; turn < 10; turn++) {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const expected = session.snapshotEvents()
    await ctx.fiber.dispose()
    const reopened = await item.open()
    const page = await reopened.readRaw({ projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 })
    expect(page.events).toEqual(expected)
    expect(page.missing).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await item.close()
  }
})
