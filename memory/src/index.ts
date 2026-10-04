/** Cordis L0 plugin: publishes readiness only after database and capture initialization. */
import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveConfig } from './config.ts'
import type { Config as ConfigInput } from './config.ts'
import { SqliteMemory } from './sqlite.ts'
import { HttpEmbedder } from './embedding.ts'
import { MemoryRetriever } from './retrieval.ts'
import type { RetrievalRequest, MemorySearch } from './retrieval.ts'
import { TextMemoryRetriever } from './text-retrieval.ts'
import { MemoryPipeline } from './pipeline.ts'
import { queryExpander } from './query-expansion.ts'
import { enqueueCandidates } from './knowledge-store.ts'
import type {} from '@deepseek-ai/dsh-llm'
import { RawCollector } from './collector.ts'
import { installShareCommand } from './share-command.ts'
import { MemoryError } from './types.ts'
import { MemoryBrowser } from './browser.ts'
import { installPanelHost } from './panel-host.ts'
import { installMemoryInjector } from './injector.ts'
import type { AppendRawRequest, AppendRawResult, RawMemory, ReadRawRequest, ReadRawResult } from './types.ts'
import type { ProjectId } from './types.ts'
import type { L1Spec, L1Task, MemoryRef, OperationId } from './l1-types.ts'

import type { KnowledgeLevel, KnowledgeSpec, OwnedMemory, SharedMemory } from './knowledge-types.ts'

export type * from './embedding.ts'
export type * from './retrieval.ts'
export { resolveEmbeddingConfig, HttpEmbedder } from './embedding.ts'
export { MemoryRetriever } from './retrieval.ts'
export { TextMemoryRetriever, resolveTextSearchConfig } from './text-retrieval.ts'
export type { TextSearchConfig, TextSearchSpec } from './text-retrieval.ts'
export { installMemoryInjector } from './injector.ts'
export { MemoryBrowser, resolveBrowserConfig } from './browser.ts'
export type * from './browser.ts'
export type { MemorySelection } from './selection-store.ts'
export type * from './knowledge-types.ts'
export { resolveKnowledgeConfig } from './l1-config.ts'
export { KnowledgeExtractor } from './knowledge-extractor.ts'
export type { KnowledgeRecorder } from './knowledge-extractor.ts'
export { KnowledgeWorker } from './knowledge-worker.ts'
export { MemoryRequestJournal } from './request-journal.ts'
export { MemoryPipeline } from './pipeline.ts'
export { resolveConfig } from './config.ts'
export type { Spec } from './config.ts'
export type * from './types.ts'
export type * from './l1-types.ts'
export { L1Extractor, L1ModelError } from './l1-extractor.ts'
export type { L1Request, L1Recorder } from './l1-extractor.ts'
export { L1Worker } from './l1-worker.ts'
export { SqliteMemory } from './sqlite.ts'
export { resolveL1Config } from './l1-config.ts'
/** Loader configuration request. */
export type Config = ConfigInput
/** Loader-visible validation; cross-field and filesystem checks live in resolveConfig. */
export const Config: z<Config> = z.object({
  dataRoot: z.string(), projectByPath: z.boolean(), storageMode: z.union(['central', 'workspace'] as const),
  injection: z.boolean(),
  panel: z.boolean(),
  browser: z.object({ pageSize: z.number(), maxQueryBytes: z.number(), limit: z.number(), maxBytes: z.number(),
    refreshIntervalMs: z.number(), stateCacheSessions: z.number() }),
  autoLearning: z.boolean(),
  projectId: z.string().required(), databasePath: z.string().required(),
  queueCapacity: z.number(), batchSize: z.number(), pageSize: z.number(), busyTimeoutMs: z.number(),
  learningConcurrency: z.number(), learningQueueCapacity: z.number(),
  textSearch: z.union([z.object({ tokenizer: z.union(['unicode61', 'trigram'] as const), limit: z.number(), maxBytes: z.number(),
    maxCandidates: z.number(), pageSize: z.number(), timeoutMs: z.number(), maxQueryBytes: z.number(), maxTerms: z.number(),
    expandQuery: z.boolean(), expansionTimeoutMs: z.number(),
  }), z.const(undefined)]),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const),
  embedding: z.union([z.object({ endpoint: z.string().required(), model: z.string().required(), dimensions: z.number().required(), apiKeyEnv: z.string().required(),
    sendDimensions: z.boolean(), batchSize: z.number(), concurrency: z.number(), timeoutMs: z.number(), maxAttempts: z.number(), retryBaseMs: z.number(), retryMaxMs: z.number(),
    retrievalTimeoutMs: z.number(), limit: z.number(), maxBytes: z.number(), threshold: z.number(), pageSize: z.number(), maxCandidates: z.number(),
  }), z.const(undefined)]),
  l1: z.union([z.object({
    provider: z.string().required(), model: z.string().required(),
    maxInputBytes: z.number(), maxOutputTokens: z.number(), timeoutMs: z.number(), maxCalls: z.number(),
    maxAttempts: z.number(), retryBaseMs: z.number(), retryMaxMs: z.number(),
  }), z.const(undefined)]),
  knowledge: z.union([z.object({
    provider: z.string().required(), model: z.string().required(),
    maxInputBytes: z.number(), maxOutputTokens: z.number(), timeoutMs: z.number(), maxCalls: z.number(),
    maxAttempts: z.number(), retryBaseMs: z.number(), retryMaxMs: z.number(),
    scoreMin: z.number(), scoreMax: z.number(), l2Threshold: z.number(), l3Threshold: z.number(),
  }), z.const(undefined)]),
})
/** Plugin identity. */
export const name = 'memory-l0'
/** Canonical storage is required; Workspace lookup uses optional ctx.get access. */
export const inject = ['sessions', 'sessionPersistence']

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Project runtime selected by the Workspace storage owner. */
export interface MemoryRuntime {
  readonly provider: SqliteMemory
  readonly retriever?: MemorySearch
  readonly pipeline?: MemoryPipeline
}

