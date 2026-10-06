/** Authenticated-adapter JSON validation and authoritative Session ownership over real storage. */
import { expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { OperatorPeer } from '@deepseek-ai/dsh-client-connection'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { BrowserConfig } from '../src/browser.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as MemoryPlugin from '../src/index.ts'
import { dispatchPanel, installPanelHost, panelRowOf } from '../src/panel-host.ts'
import { panelRequest, panelResponse } from '../src/panel-protocol.ts'
import { MemoryError } from '../src/types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import { renderRecall } from '../src/retrieval.ts'
import type { OperationId } from '../src/l1-types.ts'

it('saves the recall switch through the wire after a selected version is invalidated', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('stale-switch'))
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath })
      const call = (request: Parameters<typeof dispatchPanel>[1]) => dispatchPanel(ctx, panelRequest.parse(request), new AbortController().signal)
      await call({ action: 'select', sessionId: session.id, refs: [ref], automatic: true })
      const receipt = item.provider.selections.get(item.project, session.id)!
      item.provider.knowledge.invalidateMemory(item.project, ref, 'Withdrawn', 'wire-invalidated' as OperationId)
      expect(panelResponse.parse(await call({ action: 'automatic', sessionId: session.id, automatic: false })))
        .toEqual({ action: 'automatic', refs: [ref], automatic: false })
      expect(item.provider.selections.get(item.project, session.id)).toEqual({ ...receipt, automatic: false })
      expect(await call({ action: 'state', sessionId: session.id })).toMatchObject({ automatic: false, valid: false })
    } finally { await writer.close() }
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('projects readable raw and summary cards while keeping scores, rationale and JSON in detail metadata', async () => {
  const item = await knowledgeFixture()
  try {
    const raw = panelRowOf({ level: 'L0', header: header(), event: turnEvents()[1]! })
    expect(raw.sections).toEqual([{ label: 'conversation', text: 'Fix the failing parser' }])
    expect(raw.body).not.toContain('"source"')
    expect(JSON.parse(raw.raw!)).toMatchObject({ type: 'user/message' })
    const summary = panelRowOf(item.source)
    expect(summary.sections).toMatchObject([{ label: 'topic', text: 'Fix the parser' }, { label: 'result' }])
    expect(summary.outcome).toBe('unknown')
    const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
    const knowledge = panelRowOf(item.provider.knowledge.getMemory(item.project, ref)!)
    expect(knowledge.trust).toMatchObject({ score: 4, scoreMin: 0, scoreMax: 5, evidence: 'supported', rationale: 'Explicit project constraint' })
    expect(knowledge.generation).toMatchObject({ provider: 'test', model: 'test' })
    expect(knowledge.sections).toEqual([{ label: 'experience', text: 'Use strict TypeScript' }])
    expect(item.provider.learningStatus(item.project)).toMatchObject({ generated: 2, pending: 0, failed: 0 })
  } finally { await item.close() }
})

