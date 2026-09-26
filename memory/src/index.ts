/** Cordis L0 plugin: publishes readiness only after database and capture initialization. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveConfig } from './config.ts'
import type { Config as ConfigInput } from './config.ts'
import { SqliteMemory } from './sqlite.ts'
import { RawCollector } from './collector.ts'
import { MemoryError } from './types.ts'
import type { AppendRawRequest, AppendRawResult, RawMemory, ReadRawRequest, ReadRawResult } from './types.ts'
import type { ProjectId } from './types.ts'
import type { L1Memory, L1Spec, L1Task, MemoryRef, OperationId } from './l1-types.ts'

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
   * @param scan - nonthrowing notification after L0 commits.
   */
  constructor(ctx: Context, private readonly provider: SqliteMemory, private readonly l1: L1Spec | undefined, private readonly scan: (project: ProjectId) => void) {
    super(ctx, 'memory')
  }

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
   * Read one exact project-owned L1 version.
   * @param project - owning project.
   * @param ref - immutable version reference.
   * @returns memory or null; other projects remain invisible.
   */
  async getMemory(project: ProjectId, ref: MemoryRef): Promise<L1Memory | null> {
    return this.provider.l1.getMemory(project, ref)
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
  const provider = await SqliteMemory.open(spec)
  const report = (error: MemoryError) => ctx.logger.warn(`[memory/${error.code}] ${error.message}`)
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
    new MemoryService(ctx, provider, spec.l1, scan)
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'memory startup and cleanup failed')
    }
    throw error
  }
}