/** Loaded project runtimes; capture resolves a route before synchronous browser reads. */
export interface MemoryRoutes {
  /** @param project - captured project identity.
   * @returns initialized runtime; unknown identities reject.
   */
  get(project: ProjectId): MemoryRuntime
  /** @param sessionId - live Session identity.
   * @returns owner once its route is resolved.
   */
  projectOfSession(sessionId: import('@deepseek-ai/dsh-session').SessionId): ProjectId | undefined
  /** @param session - candidate Session.
   * @returns whether the Session was created after activation.
   */
  accepts(session: Pick<import('@deepseek-ai/dsh-session').Session, 'header'>): boolean
}

/** Context-facing minimal persistence API, available after collector initialization. */
export class MemoryService extends Service implements RawMemory {
  /** Authorized browsing and durable next-turn selection for trusted adapters. */
  readonly browser: MemoryBrowser
  /** @param sessionId - canonical captured Session identity.
   * @returns immutable project owner, or undefined before capture registration.
   */
  projectOfSession(sessionId: import('@deepseek-ai/dsh-session').SessionId): ProjectId | undefined { return this.routes === undefined ? this.provider.getSessionProject(sessionId) : this.routes.projectOfSession(sessionId) }
  /**
   * Publish the ready provider through Cordis.
   * @param ctx - owning plugin context.
   * @param provider - ready SQLite provider.
   * @param l1 - resolved extraction configuration, if task scanning is enabled.
   * @param retriever - optional explicitly selected text or vector search.
   * @param scan - nonthrowing notification after L0 commits.
   * @param pipeline - optional background learner, disposed separately before the database.
   * @param browser - resolved browser and combined injection limits.
   * @param routes - optional initialized Workspace runtimes and activation policy.
   */
  constructor(ctx: Context, private readonly provider: SqliteMemory, private readonly l1: L1Spec | undefined, private readonly scan: (project: ProjectId) => void, browser: import('./browser.ts').BrowserSpec, private readonly retriever?: MemorySearch, private readonly pipeline?: MemoryPipeline, private readonly routes?: MemoryRoutes) {
    super(ctx, 'memory')
    this.browser = new MemoryBrowser(routes === undefined ? provider : project => routes.get(project).provider, browser)
  }

  /** Await due learning work after source capture has committed.
   * @param project - owner to process.
   * @param signal - caller cancellation; committed sources remain available.
   * @returns settlement of due work; inspect persisted task states for individual failures.
   */
  async flushLearning(project: ProjectId, signal?: AbortSignal): Promise<void> {
    const pipeline = this.pipelineFor(project)
    if (pipeline === undefined) throw new MemoryError('config', 'autoLearning is not enabled')
    await pipeline.flush(project, signal)
  }

