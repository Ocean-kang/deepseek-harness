/** Configuration and path checks do not create files outside the memory root. */
import { afterEach, expect, it } from 'vitest'
import { symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { fixture } from './helpers.ts'

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