it('keeps recalled JSON envelopes and extraction frames in details while preserving ordinary conversation text', async () => {
  const item = await knowledgeFixture()
  try {
    const raw = (event: Parameters<typeof panelRowOf>[0] & { level: 'L0' }) => panelRowOf(event)
    const recallText = renderRecall([{ ref: item.source, projectId: item.project, shared: false, text: '[安装验收样例] Portable ESM\nUse ESM.', similarity: null },
      { ref: item.source, projectId: item.project, shared: false, text: JSON.stringify(item.source.summary), similarity: null }])
    const recall: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(0), time: 1,
      data: createUserMessage({ source: { kind: 'memory-recall', form: 'recall', turn: 1,
        memories: [{ ref: item.source, projectId: item.project, shared: false, selected: true }] },
      content: [{ type: 'text', text: recallText }] }), surfaceOp: 'append' }
    const row = raw({ level: 'L0', header: header(), event: recall })
    expect(row.sections[0]).toMatchObject({ label: 'recalled' })
    expect(row.body).toContain('[安装验收样例] Portable ESM\nUse ESM.')
    expect(row.body).not.toContain('"memory"')
    expect(row.body).not.toContain('"project"')
    expect(row.body).toContain(item.source.summary.goal)
    expect(row.body).not.toContain('"goal"')
    expect(JSON.parse(row.raw!)).toEqual(recall)
    const request: SessionEvent<'memory/extraction-request'> = { type: 'memory/extraction-request', seq: SessionSeq(0), time: 1,
      data: { operationId: item.source.operationId, projectId: item.project, level: 'L2',
        request: { provider: 'test', model: 'test', system: 'Recorded prompt', maxTokens: 100, sessionId: item.source.sessionId,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ input: { sources: [item.source] } }) }] }] } } }
    expect(raw({ level: 'L0', header: header(), event: request }).sections).toEqual([{ label: 'extractionRequest', text: 'L2 · test / test' }])
    const result: SessionEvent<'memory/extraction-result'> = { type: 'memory/extraction-result', seq: SessionSeq(1), time: 2,
      data: { operationId: item.source.operationId, outcome: 'returned', stream: [{ type: 'text-chunks', time0: 2, index: 0, dt: [0],
        texts: [JSON.stringify([{ knowledge: { title: 'Portable ESM', body: 'Use ESM.', sources: [] } }])] }] } }
    expect(raw({ level: 'L0', header: header(), event: result }).sections).toEqual([{ label: 'returned', text: 'Portable ESM\nUse ESM.' }])
    for (const outcome of ['cancelled', 'threw'] as const) {
      const incomplete = { ...result, data: { ...result.data, outcome, stream: [{ type: 'text-chunks' as const, time0: 2, index: 0, dt: [0], texts: ['{"partial":'] }] } }
      const card = raw({ level: 'L0', header: header(), event: incomplete })
      expect(card.sections).toEqual([{ label: outcome, text: '' }])
      expect(JSON.parse(card.raw!)).toEqual(incomplete)
    }
    const userJson = '{"message":"Keep this JSON exactly"}'
    expect(raw({ level: 'L0', header: header(), event: turnEvents(undefined, userJson)[1]! }).body).toBe(userJson)
  } finally { await item.close() }
})

