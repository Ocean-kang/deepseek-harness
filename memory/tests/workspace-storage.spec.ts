/** Real Workspace registry, JSONL capture and physically separate SQLite project stores. */
import { expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { MemoryMediaPool, MemoryStorageBackend } from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import * as MemoryPlugin from '../src/index.ts'
import { workspaceActivation, WorkspaceMemory } from '../src/workspace-storage.ts'
import { resolveConfig } from '../src/config.ts'
import { dispatchPanel } from '../src/panel-host.ts'
import { fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import { SqliteMemory } from '../src/sqlite.ts'
import type { ProjectId } from '../src/types.ts'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'

const inputL1 = z.object({ input: z.array(z.object({ sources: z.array(z.object({ sessionId: z.string(), seq: z.number() })) })) })
const inputKnowledge = z.object({ input: z.object({ sources: z.array(z.object({ id: z.string(), revision: z.number() })) }) })

class LearningAdapter extends LlmAdapter {
  calls = 0
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Expected recorded input')
    const input: unknown = JSON.parse(block.text)
    const text = options.system?.startsWith('Summarize')
      ? JSON.stringify({ kind: 'memory', summary: { goal: 'Project ESM constraint', actions: [], outcome: 'unknown', result: 'Use ESM', solution: null,
        sources: inputL1.parse(input).input.flatMap(piece => piece.sources) } })
      : JSON.stringify([{ target: null, knowledge: { title: 'ESM', body: 'Use ESM in this project', category: 'constraint', score: 4,
        rationale: 'Explicit constraint', evidence: 'supported', sources: inputKnowledge.parse(input).input.sources.map(ref => ({ kind: 'memory', ref })) } }])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(learning = false) {
  const item = await fixture()
  const ctx = new Context()
  const writers: Array<Awaited<ReturnType<typeof ctx.sessionPersistence.create>>> = []
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(item.root, 'sessions'), compression: 'none' })
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(WorkspaceRegistry)
    const paths = [join(item.root, 'project-a'), join(item.root, 'project-b')]
    await Promise.all(paths.map(path => mkdir(path)))
    const workspaces = await Promise.all(paths.map(path => ctx.workspaceRegistry.create(path)))
    // Explicit epoch avoids timing-dependent admission at test startup.
    await writeFile(join(item.root, 'workspace-storage.json'), JSON.stringify({ version: 1, activatedAt: 100 }))
    const config = { storageMode: 'workspace' as const, dataRoot: item.root, databasePath: item.spec.databasePath, projectId: 'unassigned', textSearch: {},
      ...(learning ? { autoLearning: true, l1: { provider: 'test', model: 'test' }, knowledge: { provider: 'test', model: 'test' } } : {}) }
    const adapter = new LearningAdapter()
    if (learning) { await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['test'], adapter) }
    const plugin = () => ctx.plugin({ ...MemoryPlugin, inject: [...MemoryPlugin.inject, ...(learning ? ['llm'] : [])] }, config)
    const create = async (id: string, cwd?: string, createdAt = 101) => {
      const session = ctx.sessions.create(SessionId(id), { meta: { createdAt, ...(cwd === undefined ? {} : { cwd }) } })
      writers.push(await ctx.sessionPersistence.create(session.header))
      return session
    }
    return { ...item, ctx, workspaces, config, adapter, plugin, create,
      async close() { await ctx.fiber.dispose(); await Promise.all(writers.map(writer => writer.close())); await item.close() } }
  } catch (error) { await ctx.fiber.dispose(); await Promise.all(writers.map(writer => writer.close())); await item.close(); throw error }
}

function completeTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use ESM in this project' }] }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

it('stores project conversations together, separates another project and leaves the old database untouched', async () => {
  const item = await setup()
  try {
    await writeFile(item.spec.databasePath, 'old database sentinel')
    await item.plugin()
    const sessions = await Promise.all([item.create('a', item.workspaces[0]!.path), item.create('a2', item.workspaces[0]!.path), item.create('b', item.workspaces[1]!.path), item.create('global')])
    for (const session of sessions) completeTurn(session)
    await Promise.all(sessions.map(session => item.ctx.sessions.flush(session)))
    const owners = sessions.map(session => item.ctx.memory.projectOfSession(session.id))
    expect(owners).toEqual([item.workspaces[0]!.id, item.workspaces[0]!.id, item.workspaces[1]!.id, 'unassigned'])
    for (const [i, workspace] of item.workspaces.entries()) {
      const spec = await resolveConfig({ ...item.config, dataRoot: workspace.path, projectId: workspace.id, databasePath: `memory_${workspace.id}/memory.sqlite` })
      const provider = await SqliteMemory.open(spec)
      try {
        expect(provider.listSessions(workspace.id as string as ProjectId).map(row => row.header.id)).toEqual(i === 0 ? ['a', 'a2'] : ['b'])
        expect(provider.listProjects()).toEqual([workspace.id])
      } finally { await provider.close() }
    }
    expect(await readFile(item.spec.databasePath, 'utf8')).toBe('old database sentinel')
    expect((await readFile(join(item.root, 'workspace-memory.sqlite'))).length).toBeGreaterThan(0)
    const foreign = await item.ctx.memory.readRaw({ projectId: owners[2]!, sessionId: sessions[0]!.id, from: SessionLogOffset(0), to: sessions[0]!.seq, limit: 10 })
    expect(foreign.found).toBe(false)
    await expect(item.ctx.memory.getIndexStatus('unknown' as ProjectId)).rejects.toThrow('not been initialized')
  } finally { await item.close() }
})

