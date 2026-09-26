/** Cordis L0 plugin: publishes readiness only after database and capture initialization. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { resolveConfig } from './config.ts'
import type { Config as ConfigInput } from './config.ts'
import { SqliteMemory } from './sqlite.ts'
import { RawCollector } from './collector.ts'
import { MemoryError } from './types.ts'
import type { AppendRawRequest, AppendRawResult, RawMemory, ReadRawRequest, ReadRawResult } from './types.ts'

export type * from './types.ts'
/** Loader configuration request. */
export type Config = ConfigInput
/** Loader-visible validation; cross-field and filesystem checks live in resolveConfig. */
export const Config: z<Config> = z.object({
  projectId: z.string().required(), databasePath: z.string().required(),
  queueCapacity: z.number(), batchSize: z.number(), pageSize: z.number(), busyTimeoutMs: z.number(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const),
})
/** Plugin identity. */
export const name = 'memory-l0'
/** Canonical storage is required for overflow and restart recovery. */
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
   */
  constructor(ctx: Context, private readonly provider: RawMemory) {
    super(ctx, 'memory')
  }

  /**
   * Commit an ordered source batch.
   * @param request - complete ordered source batch.
   * @returns durable transaction result.
   */
  appendRaw(request: AppendRawRequest): Promise<AppendRawResult> {
    return this.provider.appendRaw(request)
  }

  /**
   * Read a project-owned interval without hiding missing events.
   * @param request - project-owned interval and page.
   * @returns ordered events and missing ranges.
   */
  readRaw(request: ReadRawRequest): Promise<ReadRawResult> {
    return this.provider.readRaw(request)
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
  const collector = new RawCollector(provider, ctx.sessionPersistence, spec, report)
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
    new MemoryService(ctx, provider)
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'memory startup and cleanup failed')
    }
    throw error
  }
}