it('browses and selects a persisted conversation without restoring it and consumes only its committed receipt', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])[0]!
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath })
    const session = Session.create(SessionId('stored-panel-reader'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const call = (request: Parameters<typeof dispatchPanel>[1]) => dispatchPanel(ctx, request, new AbortController().signal)
    try {
      await ctx.memory.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events: [] })
      await writer.flush()
      const open = vi.spyOn(ctx.sessionPersistence, 'open')
      const create = vi.spyOn(ctx.sessions, 'create')
      const flush = vi.spyOn(ctx.sessions, 'flush')
      expect(panelResponse.parse(await call({ action: 'browse', sessionId: session.id, level: 'L2', query: 'ESM', after: null })))
        .toMatchObject({ rows: [{ ref, selectable: true }] })
      expect(open).not.toHaveBeenCalled()
      expect(panelResponse.parse(await call({ action: 'select', sessionId: session.id, refs: [ref], automatic: true })))
        .toMatchObject({ refs: [ref], automatic: true })
      const selected = ctx.memory.browser.selectionFromEvents(item.project, session.id, [])!
      expect(panelResponse.parse(await call({ action: 'state', sessionId: session.id })))
        .toMatchObject({ refs: [ref], automatic: true, used: [] })
      session.append('user/message', createUserMessage({ source: { kind: 'memory-recall', form: 'recall', turn: 1,
        selectionId: selected.token, memories: [{ ref, projectId: item.project, shared: false, selected: true }] },
      content: [{ type: 'text', text: 'Type checking\nESM' }] }), { surfaceOp: 'append' })
      const events = session.snapshotEvents()
      await writer.append(events)
      await writer.flush()
      expect(panelResponse.parse(await call({ action: 'state', sessionId: session.id })))
        .toMatchObject({ refs: [ref], automatic: true, used: [] })
      await ctx.memory.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events })
      expect(panelResponse.parse(await call({ action: 'state', sessionId: session.id })))
        .toMatchObject({ refs: [], automatic: true, used: [{ turn: 1, body: 'Type checking\nESM', refs: [ref] }] })
      await call({ action: 'select', sessionId: session.id, refs: [ref], automatic: false })
      expect(panelResponse.parse(await call({ action: 'state', sessionId: session.id })))
        .toMatchObject({ refs: [ref], automatic: false })
      expect(open).not.toHaveBeenCalled()
      const reader = await ctx.sessionPersistence.open(session.id, 'read')
      try { expect((await reader.read()).events).toEqual(events) } finally { await reader.close() }
      expect(ctx.sessions.get(session.id)).toBeUndefined()
      expect(create).not.toHaveBeenCalled()
      expect(flush).not.toHaveBeenCalled()
      expect(ctx.get('agents')).toBeUndefined()
    } finally { await writer.close() }
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('rejects an uncaptured persisted conversation instead of choosing a project fallback', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath })
    const session = Session.create(SessionId('uncaptured-panel-reader'))
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      await writer.flush()
      const requests: Array<Parameters<typeof dispatchPanel>[1]> = [{ action: 'state', sessionId: session.id },
        { action: 'browse', sessionId: session.id, level: 'L2', query: '', after: null },
        { action: 'select', sessionId: session.id, refs: [], automatic: false }]
      for (const request of requests) {
        await expect(dispatchPanel(ctx, request, new AbortController().signal)).rejects.toMatchObject({ code: 'source' })
      }
      expect(ctx.sessions.get(session.id)).toBeUndefined()
    } finally { await writer.close() }
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('binds browser and selections to captured Session ownership and validates every response', async () => {
  const item = await knowledgeFixture()
  const ctx = new Context()
  try {
    const original = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])[0]!
    const ref = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'ESM revision'), target: original }], 'revision')[0]!
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    const session = ctx.sessions.create(SessionId('panel-reader'))
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath, browser: { pageSize: 1 } })
      const call = (request: Parameters<typeof dispatchPanel>[1]) => dispatchPanel(ctx, request, new AbortController().signal)
      const listed = await call({ action: 'browse', sessionId: session.id, level: 'L2', query: 'ESM', after: null })
      expect(panelResponse.parse(listed)).toMatchObject({ action: 'browse', rows: [{ ref, selectable: true }] })
      expect(panelResponse.parse(await call({ action: 'detail', sessionId: session.id, ref }))).toMatchObject({ row: { sources: [{ ref: { id: item.source.id, revision: item.source.revision } }] } })
      expect(panelResponse.parse(await call({ action: 'history', sessionId: session.id, id: ref.id, before: Number.MAX_SAFE_INTEGER }))).toMatchObject({ refs: [ref], next: ref.revision })
      expect(panelResponse.parse(await call({ action: 'history', sessionId: session.id, id: ref.id, before: ref.revision }))).toMatchObject({ refs: [original], next: original.revision })
      expect(panelResponse.parse(await call({ action: 'history', sessionId: session.id, id: ref.id, before: original.revision }))).toMatchObject({ refs: [], next: null })
      expect(panelResponse.parse(await call({ action: 'select', sessionId: session.id, refs: [ref], automatic: false }))).toMatchObject({ refs: [ref] })
      expect(panelResponse.parse(await call({ action: 'state', sessionId: session.id }))).toMatchObject({ projectId: item.project, refs: [ref], valid: true, injectionReady: false })
      await expect(call({ action: 'state', sessionId: SessionId('missing-session') })).rejects.toMatchObject({ code: 'source' })
      expect(panelRequest.safeParse({ action: 'state', sessionId: session.id, projectId: 'foreign' }).success).toBe(false)
      expect(panelRequest.safeParse({ action: 'select', sessionId: session.id, refs: [{ id: ref.id, revision: 0 }], automatic: false }).success).toBe(false)
      const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new MemoryError('conflict', 'Stored source differs'))
      try { await expect(call({ action: 'state', sessionId: session.id })).rejects.toMatchObject({ code: 'source' }) } finally { flush.mockRestore() }
    } finally { await writer.close() }
  } finally { await ctx.fiber.dispose(); await item.close() }
})