it('excludes old conversations on every restart and reports a dedicated panel category', async () => {
  const item = await setup()
  try {
    const old = await item.create('old', item.workspaces[0]!.path, 99)
    const first = await item.plugin()
    completeTurn(old)
    await item.ctx.sessions.flush(old)
    expect(item.ctx.memory.projectOfSession(old.id)).toBeUndefined()
    await expect(dispatchPanel(item.ctx, { action: 'state', sessionId: old.id }, new AbortController().signal)).rejects.toMatchObject({ code: 'excluded' })
    await first.dispose()
    await item.plugin()
    expect(item.ctx.memory.acceptsSession(old)).toBe(false)
    expect(await workspaceActivation(item.root)).toBe(100)
  } finally { await item.close() }
})

it('learns L1–L3 in the project database, browses exact versions, persists selections and resumes without repeat calls', async () => {
  const item = await setup(true)
  try {
    const first = await item.plugin()
    const session = await item.create('learning', item.workspaces[0]!.path)
    completeTurn(session)
    await item.ctx.sessions.flush(session)
    const project = item.ctx.memory.projectOfSession(session.id)!
    await item.ctx.memory.flushLearning(project)
    expect(item.adapter.calls).toBe(3)
    for (const level of ['L1', 'L2', 'L3'] as const) expect(await item.ctx.memory.listCandidates(project, level)).toHaveLength(1)
    const l3 = (await item.ctx.memory.listCandidates(project, 'L3'))[0]!
    const ref = { id: l3.id, revision: l3.revision }
    const another = await item.create('reader', item.workspaces[0]!.path)
    await item.ctx.sessions.flush(another)
    item.ctx.memory.browser.select(project, another.id, [ref], true)
    expect(item.ctx.memory.browser.detail(project, ref)?.level).toBe('L3')
    expect(item.ctx.memory.browser.history(project, ref.id)).toEqual([ref])
    expect((await item.ctx.memory.retrieve({ projectId: project, text: 'ESM' })).hits.some(hit => hit.ref.id === ref.id)).toBe(true)
    const foreign = await item.create('foreign', item.workspaces[1]!.path)
    await item.ctx.sessions.flush(foreign)
    expect(item.ctx.memory.browser.detail(item.ctx.memory.projectOfSession(foreign.id)!, ref)).toBeNull()
    await first.dispose()
    await item.plugin()
    await item.ctx.memory.flushLearning(project)
    expect(item.adapter.calls).toBe(3)
    expect(item.ctx.memory.browser.selection(project, another)).toMatchObject({ refs: [ref], automatic: true })
  } finally { await item.close() }
})

it('coalesces concurrent project opens and retries a failed target without selecting global storage', async () => {
  const item = await setup()
  const spec = await resolveConfig(item.config)
  const owner = new WorkspaceMemory(item.ctx, spec, 100, () => {})
  try {
    const workspace = item.workspaces[0]!
    const target = join(workspace.path, `memory_${workspace.id}`)
    await writeFile(target, 'blocking file')
    const sessions = await Promise.all([item.create('one', workspace.path), item.create('two', workspace.path)])
    await expect(owner.resolveSession(sessions[0]!)).rejects.toThrow()
    expect(owner.projectOfSession(sessions[0]!.id)).toBeUndefined()
    await unlink(target)
    const opens = vi.spyOn(SqliteMemory, 'open')
    try {
      opens.mockRejectedValueOnce(Object.assign(new Error('Project directory is not writable'), { code: 'EACCES' }))
      await expect(owner.resolveSession(sessions[0]!)).rejects.toMatchObject({ code: 'EACCES' })
      expect(owner.projectOfSession(sessions[0]!.id)).toBeUndefined()
      opens.mockClear()
      await Promise.all(sessions.map(session => owner.resolveSession(session)))
      expect(opens).toHaveBeenCalledTimes(1)
    } finally { opens.mockRestore() }
    expect(owner.get(workspace.id as string as ProjectId).provider.listProjects()).toEqual([])
    expect(sessions.map(session => owner.projectOfSession(session.id))).toEqual([workspace.id, workspace.id])
  } finally { await owner.close(); await item.close() }
})

