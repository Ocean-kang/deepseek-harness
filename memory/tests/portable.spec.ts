/** Portable defaults over real memory storage and a transport-owned panel registration. */
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import * as Portable from '../src/portable.ts'
import { fixture } from './helpers.ts'

class PanelTransport extends Service {
  readonly channels = new Set<string>()
  readonly rpc = { handle: (channel: string, _handler: ConnectionRpcHandler) => {
    this.channels.add(channel)
    return () => { this.channels.delete(channel) }
  } }
  constructor(ctx: Context) { super(ctx, 'connection') }
}
class WebSeat extends Service {
  constructor(ctx: Context) { super(ctx, 'webServer') }
}

async function setup() {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(PanelTransport)
    await ctx.plugin(WebSeat)
    const transport = ctx.get('connection')
    if (!(transport instanceof PanelTransport)) throw new Error('Panel transport was not mounted')
    return { ...item, ctx, transport, config: { storageMode: 'central' as const, dataRoot: item.root, databasePath: item.spec.databasePath },
      async close() { await ctx.fiber.dispose(); await item.close() } }
  } catch (error) { await ctx.fiber.dispose(); await item.close(); throw error }
}

it.each([undefined, true, false])('honors panel=%s while defaulting to trigram BM25 and logged injection', async panel => {
  const item = await setup()
  try {
    const plugin = await item.ctx.plugin(Portable, { ...item.config, ...(panel === undefined ? {} : { panel }) })
    expect(await item.ctx.memory.getIndexStatus(item.spec.projectId)).toMatchObject({ method: 'bm25', ready: true })
    expect(item.ctx.memory.recallMethod(item.spec.projectId)).toBe('trigram')
    expect(item.ctx.memory.browser.spec.refreshIntervalMs).toBe(3000)
    expect(item.ctx.memory.browser.injectionReady).toBe(true)
    if (panel === false) expect(item.transport.channels.has('/memory')).toBe(false)
    else await vi.waitFor(() => expect(item.transport.channels.has('/memory')).toBe(true))
    await plugin.dispose()
    expect(item.transport.channels.has('/memory')).toBe(false)
  } finally { await item.close() }
})

it('preserves an explicit tokenizer and refresh interval over portable defaults', async () => {
  const item = await setup()
  try {
    await item.ctx.plugin(Portable, { ...item.config, textSearch: { tokenizer: 'unicode61' }, browser: { refreshIntervalMs: 7000 }, panel: false })
    expect(item.ctx.memory.recallMethod(item.spec.projectId)).toBe('unicode61')
    expect(item.ctx.memory.browser.spec.refreshIntervalMs).toBe(7000)
  } finally { await item.close() }
})

it('combines optional embeddings with BM25 and accepts explicit text settings', async () => {
  const item = await setup()
  const key = `MEMORY_PORTABLE_${randomUUID().replaceAll('-', '')}`
  const previous = process.env[key]
  process.env[key] = 'synthetic-test-key'
  try {
    const embedding = { endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2, apiKeyEnv: key }
    const plugin = await item.ctx.plugin(Portable, { ...item.config, embedding, panel: false })
    expect(await item.ctx.memory.getIndexStatus(item.spec.projectId)).toMatchObject({ method: 'hybrid', ready: true })
    await plugin.dispose()
    const configured = await item.ctx.plugin(Portable, { ...item.config, embedding, textSearch: {}, panel: false })
    expect(item.ctx.memory.recallMethod(item.spec.projectId)).toBe('hybrid')
    await configured.dispose()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
    await item.close()
  }
})
