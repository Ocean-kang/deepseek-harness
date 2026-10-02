/** Authenticated-adapter JSON validation and authoritative Session ownership over real storage. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as MemoryPlugin from '../src/index.ts'
import { dispatchPanel } from '../src/panel-host.ts'
import { panelRequest, panelResponse } from '../src/panel-protocol.ts'
import { MemoryError } from '../src/types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'

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
