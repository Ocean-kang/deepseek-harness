/** Cordis L0 plugin: publishes readiness only after database and capture initialization. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveConfig } from './config.ts'
import type { Config as ConfigInput } from './config.ts'
import { SqliteMemory } from './sqlite.ts'
import { HttpEmbedder } from './embedding.ts'
import { MemoryRetriever } from './retrieval.ts'
import type { RetrievalRequest } from './retrieval.ts'
import { RawCollector } from './collector.ts'
import { MemoryError } from './types.ts'
import type { AppendRawRequest, AppendRawResult, RawMemory, ReadRawRequest, ReadRawResult } from './types.ts'
import type { ProjectId } from './types.ts'
import type { L1Spec, L1Task, MemoryRef, OperationId } from './l1-types.ts'

import type { KnowledgeLevel, KnowledgeSpec, OwnedMemory, SharedMemory } from './knowledge-types.ts'

export type * from './embedding.ts'
export type * from './retrieval.ts'
export { resolveEmbeddingConfig, HttpEmbedder } from './embedding.ts'
export { MemoryRetriever } from './retrieval.ts'
export { installMemoryInjector } from './injector.ts'
export type * from './knowledge-types.ts'
export { resolveKnowledgeConfig } from './knowledge-validation.ts'
export { KnowledgeExtractor } from './knowledge-extractor.ts'
export type { KnowledgeRecorder } from './knowledge-extractor.ts'
export { KnowledgeWorker } from './knowledge-worker.ts'
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
  projectId: z.string().required(), databasePath: z.string().required(),
  queueCapacity: z.number(), batchSize: z.number(), pageSize: z.number(), busyTimeoutMs: z.number(),
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

/** Context-facing minimal persistence API, available after collector initialization. */
export class MemoryService extends Service implements RawMemory {
  /**
   * Publish the ready provider through Cordis.
   * @param ctx - owning plugin context.
   * @param provider - ready SQLite provider.
   * @param l1 - resolved extraction configuration, if task scanning is enabled.
   * @param retriever - optional explicitly configured semantic search.
   * @param scan - nonthrowing notification after L0 commits.
   */
  constructor(ctx: Context, private readonly provider: SqliteMemory, private readonly l1: L1Spec | undefined, private readonly scan: (project: ProjectId) => void, private readonly retriever?: MemoryRetriever) {
    super(ctx, 'memory')
  }

  private search(): MemoryRetriever {
    if (this.retriever === undefined) throw new MemoryError('config', 'embedding configuration is required')
    return this.retriever
  }

  /** Retrieve authorized version-bound references.
   * @param request - accepted user query and project.
   * @returns budgeted references; rejects on unavailable or incomplete index.
   */
  async retrieve(request: RetrievalRequest) { return this.search().retrieve(request) }

  /** Inspect completeness for the requesting project.
   * @param project - requester.
   * @returns candidate counts and worker state.
   */
  async getIndexStatus(project: ProjectId) { return this.search().getIndexStatus(project) }

  /** Rebuild only the configured vector space; inspect getIndexStatus for failures. */
  async rebuildIndex(): Promise<void> { return this.search().rebuildIndex() }

  /**
   * Commit an ordered source batch.
   * @param request - complete ordered source batch.
   * @returns durable transaction result.
   */
  async appendRaw(request: AppendRawRequest): Promise<AppendRawResult> {
    const result = await this.provider.appendRaw(request)
    this.scan(request.projectId)
    return result
  }

  /**
   * Read a project-owned interval without hiding missing events.
   * @param request - project-owned interval and page.
   * @returns ordered events and missing ranges.
   */
  readRaw(request: ReadRawRequest): Promise<ReadRawResult> {
    return this.provider.readRaw(request)
  }

  /**
   * Read owned history or an approved current L3 projection.
   * @param project - owning project.
   * @param ref - immutable version reference.
   * @returns visible memory or null; shared records exclude private sources.
   */
  async getMemory(project: ProjectId, ref: MemoryRef): Promise<OwnedMemory | SharedMemory | null> {
    return this.provider.knowledge.getMemory(project, ref)
  }

  /** Page active usable memory versions.
   * @param project - requesting project.
   * @param level - requested level.
   * @param after - exclusive identity cursor.
   * @param limit - positive page size.
   * @returns visible candidates.
   */
  async listCandidates(project: ProjectId, level: 'L1' | KnowledgeLevel, after = '', limit = 100): Promise<Array<OwnedMemory | SharedMemory>> {
    return this.provider.knowledge.listCandidates(project, level, after, limit)
  }