async function projectionFixture(options: BrowserConfig, beforeRead?: (signal: AbortSignal | undefined) => Promise<void>) {
  const item = await knowledgeFixture()
  const ctx = new Context()
  let writer: SessionHandle | undefined
  const close = async () => { await writer?.close(); await ctx.fiber.dispose(); await item.close() }
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(MemoryPlugin, { projectId: item.project, databasePath: item.spec.databasePath, browser: options })
    const session = Session.create(SessionId('projected-panel'))
    writer = await ctx.sessionPersistence.create(session.header)
    await ctx.memory.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events: [] })
    await writer.flush()
    const reads: Array<{ offset: number | undefined; length: number | undefined }> = []
    const opened = vi.spyOn(ctx.sessionPersistence, 'open')
    const readRaw = ctx.memory.readRaw.bind(ctx.memory)
    vi.spyOn(ctx.memory, 'readRaw').mockImplementation(async request => {
      if (request.to > request.from) {
        reads.push({ offset: request.cursor ?? request.from, length: request.limit })
        await beforeRead?.(request.signal)
      }
      return readRaw(request)
    })
    const call = (id = session.id, signal = new AbortController().signal) => dispatchPanel(ctx, { action: 'state', sessionId: id }, signal)
    return { ...item, ctx, session, writer, reads, opened, call, close }
  } catch (error) { await close(); throw error }
}

it('pages captured SQLite events once, skips unchanged polls and projects only the appended recall tail', async () => {
  const item = await projectionFixture({ pageSize: 2 })
  try {
    const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])[0]!
    for (let index = 0; index < 20; index++) {
      const recalled = index % 5 === 4
      item.session.append('user/message', createUserMessage({ source: recalled
        ? { kind: 'memory-recall', form: 'recall', turn: Math.floor(index / 5) + 1, memories: [{ ref, projectId: item.project, shared: false, selected: false }] }
        : { kind: 'user' }, content: [{ type: 'text', text: recalled ? `Recall ${index}` : 'Ordinary context' }] }), { surfaceOp: 'append' })
    }
    await item.writer.append(item.session.snapshotEvents())
    await item.writer.flush()
    await item.ctx.memory.appendRaw({ projectId: item.project, header: item.session.header, inheritedEventCount: SessionLogOffset(0), events: item.session.snapshotEvents() })
    expect(await item.call()).toMatchObject({ used: [{ turn: 3 }, { turn: 4 }] })
    expect(item.reads.every(read => read.length === 2)).toBe(true)
    expect(item.reads.map(read => read.offset)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    const reads = item.reads.length
    await item.call()
    await item.call()
    expect(item.opened).not.toHaveBeenCalled()
    expect(item.reads).toHaveLength(reads)
    item.session.append('user/message', createUserMessage({ source: { kind: 'memory-recall', form: 'recall', turn: 5,
      memories: [{ ref, projectId: item.project, shared: false, selected: false }] }, content: [{ type: 'text', text: 'Newest recall' }] }), { surfaceOp: 'append' })
    await item.writer.append(item.session.snapshotEvents(SessionLogOffset(20)))
    await item.writer.flush()
    await item.ctx.memory.appendRaw({ projectId: item.project, header: item.session.header, inheritedEventCount: SessionLogOffset(0), events: item.session.snapshotEvents(SessionLogOffset(20)) })
    expect(await item.call()).toMatchObject({ used: [{ turn: 4 }, { turn: 5, body: 'Newest recall' }] })
    expect(item.reads.slice(reads)).toEqual([{ offset: 20, length: 2 }])
    expect(item.opened).not.toHaveBeenCalled()
  } finally { await item.close() }
})

