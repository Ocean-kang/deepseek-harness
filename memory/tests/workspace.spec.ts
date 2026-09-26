/** Workspace ownership over real Cordis, canonical paths, JSONL and SQLite. */
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import * as MemoryPlugin from '../src/index.ts'
import type { ProjectId } from '../src/types.ts'
import { fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const item = await fixture()
  const ctx = new Context()
  cleanups.push(async () => { try { await ctx.fiber.dispose() } finally { await item.close() } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(item.root, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(WorkspaceRegistry)
  const paths = [join(item.root, 'a'), join(item.root, 'b')]
  for (const path of paths) await mkdir(path)
  const a = await ctx.workspaceRegistry.create(paths[0]!)
  const b = await ctx.workspaceRegistry.create(paths[1]!)
  const options = { projectId: item.spec.projectId, databasePath: item.spec.databasePath, queueCapacity: 1, batchSize: 1, pageSize: 1, l1: { provider: 'test', model: 'test' } }
  async function session(id: string, cwd?: string) {
    const value = ctx.sessions.create(SessionId(id), { meta: { ...(cwd === undefined ? {} : { cwd }) } })
    await ctx.sessionPersistence.create(value.header)
    return value
  }
  return { ...item, ctx, a, b, options, session }
}

it('isolates workspaces, recovers overflow, and keeps old ownership across reloads', async () => {
  const item = await setup()
  const { ctx, a, b } = item
  const old = await item.session('old', a.path)
  const db = await item.open()
  await db.appendRaw({ projectId: item.spec.projectId, header: old.header, inheritedEventCount: old.inheritedEventCount, events: [] })
  const plugin = await ctx.plugin(MemoryPlugin, item.options)
  const first = await item.session('first', a.path)
  const link = join(item.root, 'alias')
  await symlink(a.path, link, process.platform === 'win32' ? 'junction' : 'dir')
  cleanups.push(() => unlink(link))
  const alias = await item.session('alias', link)
  const second = await item.session('second', b.path)
  const rows = [[old, item.spec.projectId], [first, String(a.id) as ProjectId], [alias, String(a.id) as ProjectId], [second, String(b.id) as ProjectId]] as const
  for (const [session, project] of rows) {
    for (let turn = 1; turn <= 3; turn++) {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    await ctx.sessions.flush(session)
    await ctx.sessions.flush(session)
    const request = { projectId: project, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 }
    expect((await ctx.memory.readRaw(request)).events).toEqual(session.snapshotEvents())
    const foreign = project === String(b.id) ? String(a.id) as ProjectId : String(b.id) as ProjectId
    expect((await ctx.memory.readRaw({ ...request, projectId: foreign })).found).toBe(false)
    expect(db.getSessionProject(session.id)).toBe(project)
  }
  expect(await ctx.memory.listTasks(String(a.id) as ProjectId, '', 100)).toHaveLength(6)
  expect(await ctx.memory.listTasks(String(b.id) as ProjectId, '', 100)).toHaveLength(3)
  expect(await ctx.memory.listTasks(item.spec.projectId, '', 100)).toHaveLength(3)
  await plugin.dispose()
  const lookup = vi.spyOn(ctx.workspaceRegistry, 'resolveByPath')
  const reloaded = await ctx.plugin(MemoryPlugin, item.options)
  for (const [session, project] of rows) {
    session.append('turn/start', { turn: 4 })
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    expect(db.getSessionProject(session.id)).toBe(project)
  }
  expect(lookup).not.toHaveBeenCalled()
  lookup.mockRestore()
  await reloaded.dispose()
})

it('falls back for absent cwd, missing directories and unowned directories', async () => {
  const item = await setup()
  await item.ctx.plugin(MemoryPlugin, item.options)
  const db = await item.open()
  const file = join(item.root, 'file')
  await writeFile(file, '')
  for (const [id, cwd] of [['no-cwd', undefined], ['missing', join(item.root, 'gone')], ['unowned', item.root], ['not-directory', join(file, 'child')]] as const) {
    const session = await item.session(id, cwd)
    await item.ctx.sessions.flush(session)
    expect(db.getSessionProject(session.id)).toBe(item.spec.projectId)
  }
  const unowned = item.ctx.sessions.get(SessionId('unowned'))!
  await item.ctx.workspaceRegistry.create(item.root)
  unowned.append('turn/start', { turn: 1 })
  await item.ctx.sessions.flush(unowned)
  expect(db.getSessionProject(unowned.id)).toBe(item.spec.projectId)
})

it('does not bind a failed lookup and retries at the next explicit flush', async () => {
  const item = await setup()
  const plugin = await item.ctx.plugin(MemoryPlugin, item.options)
  const lookup = vi.spyOn(item.ctx.workspaceRegistry, 'resolveByPath').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  const db = await item.open()
  try {
    const session = await item.session('retry', item.a.path)
    await expect(item.ctx.sessions.flush(session)).rejects.toThrow()
    expect(db.getSessionProject(session.id)).toBeUndefined()
    lookup.mockRestore()
    await item.ctx.sessions.flush(session)
    expect(db.getSessionProject(session.id)).toBe(item.a.id)
  } finally {
    lookup.mockRestore()
    await plugin.dispose()
  }
})

it('scans unloaded projects at startup and explicit append projects after commit', async () => {
  const item = await setup()
  const db = await item.open()
  const projects = [String(item.a.id) as ProjectId, String(item.b.id) as ProjectId]
  for (const [index, projectId] of projects.entries()) {
    await db.appendRaw({ projectId, header: header(`unloaded-${index}`), inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
  }
  await item.ctx.plugin(MemoryPlugin, item.options)
  for (const project of projects) expect(await item.ctx.memory.listTasks(project, '', 100)).toHaveLength(1)
  const direct = 'explicit-project' as ProjectId
  await item.ctx.memory.appendRaw({ projectId: direct, header: header('direct'), inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
  expect(await item.ctx.memory.listTasks(direct, '', 100)).toHaveLength(1)
  expect(db.listProjects()).toEqual([...projects, direct].sort())
})

it('loads memory from YAML and captures Workspace-owned events through the Loader', async () => {
  const item = await setup()
  const configPath = join(item.root, 'cordis.yml')
  await writeFile(configPath, `- name: cordis:memory\n  config: ${JSON.stringify(item.options)}\n`)
  item.ctx.baseUrl = `${pathToFileURL(item.root).href}/`
  await item.ctx.plugin(Loader)
  item.ctx.loader.builtins.include = Include
  item.ctx.loader.builtins.memory = MemoryPlugin
  await item.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await item.ctx.loader.await()
  const session = await item.session('yaml', item.a.path)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await item.ctx.sessions.flush(session)
  const projectId = String(item.a.id) as ProjectId
  const request = { projectId, sessionId: session.id, from: SessionLogOffset(0), to: session.seq, limit: 100 }
  expect((await item.ctx.memory.readRaw(request)).events).toEqual(session.snapshotEvents())
  expect((await item.ctx.memory.readRaw({ ...request, projectId: item.spec.projectId })).found).toBe(false)
  expect(await item.ctx.memory.listTasks(projectId, '', 10)).toMatchObject([{ status: 'pending', projectId }])
})
