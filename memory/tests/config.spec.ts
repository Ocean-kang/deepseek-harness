/** Configuration and path checks do not create files outside the memory root. */
import { afterEach, expect, it } from 'vitest'
import { symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { fixture } from './helpers.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { resolveKnowledgeConfig } from '../src/knowledge-validation.ts'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })

it('resolves defaults once and rejects invalid deployment values', async () => {
  expect(await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite' })).toMatchObject({ queueCapacity: 1024, batchSize: 128, pageSize: 128, busyTimeoutMs: 5000, journalMode: 'wal' })
  for (const projectId of ['', ' ', ' trailing ']) await expect(resolveConfig({ projectId, databasePath: 'data/test.sqlite' })).rejects.toMatchObject({ code: 'config' })
  for (const queueCapacity of [0, -1, 1.5, Infinity]) await expect(resolveConfig({ projectId: 'a', databasePath: 'data/test.sqlite', queueCapacity })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'a', databasePath: '../escape.sqlite' })).rejects.toMatchObject({ code: 'config' })
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
  expect(resolveL1Config({ provider: 'test', model: 'test' })).toEqual({ provider: 'test', model: 'test', promptVersion: 'l1-v1', maxInputBytes: 65536,
    maxOutputTokens: 2048, timeoutMs: 60000, maxCalls: 32, maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 30000 })
  for (const value of ['', '  ', ' trailing ']) expect(() => resolveL1Config({ provider: value, model: 'test' })).toThrow()
  for (const value of [0, -1, 1.5, Infinity]) expect(() => resolveL1Config({ provider: 'test', model: 'test', timeoutMs: value })).toThrow()
  expect(() => resolveL1Config({ provider: 'test', model: 'test', retryBaseMs: 100, retryMaxMs: 1 })).toThrow()
})

it('resolves knowledge settings at load and rejects invalid scoring', async () => {
  const config = { provider: 'test', model: 'test', scoreMin: 1, scoreMax: 5, l2Threshold: 3, l3Threshold: 4 }
  const spec = await resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: config })
  expect(spec.knowledge).toEqual(resolveKnowledgeConfig(config))
  expect(spec.knowledge?.promptVersion).toBe('knowledge-v1')
  await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: { ...config, l3Threshold: 2 } })).rejects.toMatchObject({ code: 'config' })
  await expect(resolveConfig({ projectId: 'stable', databasePath: 'data/test.sqlite', knowledge: { ...config, provider: '' } })).rejects.toMatchObject({ code: 'config' })
})