  /** Queue an explicit consolidation; automatic model dispatch remains unavailable.
   * @param project - owner.
   * @param level - target level.
   * @param sources - exact previous-level versions.
   * @param config - resolved settings.
   * @returns durable operation identity.
   */
  async consolidate(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[], config: KnowledgeSpec): Promise<OperationId> {
    return this.provider.knowledge.enqueue(project, level, sources, config)
  }

  /** Read a consolidation task.
   * @param project - owner.
   * @param operation - identity.
   * @returns visible task or null.
   */
  async getKnowledgeTask(project: ProjectId, operation: OperationId) { return this.provider.knowledge.getTask(project, operation) }

  /** Page consolidation tasks.
   * @param project - owner.
   * @param after - cursor.
   * @param limit - page size.
   * @returns task page.
   */
  async listKnowledgeTasks(project: ProjectId, after = '', limit = 100) { return this.provider.knowledge.listTasks(project, after, limit) }

  /** Explicitly resume a failed consolidation.
   * @param project - owner.
   * @param operation - task identity.
   */
  async retryKnowledgeTask(project: ProjectId, operation: OperationId): Promise<void> { this.provider.knowledge.retry(project, operation) }

  /** Invalidate current owned knowledge and revoke its grant.
   * @param project - owner.
   * @param ref - expected version.
   * @param reason - audit reason.
   * @param operation - idempotent identity.
   */
  async invalidateMemory(project: ProjectId, ref: MemoryRef, reason: string, operation: OperationId): Promise<void> {
    this.provider.knowledge.invalidateMemory(project, ref, reason, operation)
  }

  /**
   * Inspect extraction state without dispatching a model request.
   * @param project - owning project.
   * @param operation - stable extraction identity.
   * @returns task or null when invisible.
   */
  async getTask(project: ProjectId, operation: OperationId): Promise<L1Task | null> {
    return this.provider.l1.getTask(project, operation)
  }

  /**
   * Page durable task states in stable identity order.
   * @param project - owning project.
   * @param after - exclusive previous operation id, or empty string for the first page.
   * @param limit - positive page size.
   * @returns at most limit tasks.
   */
  async listTasks(project: ProjectId, after: string, limit: number): Promise<L1Task[]> {
    return this.provider.l1.listTasks(project, after, limit)
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
    return this.provider.l1.rerun(project, operation, mode, this.l1)
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
  const embedder = spec.embedding === undefined ? undefined : new HttpEmbedder(spec.embedding, process.env[spec.embedding.apiKeyEnv] ?? '')
  const provider = await SqliteMemory.open(spec)
  const report = (error: MemoryError) => ctx.logger.warn(`[memory/${error.code}] ${error.message}`)
  const retriever = spec.embedding === undefined || embedder === undefined ? undefined : new MemoryRetriever(provider, spec.embedding, embedder, report)
  const scan = (project: ProjectId) => {
    if (spec.l1 === undefined) return
    try { provider.scanTurns(project, spec.l1, spec.pageSize) } catch (error) {
      report(new MemoryError('source', 'L1 scan failed; its last committed checkpoint is retained', error))
    }
  }
  const collector = new RawCollector(provider, ctx.sessionPersistence, spec, report, scan, async session => {
    const stored = provider.getSessionProject(session.id)
    if (stored !== undefined) return stored
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || session.header.cwd === undefined) return spec.projectId
    try {
      const workspace = await registry.resolveByPath(session.header.cwd)
      return workspace === undefined ? spec.projectId : String(workspace.id) as ProjectId
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return spec.projectId
      throw new MemoryError('source', `Session ${session.id}: Workspace lookup failed`, error)
    }
  })
  const listeners: Array<() => void> = []
  const dispose = async () => {
    for (const dispose of listeners) dispose()
    try {
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
    const existing = ctx.sessions.list()
    for (const session of existing) collector.adopt(session)
    await Promise.all(existing.map(session => collector.flush(session)))
    if (spec.l1 !== undefined) for (const project of provider.listProjects()) scan(project)
    if (spec.l1 !== undefined) report(new MemoryError('integration', 'L1 tasks are persisted, but automatic extraction is unavailable until its Session request event is registered; no model requests will be dispatched'))
    new MemoryService(ctx, provider, spec.l1, scan, retriever)
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