  /** Whether capture and recall are enabled for this Session.
   * @param session - live or persisted Session metadata.
   * @returns false for Sessions predating Workspace storage activation.
   */
  acceptsSession(session: Pick<import('@deepseek-ai/dsh-session').Session, 'header'>): boolean { return this.routes?.accepts(session) ?? true }

  private providerFor(project: ProjectId): SqliteMemory { return this.routes === undefined ? this.provider : this.routes.get(project).provider }
  private pipelineFor(project: ProjectId): MemoryPipeline | undefined { return this.routes === undefined ? this.pipeline : this.routes.get(project).pipeline }

  /** @param project - captured owner.
   * @returns whether background extraction is configured for this project's database.
   */
  learningEnabled(project: ProjectId): boolean { return this.pipelineFor(project) !== undefined }

  /** @param project - captured owner.
   * @returns configured retrieval method for user-facing limitations.
   */
  recallMethod(project: ProjectId): 'disabled' | 'vector' | 'unicode61' | 'trigram' {
    const retriever = this.routes === undefined ? this.retriever : this.routes.get(project).retriever
    return retriever === undefined ? 'disabled' : retriever instanceof TextMemoryRetriever ? retriever.spec.tokenizer : 'vector'
  }

  private search(project?: ProjectId): MemorySearch {
    if (this.routes !== undefined && project === undefined) throw new MemoryError('config', 'Workspace search requires a project')
    const retriever = this.routes === undefined ? this.retriever : this.routes.get(project!).retriever
    if (retriever === undefined) throw new MemoryError('config', 'textSearch or embedding configuration is required')
    return retriever
  }

  /** Retrieve authorized version-bound references.
   * @param request - accepted user query and project.
   * @returns budgeted references; rejects on unavailable or incomplete index.
   */
  async retrieve(request: RetrievalRequest) { return this.search(request.projectId).retrieve(request) }

  /** Inspect completeness for the requesting project.
   * @param project - requester.
   * @returns candidate counts and worker state.
   */
  async getIndexStatus(project: ProjectId) { return this.search(project).getIndexStatus(project) }

  /** Rebuild the configured index; text search has no retained index to rebuild.
   * @param project - required Workspace identity in workspace mode; optional in central mode.
   * @returns completion after the selected index is rebuilt.
   */
  async rebuildIndex(project?: ProjectId): Promise<void> {
    return this.search(project).rebuildIndex()
  }

  /**
   * Commit an ordered source batch.
   * @param request - complete ordered source batch.
   * @returns durable transaction result.
   */
  async appendRaw(request: AppendRawRequest): Promise<AppendRawResult> {
    if (this.routes !== undefined && !this.routes.accepts({ header: request.header })) throw new MemoryError('excluded', 'Session predates Workspace memory activation')
    const result = await this.providerFor(request.projectId).appendRaw(request)
    this.scan(request.projectId)
    return result
  }

  /**
   * Read a project-owned interval without hiding missing events.
   * @param request - project-owned interval and page.
   * @returns ordered events and missing ranges.
   */
  readRaw(request: ReadRawRequest): Promise<ReadRawResult> {
    return this.providerFor(request.projectId).readRaw(request)
  }

  /**
   * Read owned history or an approved current L3 projection.
   * @param project - owning project.
   * @param ref - immutable version reference.
   * @returns visible memory or null; shared records exclude private sources.
   */
  async getMemory(project: ProjectId, ref: MemoryRef): Promise<OwnedMemory | SharedMemory | null> {
    return this.providerFor(project).knowledge.getMemory(project, ref)
  }

  /** Page active usable memory versions.
   * @param project - requesting project.
   * @param level - requested level.
   * @param after - exclusive identity cursor.
   * @param limit - positive page size.
   * @returns visible candidates.
   */
  async listCandidates(project: ProjectId, level: 'L1' | KnowledgeLevel, after = '', limit = 100): Promise<Array<OwnedMemory | SharedMemory>> {
    return this.providerFor(project).knowledge.listCandidates(project, level, after, limit)
  }

  /** Persist explicit consolidation and wake the background learner when enabled.
   * @param project - owner.
   * @param level - target level.
   * @param sources - exact previous-level versions.
   * @param config - resolved settings.
   * @returns durable operation identity without awaiting its model call.
   */
  async consolidate(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[], config: KnowledgeSpec): Promise<OperationId> {
    const operation = this.providerFor(project).knowledge.enqueue(project, level, sources, config)
    this.pipelineFor(project)?.wake(project)
    return operation
  }