it('logs manual and automatic recall for the selected workspace and disables sharing', async () => {
  const item = await setup(true)
  try {
    await item.ctx.plugin(SessionProjectionRegistry)
    await item.ctx.plugin(SystemPrompt)
    await item.ctx.plugin(ToolRuntime)
    await item.ctx.plugin(AgentRegistry)
    await item.ctx.plugin(AgentLoop, { agents: [] })
    await item.ctx.plugin(CommandRuntime)
    const responses = new MockAdapter([textResponse('manual'), textResponse('automatic'), textResponse('foreign')])
    item.ctx.llm.registerAdapter(['mock'], responses)
    await item.ctx.plugin({ ...MemoryPlugin, inject: [...MemoryPlugin.inject, 'llm'] }, { ...item.config, injection: true })
    const source = await item.create('source', item.workspaces[0]!.path)
    completeTurn(source)
    await item.ctx.sessions.flush(source)
    const project = item.ctx.memory.projectOfSession(source.id)!
    await item.ctx.memory.flushLearning(project)
    const memory = (await item.ctx.memory.listCandidates(project, 'L3'))[0]!
    const ref = { id: memory.id, revision: memory.revision }
    const agents = []
    const transcript = []
    for (const [index, name] of ['manual', 'automatic', 'foreign'].entries()) {
      const agent = await item.ctx.agentLoop.create(SessionId(name), { provider: 'mock', model: 'mock' }, { cwd: item.workspaces[index === 2 ? 1 : 0]!.path })
      await item.ctx.sessions.flush(agent.session)
      const owner = item.ctx.memory.projectOfSession(agent.session.id)!
      item.ctx.memory.browser.select(owner, agent.session.id, index === 0 ? [ref] : [], index !== 0)
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ESM' }] }))
      await agent.whenIdle()
      await item.ctx.sessions.flush(agent.session)
      const recalled = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')
      expect(recalled).toHaveLength(index === 2 ? 0 : 1)
      if (recalled[0]?.type === 'user/message') expect(responses.requests[index]!.messages).toContainEqual(recalled[0].data)
      expect(item.ctx.memory.browser.selection(owner, agent.session)?.refs).toEqual([])
      transcript.push({ conversation: name, sameProject: owner === project, recalls: recalled.length,
        loggedInModelRequest: recalled.every(event => event.type === 'user/message' && responses.requests[index]!.messages.includes(event.data)),
        pending: item.ctx.memory.browser.selection(owner, agent.session)?.refs.length })
      agents.push(agent)
    }
    const result = await item.ctx.commands.execute(agents[0]!, '/memory-share approve example', [], new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'error', text: 'Cross-project sharing is disabled in workspace storage mode.' })
    expect(JSON.stringify({ transcript, sharing: result?.result }, null, 2) + '\n').toMatchFileSnapshot('./expected/workspace-recall.json')
  } finally { await item.close() }
})

it('rejects directory junctions and does not write through them', async () => {
  const item = await setup()
  const owner = new WorkspaceMemory(item.ctx, await resolveConfig(item.config), 100, () => {})
  const workspace = item.workspaces[0]!
  const target = join(workspace.path, `memory_${workspace.id}`)
  try {
    await symlink(item.workspaces[1]!.path, target, process.platform === 'win32' ? 'junction' : 'dir')
    const session = await item.create('linked', workspace.path)
    await expect(owner.resolveSession(session)).rejects.toMatchObject({ code: 'config' })
    await expect(readFile(join(item.workspaces[1]!.path, 'memory.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await unlink(target); await owner.close(); await item.close() }
})

it('recovers existing project L0 without a live source conversation', async () => {
  const item = await setup(true)
  try {
    const workspace = item.workspaces[0]!
    const project = workspace.id as string as ProjectId
    const spec = await resolveConfig({ ...item.config, projectId: project, dataRoot: workspace.path, databasePath: `memory_${project}/memory.sqlite` })
    const provider = await SqliteMemory.open(spec)
    await provider.appendRaw({ projectId: project, header: { ...header('unloaded'), createdAt: 101 }, inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
    await provider.close()
    await item.plugin()
    await item.ctx.memory.flushLearning(project)
    expect(await item.ctx.memory.listCandidates(project, 'L3')).toHaveLength(1)
  } finally { await item.close() }
})

it('does not extract a partially inherited turn in workspace mode', async () => {
  const item = await fixture()
  const spec = await resolveConfig({ ...item.spec, storageMode: 'workspace', l1: { provider: 'test', model: 'test' } })
  const provider = await SqliteMemory.open(spec)
  try {
    await provider.appendRaw({ projectId: spec.projectId, header: { ...header('fork'), isSeeded: true }, inheritedEventCount: SessionLogOffset(2), events: turnEvents() })
    expect(provider.scanTurns(spec.projectId, spec.l1!, 1)).toBe(0)
  } finally { await provider.close(); await item.close() }
})

it('publishes one complete activation epoch under concurrent first use and rejects damaged state', async () => {
  const item = await fixture()
  try {
    const epochs = await Promise.all(Array.from({ length: 8 }, () => workspaceActivation(item.root)))
    expect(new Set(epochs).size).toBe(1)
    expect(await workspaceActivation(item.root)).toBe(epochs[0])
    const target = join(item.root, 'workspace-storage.json')
    await rename(target, join(item.root, 'original.json'))
    await writeFile(target, '{broken')
    await expect(workspaceActivation(item.root)).rejects.toMatchObject({ code: 'config' })
  } finally { await item.close() }
})
