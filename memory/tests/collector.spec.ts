/** Deterministic capture/recovery races with real transactions and controlled source reads. */
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RawCollector } from '../src/collector.ts'
import type { RawMemory } from '../src/types.ts'
import type { MemoryError } from '../src/types.ts'
import { fixture } from './helpers.ts'
import { memoryPath } from '../src/config.ts'

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
  const report = vi.fn<(error: MemoryError) => void>()
  const create = (memory: Pick<RawMemory, 'appendRaw'> = provider) => {
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
    expect(item.report.mock.calls.some(([error]: [MemoryError]) => error.code === 'backpressure')).toBe(true)
  } finally {
    release.resolve()
  }
  await collector.flush(item.session)
  expect((await item.read()).events).toEqual(item.session.snapshotEvents())
})

it('caps detached capture bytes at the configured budget across a tenfold event increase and recovers every event', async () => {
  const metrics = []
  for (const count of [100, 1000]) {
    const item = await setup()
    item.session.append('turn/start', { turn: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    item.source.flush = async () => { entered.resolve(); await release.promise }
    const budget = 8192
    let transactions = 0
    const memory: Pick<RawMemory, 'appendRaw'> = { async appendRaw(request) {
      transactions++
      expect(request.events.length).toBeLessThanOrEqual(128)
      expect(request.events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0)).toBeLessThanOrEqual(256 * 1024)
      return item.provider.appendRaw(request)
    } }
    const collector = new RawCollector(memory, item.source,
      { ...item.spec, queueCapacity: 2000, queueMaxBytes: budget, batchSize: 128, pageMaxBytes: 256 * 1024 }, item.report)
    collectors.add(collector)
    collector.adopt(item.session)
    await entered.promise
    let peak = 0
    const started = performance.now()
    try {
      for (let index = 0; index < count; index++) {
        collector.capture(item.session, item.session.append('user/message', createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(1024) }],
        }), { surfaceOp: 'append' }))
        const retained: unknown = Object.getOwnPropertyDescriptor(collector, 'bufferedBytes')?.value
        if (typeof retained !== 'number') throw new Error('Capture byte accounting is unavailable')
        expect(retained).toBeLessThanOrEqual(budget)
        peak = Math.max(peak, retained)
      }
    } finally { release.resolve() }
    await collector.flush(item.session)
    let cursor = SessionLogOffset(0)
    do {
      const recorded = await item.provider.readRaw({ projectId: item.spec.projectId, sessionId: item.session.id,
        from: SessionLogOffset(0), to: item.session.seq, cursor, limit: 100, maxBytes: 4096 })
      const next = recorded.nextCursor ?? item.session.seq
      expect(recorded.events).toEqual(item.session.snapshotEvents(cursor, next))
      cursor = next
    } while (cursor < item.session.seq)
    metrics.push({ events: count, peakCaptureBytes: peak, budget, transactions, elapsedMs: Math.round(performance.now() - started) })
  }
  expect(metrics[1]!.peakCaptureBytes).toBe(metrics[0]!.peakCaptureBytes)
  console.info('Capture cache metrics', JSON.stringify(metrics))
  if (process.env.DSH_MEMORY_CAPTURE_METRICS !== undefined) {
    await writeFile(await memoryPath(process.env.DSH_MEMORY_CAPTURE_METRICS), JSON.stringify(metrics, null, 2) + '\n')
  }
})

it('keeps the committed prefix on failure and resumes on an explicit flush', async () => {
  const item = await setup()
  let fail = false
  const faulty: Pick<RawMemory, 'appendRaw'> = {
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
  const held: Pick<RawMemory, 'appendRaw'> = {
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