  /** Read a consolidation task.
   * @param project - owner.
   * @param operation - identity.
   * @returns visible task or null.
   */
  async getKnowledgeTask(project: ProjectId, operation: OperationId) { return this.providerFor(project).knowledge.getTask(project, operation) }

  /** Page consolidation tasks.
   * @param project - owner.
   * @param after - cursor.
   * @param limit - page size.
   * @returns task page.
   */
  async listKnowledgeTasks(project: ProjectId, after = '', limit = 100) { return this.providerFor(project).knowledge.listTasks(project, after, limit) }

  /** Explicitly resume a failed consolidation.
   * @param project - owner.
   * @param operation - task identity.
   */
  async retryKnowledgeTask(project: ProjectId, operation: OperationId): Promise<void> {
    this.providerFor(project).knowledge.retry(project, operation)
    this.pipelineFor(project)?.wake(project)
  }

  /** Invalidate current owned knowledge and revoke its grant.
   * @param project - owner.
   * @param ref - expected version.
   * @param reason - audit reason.
   * @param operation - idempotent identity.
   */
  async invalidateMemory(project: ProjectId, ref: MemoryRef, reason: string, operation: OperationId): Promise<void> {
    this.providerFor(project).knowledge.invalidateMemory(project, ref, reason, operation)
  }

  /**
   * Inspect extraction state without dispatching a model request.
   * @param project - owning project.
   * @param operation - stable extraction identity.
   * @returns task or null when invisible.
   */
  async getTask(project: ProjectId, operation: OperationId): Promise<L1Task | null> {
    return this.providerFor(project).l1.getTask(project, operation)
  }

  /**
   * Page durable task states in stable identity order.
   * @param project - owning project.
   * @param after - exclusive previous operation id, or empty string for the first page.
   * @param limit - positive page size.
   * @returns at most limit tasks.
   */
  async listTasks(project: ProjectId, after: string, limit: number): Promise<L1Task[]> {
    return this.providerFor(project).l1.listTasks(project, after, limit)
  }

  /**
   * Queue an explicit retry or fresh version; does not bypass the request-logging requirement.
   * @param project - owning project.
   * @param operation - original task.
   * @param mode - retry preserves the candidate; reextract uses the configured model settings.
   * @returns durable operation id to inspect.
   */
  async rerunTask(project: ProjectId, operation: OperationId, mode: 'retry' | 'reextract'): Promise<OperationId> {
    if (this.l1 === undefined) throw new MemoryError('config', 'L1 configuration is required for explicit reruns')
    const next = this.providerFor(project).l1.rerun(project, operation, mode, this.l1)
    this.pipelineFor(project)?.wake(project)
    return next
  }
}

