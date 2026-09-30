/** Resolve deployment choices before any database, profile, or test writes. */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { resolveEmbeddingConfig } from './embedding.ts'
import type { EmbeddingConfig, EmbeddingSpec } from './embedding.ts'
import { resolveL1Config } from './l1-config.ts'
import type { L1Config, L1Spec } from './l1-types.ts'
import { resolveKnowledgeConfig } from './knowledge-config.ts'
import type { KnowledgeConfig, KnowledgeSpec } from './knowledge-types.ts'

/** This plugin's permitted write root, preserved in both src/ and lib/. */
export const MEMORY_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** User configuration; defaults are applied only by resolveConfig. */
export interface Config {
  embedding?: EmbeddingConfig | undefined
  l1?: L1Config | undefined
  knowledge?: KnowledgeConfig | undefined
  /** Required fallback for Sessions without a matching Workspace. */
  projectId: string
  databasePath: string
  queueCapacity?: number
  learningConcurrency?: number
  learningQueueCapacity?: number
  batchSize?: number
  pageSize?: number
  busyTimeoutMs?: number
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
}

/** Validated absolute paths and all deployment values. */
export interface Spec {
  readonly embedding?: EmbeddingSpec
  readonly l1?: L1Spec
  readonly knowledge?: KnowledgeSpec
  readonly projectId: ProjectId
  readonly databasePath: string
  readonly queueCapacity: number
  readonly learningConcurrency: number
  readonly learningQueueCapacity: number
  readonly batchSize: number
  readonly pageSize: number
  readonly busyTimeoutMs: number
  readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
}

/**
 * Reject out-of-root targets and link-shaped ancestors before a write.
 * @param path - absolute or memory-root-relative target.
 * @returns absolute target with existing ancestors verified.
 */
export async function memoryPath(path: string): Promise<string> {
  const root = resolve(MEMORY_ROOT)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MemoryError('config', 'write target must be inside memory/')
  }
  // The repository and its parents may themselves be mounted through aliases.
  // Requiring the root's real location prevents a junction from redirecting all writes.
  if (resolve(await realpath(root)) !== root) throw new MemoryError('config', 'memory/ must not be redirected')
  let candidate = target
  while (candidate !== root) {
    try {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink()) throw new MemoryError('config', 'memory write path contains a link')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    candidate = dirname(candidate)
  }
  return target
}

/**
 * Resolve and validate every tunable before execution.
 * @param input - plugin configuration from the loader.
 * @returns complete immutable deployment specification.
 */
export async function resolveConfig(input: Config): Promise<Spec> {
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '' || input.projectId !== input.projectId.trim()) {
    throw new MemoryError('config', 'projectId must be an explicit nonempty identifier without surrounding whitespace')
  }
  if (typeof input.databasePath !== 'string' || input.databasePath.trim() === '') {
    throw new MemoryError('config', 'databasePath is required')
  }
  const numbers = {
    queueCapacity: input.queueCapacity ?? 1024,
    learningConcurrency: input.learningConcurrency ?? 2,
    learningQueueCapacity: input.learningQueueCapacity ?? 128,
    batchSize: input.batchSize ?? 128,
    pageSize: input.pageSize ?? 128,
    busyTimeoutMs: input.busyTimeoutMs ?? 5000,
  }
  for (const [key, value] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(value) || value < (key === 'busyTimeoutMs' ? 0 : 1) || value > 2147483647) {
      throw new MemoryError('config', `${key} must be a bounded integer`)
    }
  }
  const journalMode = input.journalMode ?? 'wal'
  if (!['wal', 'delete', 'truncate', 'persist'].includes(journalMode)) throw new MemoryError('config', 'invalid journalMode')
  return Object.freeze({
    ...(input.embedding === undefined ? {} : { embedding: resolveEmbeddingConfig(input.embedding) }),
    ...(input.l1 === undefined ? {} : { l1: resolveL1Config(input.l1) }),
    ...(input.knowledge === undefined ? {} : { knowledge: resolveKnowledgeConfig(input.knowledge) }),
    projectId: input.projectId as ProjectId,
    databasePath: await memoryPath(input.databasePath),
    ...numbers,
    journalMode,
  })
}
