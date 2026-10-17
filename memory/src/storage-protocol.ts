/** Structured-clone RPC for the plugin-owned storage worker. */
import { z } from 'zod'
import type { MemoryErrorCode } from './types.ts'

/** Only public storage operations may cross the worker channel. */
export const storageMethods = {
  database: ['getSessionProject', 'listProjects', 'learningStatus', 'listSessions', 'browseRaw', 'appendRaw', 'readRaw', 'scanTurnsPage', 'close', 'textQuery', 'textStatus', 'textSnapshot', 'rebuildTextIndex'],
  l1: ['cursor', 'scanPage', 'getTask', 'listTasks', 'nextDue', 'claim', 'reserveCall', 'prepare', 'commitMemory', 'fail', 'rerun', 'byOperation', 'getMemory', 'readTrace', 'successfulRefs', 'executionAudit', 'evidenceUsable', 'auditEvidencePage'],
  knowledge: ['getMemory', 'sourcesCurrent', 'browse', 'revisions', 'listCandidates', 'enqueue', 'enqueueCandidates', 'enqueueRechecks', 'getTask', 'listTasks', 'getFailedTasks', 'nextDue', 'claim', 'reserveCall', 'prepare', 'commit', 'confirmEvidence', 'fail', 'retry', 'invalidateMemory', 'approveShare', 'revokeShare'],
  vectors: ['generation', 'projects', 'documentPage', 'current', 'read', 'put', 'state', 'status', 'clear'],
  selections: ['get', 'setAutomatic', 'replace', 'consume'],
  maintenance: ['startImport', 'getImport', 'latestImport', 'listImports', 'cancelImport', 'checkpointImport', 'admitted', 'tombstoned', 'copiedPrefix', 'listAdmissions', 'setActive', 'cleanupPreview', 'cleanup', 'cleanupStatus', 'compact'],
} as const
/** Validated message envelope; owning stores validate persisted and model-owned values. */
export const storageRequest = z.object({ id: z.number().int().positive(), database: z.number().int().nonnegative(),
  scope: z.enum(['open', 'database', 'l1', 'knowledge', 'vectors', 'selections', 'maintenance']), method: z.string(), args: z.array(z.unknown()),
  signalArgs: z.array(z.number().int().nonnegative()).optional() }).strict()
/** Cancellation is control traffic and does not wait behind the operation it interrupts. */
export const storageCancel = z.object({ kind: z.literal('cancel'), id: z.number().int().positive() }).strict()
/** Body-free worker failures retain stable categories and SQLite contention codes. */
export interface StorageFailure { readonly code: MemoryErrorCode; readonly message: string; readonly errcode?: number }
/** Results are delivered only after the storage operation settles. */
export const storageResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('change'), database: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('result'), id: z.number().int().positive(), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('error'), id: z.number().int().positive(), failure: z.object({
    code: z.enum(['excluded', 'config', 'closed', 'conflict', 'gap', 'schema', 'corrupt', 'storage', 'source', 'backpressure', 'model', 'output', 'budget', 'integration', 'index-not-ready', 'timeout', 'unknown-outcome']),
    message: z.string(), errcode: z.number().int().optional(),
  }).strict() }).strict(),
])