/**
 * Install capture and expose the service after recovering already-live Sessions.
 * @param ctx - context with Session storage.
 * @param config - loader configuration.
 * @returns completion after startup recovery; errors prevent memory service publication.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const spec = await resolveConfig(config)
  if (spec.panel && (!Object.hasOwn(ctx.fiber.inject, 'connection') || !Object.hasOwn(ctx.fiber.inject, 'webServer') || ctx.get('connection') === undefined)) {
    throw new MemoryError('config', 'panel requires connection and webServer in this plugin entry\'s inject list')
  }
  const llm = ctx.get('llm')
  if (spec.autoLearning && !Object.hasOwn(ctx.fiber.inject, 'llm')) throw new MemoryError('config', 'autoLearning requires llm in this plugin entry\'s inject list')
  if (spec.autoLearning && llm === undefined) throw new MemoryError('config', 'autoLearning requires the configured DSH LLM service')
  if (spec.textSearch?.expandQuery && (!Object.hasOwn(ctx.fiber.inject, 'llm') || llm === undefined)) throw new MemoryError('config', 'Query expansion requires llm in this plugin entry\'s inject list')
  if (spec.storageMode === 'workspace') {
    const { installWorkspaceMemory } = await import('./workspace-storage.ts')
    await installWorkspaceMemory(ctx, spec)
    return
  }
  const embedder = spec.embedding === undefined ? undefined : new HttpEmbedder(spec.embedding, process.env[spec.embedding.apiKeyEnv] ?? '')
  const provider = await SqliteMemory.open(spec)
  const report = (error: MemoryError) => ctx.logger.warn(`[memory/${error.code}] ${error.message}`)
  const retriever = spec.textSearch !== undefined ? new TextMemoryRetriever(provider, spec.textSearch,
    spec.textSearch.expandQuery ? queryExpander(provider, llm!, spec.l1!, spec.textSearch) : undefined)
    : spec.embedding === undefined || embedder === undefined ? undefined : new MemoryRetriever(provider, spec.embedding, embedder, report)
  const pipeline = spec.autoLearning && llm !== undefined ? new MemoryPipeline(provider, spec, llm, report, retriever) : undefined
  let panelDispose: (() => Promise<void>) | undefined
  let injectorDispose: (() => Promise<void>) | undefined
  let shuttingDown = false
  const enqueueKnowledge = () => {
    if (spec.knowledge === undefined) return
    try {
      for (const project of provider.listProjects()) {
        for (const level of ['L2', 'L3'] as const) enqueueCandidates(provider.knowledge, project, level, spec.knowledge, spec.pageSize)
      }
    } catch (error) {
      report(new MemoryError('storage', 'Knowledge task enqueue failed; pending source versions remain available for retry', error))
    }
  }
  const scan = (project: ProjectId) => {
    if (spec.l1 === undefined) return
    try { provider.scanTurns(project, spec.l1, spec.pageSize); if (!shuttingDown) pipeline?.wake(project) } catch (error) {
      report(new MemoryError('source', 'L1 scan failed; its last committed checkpoint is retained', error))
    }
  }
  const collector = new RawCollector(provider, ctx.sessionPersistence, spec, report, scan, async session => {
    const stored = provider.getSessionProject(session.id)
    if (stored !== undefined) return stored
    const registry = ctx.get('workspaceRegistry')
    const fallback = spec.projectByPath && session.header.cwd !== undefined
      ? `path:${createHash('sha256').update(resolve(session.header.cwd)).digest('hex')}` as ProjectId : spec.projectId
    if (registry === undefined || session.header.cwd === undefined) return fallback
    try {
      const workspace = await registry.resolveByPath(session.header.cwd)
      return workspace === undefined ? fallback : String(workspace.id) as ProjectId
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return fallback
      throw new MemoryError('source', `Session ${session.id}: Workspace lookup failed`, error)
    }
  })
  const listeners: Array<() => void> = []
  const dispose = async () => {
    shuttingDown = true
    for (const dispose of listeners) dispose()
    try {
      await injectorDispose?.()
      await panelDispose?.()
      await pipeline?.close()
      await retriever?.close()
      await collector.close()
    } finally {
      await provider.close()
    }
  }
  try {
    ctx.effect(() => dispose, 'memory.capture-and-database')
    listeners.push(ctx.on('session/created', session => collector.adopt(session)))
    listeners.push(ctx.on('session/event', (session, event) => collector.capture(session, event)))
    listeners.push(ctx.on('session/flush', session => collector.flush(session)))
    listeners.push(ctx.on('session/disposed', session => collector.retire(session)))
    if (spec.knowledge !== undefined) listeners.push(provider.onMemoryChange(enqueueKnowledge))
    const existing = ctx.sessions.list()
    for (const session of existing) collector.adopt(session)
    await Promise.all(existing.map(session => collector.flush(session)))
    if (spec.l1 !== undefined) for (const project of provider.listProjects()) scan(project)
    enqueueKnowledge()
    if (spec.l1 !== undefined && pipeline === undefined) report(new MemoryError('integration', 'L1 tasks are persisted; enable autoLearning with L1 and knowledge model configurations to dispatch recorded background requests'))
    const service = new MemoryService(ctx, provider, spec.l1, scan, spec.browser, retriever, pipeline)
    if (spec.injection && retriever !== undefined) injectorDispose = installMemoryInjector(ctx, retriever, async agent => {
      await collector.flush(agent.session)
      const project = provider.getSessionProject(agent.session.id)
      if (project === undefined) throw new MemoryError('source', 'Session has no captured memory project')
      return project
    }, report, service.browser)
    if (spec.panel) panelDispose = installPanelHost(ctx)
    installShareCommand(ctx, provider)
    retriever?.schedule()
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'memory startup and cleanup failed')
    }
    throw error
  }
}