it.each([false, true])('shares overlapping SQLite state polls and retries cancelled reads: cancelled=%s', async (cancelled) => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked = false
  const item = await projectionFixture({ pageSize: 2 }, async () => {
    if (!blocked) { blocked = true; enter(); await gate }
  })
  try {
    item.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Captured input' }] }), { surfaceOp: 'append' })
    await item.ctx.memory.appendRaw({ projectId: item.project, header: item.session.header, inheritedEventCount: SessionLogOffset(0), events: item.session.snapshotEvents() })
    const controller = new AbortController()
    const first = item.call(item.session.id, controller.signal).catch((error: unknown) => error)
    await entered
    const second = item.call()
    if (cancelled) controller.abort(new Error('Cancelled panel read'))
    release()
    expect(await first).toMatchObject(cancelled ? { message: 'Cancelled panel read' } : { action: 'state', used: [] })
    expect(await second).toMatchObject({ action: 'state', used: [] })
    expect(item.opened).not.toHaveBeenCalled()
    expect(item.reads).toHaveLength(cancelled ? 2 : 1)
    const reads = item.reads.length
    await Promise.all([item.call(), item.call()])
    expect(item.reads).toHaveLength(reads)
  } finally { release(); await item.close() }
})

it('evicts the least recently viewed Session when the configured projection capacity is reached', async () => {
  const item = await projectionFixture({ pageSize: 2, stateCacheSessions: 1 })
  const other = Session.create(SessionId('second-projected-panel'))
  const writer = await item.ctx.sessionPersistence.create(other.header)
  try {
    for (const session of [item.session, other]) {
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Captured input' }] }), { surfaceOp: 'append' })
      await item.ctx.memory.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events: session.snapshotEvents() })
    }
    await writer.flush()
    await item.call()
    await item.call(other.id)
    await item.call()
    expect(item.opened).not.toHaveBeenCalled()
    expect(item.reads.map(read => read.offset)).toEqual([0, 0, 0])
  } finally { await writer.close(); await item.close() }
})

it('stops panel requests before disposing and drops the cached prefix after the pending read settles', async () => {
  class PanelConnection extends Service {
    handler: ConnectionRpcHandler | undefined
    stopped = false
    readonly operator: OperatorPeer
    readonly rpc = { handle: (_channel: string, handler: ConnectionRpcHandler) => {
      this.handler = handler
      return () => { this.stopped = true; this.handler = undefined }
    } }
    constructor(ctx: Context) {
      super(ctx, 'connection')
      this.operator = new OperatorPeer(ctx)
      ctx.effect(() => () => this.operator.dispose(), 'panel-test.operator')
    }
  }
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let block = false
  let readStopped = false
  const item = await projectionFixture({ pageSize: 2 }, async signal => {
    if (!block) return
    block = false
    if (signal === undefined) throw new Error('Panel read did not receive cancellation')
    enter()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
      readStopped = true
      reject(signal.reason)
    }, { once: true }))
  })
  const connection = new PanelConnection(item.ctx)
  const dispose = installPanelHost(item.ctx)
  try {
    for (let index = 0; index < 2; index++) {
      item.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Input ${index}` }] }), { surfaceOp: 'append' })
      await item.ctx.memory.appendRaw({ projectId: item.project, header: item.session.header, inheritedEventCount: SessionLogOffset(0), events: item.session.snapshotEvents(SessionLogOffset(index)) })
      if (index === 0) await item.call()
    }
    block = true
    const request = connection.handler!('panel', { action: 'state', sessionId: item.session.id }, new AbortController().signal, connection.operator)
      .catch((error: unknown) => error)
    await entered
    await dispose()
    expect(connection.stopped).toBe(true)
    expect(connection.handler).toBeUndefined()
    expect(readStopped).toBe(true)
    expect(await request).toBeInstanceOf(Error)
    await item.call()
    expect(item.reads.map(read => read.offset)).toEqual([0, 1, 0])
    expect(item.opened).not.toHaveBeenCalled()
  } finally { await dispose(); await item.close() }
})
