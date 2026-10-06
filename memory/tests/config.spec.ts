/** Configuration and path checks do not create files outside the memory root. */
import { afterEach, expect, it } from 'vitest'
import { symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { resolveConfig } from '../src/config.ts'
import { Config } from '../src/index.ts'
import * as MemoryPlugin from '../src/index.ts'
import { fixture } from './helpers.ts'
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })

it('resolves defaults once and rejects invalid deployment values', async () => {
  expect(await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite' })).toMatchObject({ queueCapacity: 1024, learningConcurrency: 2, learningQueueCapacity: 128,
    batchSize: 128, pageSize: 128, busyTimeoutMs: 5000, journalMode: 'wal' })
  for (const projectId of ['', ' ', ' trailing ']) await expect(resolveConfig({ projectId, databasePath: 'data/test.sqlite' })).rejects.toMatchObject({ code: 'config' })
  for (const queueCapacity of [0, -1, 1.5, Infinity]) await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', queueCapacity })).rejects.toMatchObject({ code: 'config' })
  for (const value of [0, -1, 1.5, Infinity]) {
    await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', learningConcurrency: value })).rejects.toMatchObject({ code: 'config' })
    await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', learningQueueCapacity: value })).rejects.toMatchObject({ code: 'config' })
  }
  await expect(resolveConfig({ projectId: 'a', databasePath: '../escape.sqlite' })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', autoLearning: true })).rejects.toMatchObject({ code: 'config' })
  expect((await resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', textSearch: {} })).textSearch).toMatchObject({ tokenizer: 'unicode61', limit: 5 })
  await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', textSearch: { expandQuery: true } })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', injection: true })).rejects.toMatchObject({ code: 'config' })
  expect((await resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', textSearch: {}, injection: true })).injection).toBe(true)
})

it('selects central storage for direct mounts and accepts the explicit workspace mode', async () => {
  expect((await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite' })).storageMode).toBe('central')
  expect((await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', storageMode: 'workspace' })).storageMode).toBe('workspace')
})

it('preserves the configured refresh interval through the Loader configuration declaration', async () => {
    const parsed = Config({ projectId: 'stable', databasePath: 'data/test.sqlite', browser: { refreshIntervalMs: 750, stateCacheSessions: 2 } })
  expect(parsed.browser?.refreshIntervalMs).toBe(750)
    expect((await resolveConfig(parsed)).browser.refreshIntervalMs).toBe(750)
    expect((await resolveConfig(parsed)).browser.stateCacheSessions).toBe(2)
    await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', browser: { stateCacheSessions: 0 } }))
      .rejects.toMatchObject({ code: 'config' })
  for (const refreshIntervalMs of [0, -1, 1.5, Infinity]) {
    await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', browser: { refreshIntervalMs } }))
      .rejects.toMatchObject({ code: 'config' })
  }
})

it('keeps portable storage beneath its explicit durable root', async () => {
  const item = await fixture()
  owned.push(item)
  const dataRoot = join(item.root, 'durable')
  expect((await resolveConfig({ projectId: 'portable', dataRoot, databasePath: 'memory.sqlite' })).databasePath).toBe(join(dataRoot, 'memory.sqlite'))
  await expect(resolveConfig({ projectId: 'portable', dataRoot, databasePath: '../escape.sqlite' })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'portable', dataRoot: 'relative', databasePath: 'memory.sqlite' })).rejects.toMatchObject({ code: 'config' })
})

it('refuses a directory junction before creating a database', async () => {
  const item = await fixture()
  owned.push(item)
  const link = join(item.root, 'redirect')
  await symlink(item.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(resolveConfig({ projectId: 'a', databasePath: join(link, 'db.sqlite') })).rejects.toMatchObject({ code: 'config' })
  } finally {
    await unlink(link)
  }
})

it('requires explicit L1 routes and resolves every extraction limit before execution', async () => {
  const spec = await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite' })
  expect(spec.l1).toBeUndefined()
  expect(resolveL1Config({ provider: 'test', model: 'test' })).toEqual({ provider: 'test', model: 'test', promptVersion: 'l1-v3', maxInputBytes: 65536,
    maxOutputTokens: 2048, timeoutMs: 60000, maxCalls: 32, maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 30000 })
  for (const value of ['', '  ', ' trailing ']) expect(() => resolveL1Config({ provider: value, model: 'test' })).toThrow()
  for (const value of [0, -1, 1.5, Infinity]) expect(() => resolveL1Config({ provider: 'test', model: 'test', timeoutMs: value })).toThrow()
  expect(() => resolveL1Config({ provider: 'test', model: 'test', retryBaseMs: 100, retryMaxMs: 1 })).toThrow()
})

it('resolves knowledge settings at load and rejects invalid scoring', async () => {
  const config = { provider: 'test', model: 'test', scoreMin: 1, scoreMax: 5, l2Threshold: 3, l3Threshold: 4 }
  const spec = await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: config })
  expect(spec.knowledge).toEqual(resolveKnowledgeConfig(config))
  expect(spec.knowledge?.promptVersion).toBe('knowledge-v4')
  await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: { ...config, l3Threshold: 2 } })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: { ...config, provider: '' } })).rejects.toMatchObject({ code: 'config' })
})

it('rejects query expansion at plugin load when the available LLM was not declared as an injection', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
    await ctx.plugin(LlmRuntime)
    expect(ctx.get('llm')).toBeDefined()
    const config = { projectId: item.spec.projectId, databasePath: item.spec.databasePath,
      l1: { provider: 'test', model: 'test' }, textSearch: { expandQuery: true } }
    await expect(ctx.plugin(MemoryPlugin, config)).rejects.toMatchObject({ code: 'config',
      message: "Query expansion requires llm in this plugin entry's inject list" })
    expect(ctx.get('memory')).toBeUndefined()
    const plugin = await ctx.plugin({ ...MemoryPlugin, inject: [...MemoryPlugin.inject, 'llm'] }, config)
    expect(ctx.get('memory')).toBeDefined()
    await plugin.dispose()
  } finally { await ctx.fiber.dispose(); await item.close() }
})

it('rejects the memory apply callback when its declared LLM service is unavailable', async () => {
  const item = await fixture()
  const ctx = new Context()
  try {
    // Ordinary Cordis fibers wait for required services; direct apply covers a missing service at callback entry.
    ctx.fiber.inject.llm = null
    expect(ctx.get('llm')).toBeUndefined()
    await expect(MemoryPlugin.apply(ctx, { projectId: item.spec.projectId, databasePath: item.spec.databasePath,
      l1: { provider: 'test', model: 'test' }, textSearch: { expandQuery: true } })).rejects.toMatchObject({ code: 'config',
      message: "Query expansion requires llm in this plugin entry's inject list" })
    expect(ctx.get('memory')).toBeUndefined()
  } finally { await ctx.fiber.dispose(); await item.close() }
})
