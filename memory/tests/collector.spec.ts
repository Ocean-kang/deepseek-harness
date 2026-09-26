/** Deterministic capture/recovery races with real transactions and controlled source reads. */
import { afterEach, expect, it, vi } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RawCollector } from '../src/collector.ts'
import type { RawMemory } from '../src/types.ts'
import { fixture } from './helpers.ts'

const collectors = new Set<RawCollector>()
const roots: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => {
  try { await Promise.all([...collectors].map(collector => collector.close())) } finally {
    collectors.clear()
    for (const item of roots.splice(0)) await item.close()
  }
})

async function setup() {
  const item = await fixture()
  roots.push(item)
  const provider = await item.open()
  const session = Session.create(SessionId('captured'))
  const closed = vi.fn()
  const flush = vi.fn(async () => {})
  let missing = false
  const source: Pick<SessionPersistence, 'open' | 'flush'> = {
    flush,
    async open(id) {
      if (missing) throw new Error('source unavailable')
      expect(id).toBe(session.id)
      const handle: SessionHandle = {
        id, header: session.header, inheritedEventCount: session.inheritedEventCount, access: 'read',
        async read(offset = 0, length = session.seq) {
          return { events: structuredClone(session.snapshotEvents(SessionLogOffset(offset), SessionLogOffset(offset + length))), eventState: 'detached' }
        },
        async append() { throw new Error('read-only') },
        async flush() { throw new Error('read-only') },
        async close() { closed() },
        async [Symbol.asyncDispose]() { await this.close() },
      }
      return handle
    },
  }
  const report = vi.fn()
  const create = (memory: RawMemory = provider) => {
    const collector = new RawCollector(memory, source, item.spec, report)
    collectors.add(collector)
    return collector
  }
  return {
    ...item, provider, session, source, report, closed, create,
    setMissing(value: boolean) { missing = value },
    async read() {
      return provider.readRaw({ projectId: item.spec.projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 })
    },
  }
}

it('recovers preloaded history, deduplicates repeated adoption and restarts', async () => {
  const item = await setup()
  item.session.append('turn/start', { turn: 1 })
  item.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const first = item.create()
  first.adopt(item.session)
  first.adopt(item.session)
  await first.flush(item.session)
  await first.close()
  const second = item.create()
  second.adopt(item.session)
  await second.flush(item.session)
  expect((await item.read()).events).toEqual(item.session.snapshotEvents())
  expect(item.closed).toHaveBeenCalled()
})

it('recovers bounded-queue overflow while history recovery is paused', async () => {
  const item = await setup()
  item.session.append('turn/start', { turn: 1 })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  item.source.flush = async () => { entered.resolve(); await release.promise }
  const collector = item.create()
  collector.adopt(item.session)
  await entered.promise
  try {
    for (let turn = 2; turn < 8; turn++) {
      const event = item.session.append('turn/start', { turn })
      collector.capture(item.session, event)
    }
    expect(item.report.mock.calls.some(([error]) => error.code === 'backpressure')).toBe(true)
  } finally {
    release.resolve()
  }
  await collector.flush(item.session)
  expect((await item.read()).events).toEqual(item.session.snapshotEvents())
})

it('keeps the committed prefix on failure and resumes on an explicit flush', async () => {
  const item = await setup()
  let fail = false
  const faulty: RawMemory = {
    readRaw: request => item.provider.readRaw(request),
    appendRaw: request => {
      if (fail && request.events.length > 0) return Promise.reject(new Error('disk failure'))
      return item.provider.appendRaw(request)
    },
  }
  const collector = item.create(faulty)
  collector.adopt(item.session)
  await collector.flush(item.session)
  const before = (await item.read()).committedTo
  fail = true
  collector.capture(item.session, item.session.append('turn/start', { turn: 1 }))
  try {
    await expect(collector.flush(item.session)).rejects.toThrow('did not confirm')
    expect((await item.read()).committedTo).toBe(before)
  } finally { fail = false }
  await collector.flush(item.session)
  expect((await item.read()).events).toEqual(item.session.snapshotEvents())
})

it('rejects source loss instead of declaring missing history complete', async () => {
  const item = await setup()
  item.session.append('turn/start', { turn: 1 })
  item.setMissing(true)
  const collector = item.create()
  try {
    await expect(collector.flush(item.session)).rejects.toThrow('did not confirm')
    expect((await item.read()).missing).not.toEqual([])
  } finally { item.setMissing(false) }
  await collector.flush(item.session)
})

it('waits for an in-flight transaction on close and ignores subsequent capture', async () => {
  const item = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held: RawMemory = {
    readRaw: request => item.provider.readRaw(request),
    async appendRaw(request) {
      if (request.events.length > 0) { entered.resolve(); await release.promise }
      return item.provider.appendRaw(request)
    },
  }
  item.session.append('turn/start', { turn: 1 })
  const collector = item.create(held)
  collector.adopt(item.session)
  await entered.promise
  let finished = false
  const close = collector.close().then(() => { finished = true })
  try {
    await Promise.resolve()
    expect(finished).toBe(false)
  } finally { release.resolve() }
  await close
  const before = (await item.read()).committedTo
  collector.capture(item.session, item.session.append('turn/start', { turn: 2 }))
  expect((await item.read()).committedTo).toBe(before)
  await expect(collector.flush(item.session)).rejects.toMatchObject({ code: 'closed' })
})

it('checks overlapping feed events against committed data', async () => {
  const item = await setup()
  const collector = item.create()
  const event = item.session.append('turn/start', { turn: 1 })
  collector.capture(item.session, event)
  await collector.flush(item.session)
  collector.capture(item.session, { ...event, time: event.time + 1 })
  await expect(collector.flush(item.session)).rejects.toMatchObject({ code: 'conflict' })
  collectors.delete(collector)
  await expect(collector.close()).rejects.toThrow('final flush failed')
  expect((await item.read()).events).toEqual(item.session.snapshotEvents())
})
