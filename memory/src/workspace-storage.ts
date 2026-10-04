/** Workspace-owned databases with one activation epoch and plugin-wide learning limits. */
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { memoryPath } from './config.ts'
import type { Spec } from './config.ts'
import { RawCollector } from './collector.ts'
import { HttpEmbedder } from './embedding.ts'
import { MemoryService } from './index.ts'
import type { MemoryRoutes, MemoryRuntime } from './index.ts'
import { installMemoryInjector } from './injector.ts'
import { installPanelHost } from './panel-host.ts'
import { LearningBudget, MemoryPipeline } from './pipeline.ts'
import { enqueueCandidates } from './knowledge-store.ts'
import { MemoryRetriever } from './retrieval.ts'
import { SqliteMemory } from './sqlite.ts'
import { TextMemoryRetriever } from './text-retrieval.ts'
import { queryExpander } from './query-expansion.ts'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'

const activation = z.object({ version: z.literal(1), activatedAt: z.number().int().nonnegative() }).strict()

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** Read or atomically publish the first activation time without replacing an existing record.
 * @param root - configured global memory directory.
 * @returns the durable cutoff in epoch milliseconds.
 */
export async function workspaceActivation(root: string): Promise<number> {
  const target = await memoryPath('workspace-storage.json', root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  try { return activation.parse(JSON.parse(await readFile(target, 'utf8'))).activatedAt } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new MemoryError('config', 'Workspace activation record is unreadable or invalid', error)
  }
  const temporary = await memoryPath(`.workspace-activation-${randomUUID()}.tmp`, root)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, activatedAt: Date.now() })}\n`)
      await file.sync()
    } finally { await file.close() }
    try { await link(temporary, target) } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    return activation.parse(JSON.parse(await readFile(target, 'utf8'))).activatedAt
  } finally {
    try { await unlink(temporary) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }
}

/** Owns loaded project connections; a failed open can be retried from canonical Session logs. */
export class WorkspaceMemory implements MemoryRoutes {
  private readonly runtimes = new Map<ProjectId, MemoryRuntime>()
  private readonly opening = new Map<ProjectId, Promise<MemoryRuntime>>()
  private readonly sessions = new Map<SessionId, ProjectId>()
  private readonly budget = new LearningBudget()
  private readonly listeners: Array<() => void> = []
  private closing = false

  /** @param ctx - profile services and optional Workspace registry.
   * @param spec - validated deployment settings.
   * @param activatedAt - persisted activation cutoff.
   * @param report - nonthrowing body-free diagnostic observer.
   */
  constructor(private readonly ctx: Context, private readonly spec: Spec, readonly activatedAt: number, private readonly report: (error: MemoryError) => void) {}

  /** @param session - candidate Session.
   * @returns whether it was created after activation.
   */
  accepts(session: Pick<Session, 'header'>): boolean { return session.header.createdAt >= this.activatedAt }

  /** @param sessionId - canonical identity.
   * @returns resolved project, or undefined before successful route initialization.
   */
  projectOfSession(sessionId: SessionId): ProjectId | undefined { return this.sessions.get(sessionId) }

  /** @param project - captured project identity.
   * @returns open runtime; unresolved identities reject rather than selecting the global database.
   */
  get(project: ProjectId): MemoryRuntime {
    if (this.closing) throw new MemoryError('closed', 'Workspace memory is closing')
    const runtime = this.runtimes.get(project)
    if (runtime === undefined) throw new MemoryError('source', 'Memory project has not been initialized')
    return runtime
  }

  /** Resolve a new Session exactly once after its project database opens.
   * @param session - eligible live Session.
   * @returns initialized project identity.
   */
  async resolveSession(session: Session): Promise<ProjectId> {
    if (!this.accepts(session)) throw new MemoryError('excluded', 'Session predates Workspace memory activation')
    const stored = this.sessions.get(session.id)
    if (stored !== undefined) return stored
    const workspace = session.header.cwd === undefined ? undefined : await this.ctx.get('workspaceRegistry')?.resolveByPath(session.header.cwd)
    const project = workspace === undefined ? this.spec.projectId : String(workspace.id) as ProjectId
    await this.ensure(project, workspace?.path)
    this.sessions.set(session.id, project)
    return project
  }

  /** Open the new global store and recover databases of registered Workspaces.
   * @returns completion after existing project tasks are scheduled for recovery.
   */
  async recover(): Promise<void> {
    await this.ensure(this.spec.projectId)
    for (const workspace of this.ctx.get('workspaceRegistry')?.list() ?? []) {
      const directory = `memory_${workspace.id}`
      const database = await memoryPath(join(directory, 'memory.sqlite'), workspace.path)
      try { await lstat(database) } catch (error) {
        if (hasCode(error, 'ENOENT')) continue
        throw error
      }
      await this.ensure(String(workspace.id) as ProjectId, workspace.path)
    }
  }

  private ensure(project: ProjectId, workspacePath?: string): Promise<MemoryRuntime> {
    if (this.closing) return Promise.reject(new MemoryError('closed', 'Workspace memory is closing'))
    const runtime = this.runtimes.get(project)
    if (runtime !== undefined) return Promise.resolve(runtime)
    const pending = this.opening.get(project)
    if (pending !== undefined) return pending
    const operation = this.create(project, workspacePath)
    this.opening.set(project, operation)
    void operation.finally(() => { this.opening.delete(project) }).catch(() => undefined)
    return operation
  }

  private async create(project: ProjectId, workspacePath?: string): Promise<MemoryRuntime> {
    if (workspacePath !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(project)) {
      throw new MemoryError('config', 'Workspace memory requires a UUID project identity')
    }
    const databasePath = workspacePath === undefined
      ? await memoryPath('workspace-memory.sqlite', this.spec.dataRoot)
      : await memoryPath(join(`memory_${project}`, 'memory.sqlite'), workspacePath)
    const dataRoot = workspacePath ?? this.spec.dataRoot
    const provider = await SqliteMemory.open({ ...this.spec, projectId: project, dataRoot, databasePath })
    let retriever: MemoryRuntime['retriever']
    let pipeline: MemoryRuntime['pipeline']
    try {
      if (provider.listProjects().some(owner => owner !== project)) throw new MemoryError('conflict', 'Workspace database contains another project')
      const embedder = this.spec.embedding === undefined ? undefined : new HttpEmbedder(this.spec.embedding, process.env[this.spec.embedding.apiKeyEnv] ?? '')
      const llm = this.ctx.get('llm')
      retriever = this.spec.textSearch !== undefined ? new TextMemoryRetriever(provider, this.spec.textSearch,
        this.spec.textSearch.expandQuery ? queryExpander(provider, llm!, this.spec.l1!, this.spec.textSearch) : undefined)
        : this.spec.embedding === undefined || embedder === undefined ? undefined : new MemoryRetriever(provider, this.spec.embedding, embedder, this.report)
      pipeline = this.spec.autoLearning && llm !== undefined ? new MemoryPipeline(provider, this.spec, llm, this.report, retriever, this.budget) : undefined
      const runtime: MemoryRuntime = { provider, ...(retriever === undefined ? {} : { retriever }), ...(pipeline === undefined ? {} : { pipeline }) }
      const recoveredSessions: SessionId[] = []
      let after = ''
      for (;;) {
        const sessions = provider.listSessions(project, after, this.spec.pageSize)
        for (const source of sessions) {
          const owner = this.sessions.get(source.header.id)
          if (owner !== undefined && owner !== project) throw new MemoryError('conflict', 'Session is stored in more than one memory project')
          if (source.header.createdAt >= this.activatedAt) recoveredSessions.push(source.header.id)
        }
        if (sessions.length < this.spec.pageSize) break
        after = sessions.at(-1)!.header.id
      }
      for (const sessionId of recoveredSessions) this.sessions.set(sessionId, project)
      this.runtimes.set(project, runtime)
      this.listeners.push(provider.onMemoryChange(() => this.enqueue(project, runtime)))
      this.enqueue(project, runtime)
      this.scan(project)
      retriever?.schedule()
      return runtime
    } catch (error) {
      this.runtimes.delete(project)
      await Promise.allSettled([pipeline?.close(), retriever?.close()])
      await provider.close()
      throw error
    }
  }

  private enqueue(project: ProjectId, runtime: MemoryRuntime): void {
    if (this.closing || this.spec.knowledge === undefined) return
    try {
      for (const level of ['L2', 'L3'] as const) enqueueCandidates(runtime.provider.knowledge, project, level, this.spec.knowledge, this.spec.pageSize)
    } catch (error) { this.report(new MemoryError('storage', 'Knowledge enqueue failed; sources remain available for retry', error)) }
  }

  /** Scan committed source turns and wake this project's learner.
   * @param project - initialized project.
   */
  scan(project: ProjectId): void {
    if (this.closing || this.spec.l1 === undefined) return
    try {
      const runtime = this.get(project)
      runtime.provider.scanTurns(project, this.spec.l1, this.spec.pageSize)
      runtime.pipeline?.wake(project)
    } catch (error) { this.report(new MemoryError('source', 'L1 scan failed; its committed checkpoint is retained', error)) }
  }

  /** Stop notifications and settle all work before releasing databases.
   * @returns completion after each connection closes, including connections opened during shutdown.
   */
  async close(): Promise<void> {
    // Capture is drained by the caller before this owner starts closing.
    await Promise.allSettled([...this.opening.values()])
    this.closing = true
    for (const dispose of this.listeners) dispose()
    const runtimes = [...this.runtimes.values()]
    const results = await Promise.allSettled(runtimes.map(async runtime => {
      try {
        const settled = await Promise.allSettled([runtime.pipeline?.close(), runtime.retriever?.close()])
        const failures = settled.filter(result => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Workspace workers failed to close')
      } finally { await runtime.provider.close() }
    }))
    this.runtimes.clear()
    this.sessions.clear()
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Workspace databases failed to close')
  }
}

/** Install Session routing, logged recall and optional panel over Workspace-owned databases.
 * @param ctx - profile context with Session persistence.
 * @param spec - resolved Workspace mode settings.
 * @returns readiness after eligible live Sessions are captured.
 */
export async function installWorkspaceMemory(ctx: Context, spec: Spec): Promise<void> {
  const report = (error: MemoryError) => ctx.logger.warn(`[memory/${error.code}] ${error.message}`)
  const routes = new WorkspaceMemory(ctx, spec, await workspaceActivation(spec.dataRoot), report)
  let collector: RawCollector | undefined
  let panelDispose: (() => Promise<void>) | undefined
  let injectorDispose: (() => Promise<void>) | undefined
  const listeners: Array<() => void> = []
  const dispose = async () => {
    for (const stop of listeners) stop()
    try {
      await Promise.all([injectorDispose?.(), panelDispose?.()])
    } finally {
      try { await collector?.close() } finally { await routes.close() }
    }
  }
  try {
    await routes.recover()
    collector = new RawCollector({
      appendRaw: request => routes.get(request.projectId).provider.appendRaw(request),
      readRaw: request => routes.get(request.projectId).provider.readRaw(request),
    }, ctx.sessionPersistence, spec, report, project => routes.scan(project), session => routes.resolveSession(session))
    const capture = collector
    listeners.push(ctx.on('session/created', session => { if (routes.accepts(session)) capture.adopt(session) }))
    listeners.push(ctx.on('session/event', (session, event) => { if (routes.accepts(session)) capture.capture(session, event) }))
    listeners.push(ctx.on('session/flush', session => routes.accepts(session) ? capture.flush(session) : Promise.resolve()))
    listeners.push(ctx.on('session/disposed', session => capture.retire(session)))
    const existing = ctx.sessions.list().filter(session => routes.accepts(session))
    for (const session of existing) capture.adopt(session)
    await Promise.all(existing.map(session => capture.flush(session)))
    const global = routes.get(spec.projectId)
    const service = new MemoryService(ctx, global.provider, spec.l1, project => routes.scan(project), spec.browser, global.retriever, global.pipeline, routes)
    if (spec.injection && (spec.textSearch !== undefined || spec.embedding !== undefined)) {
      const search = (project: ProjectId) => {
        const retriever = routes.get(project).retriever
        if (retriever === undefined) throw new MemoryError('config', 'Project retriever is unavailable')
        return retriever
      }
      injectorDispose = installMemoryInjector(ctx, {
        retrieve: request => search(request.projectId).retrieve(request),
        revalidate: (project, result) => search(project).revalidate(project, result),
      }, async agent => {
        await capture.flush(agent.session)
        return routes.resolveSession(agent.session)
      }, report, service.browser, agent => routes.accepts(agent.session))
    }
    if (spec.panel) panelDispose = installPanelHost(ctx)
    ctx.inject(['commands'], commandCtx => {
      commandCtx.commands.register({ name: 'memory-share', description: 'Workspace memory sharing is disabled',
        handler: () => ({ kind: 'error', text: 'Cross-project sharing is disabled in workspace storage mode.' }) })
    })
    ctx.effect(() => dispose, 'memory.workspace-databases')
    // oxlint-disable-next-line typescript/no-misused-promises -- Cordis awaits injected plugin setup and disposal.
    ctx.inject(['workspaceRegistry'], async () => { await routes.recover() })
  } catch (error) {
    try { await dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Workspace memory startup and cleanup failed') }
    throw error
  }
}
