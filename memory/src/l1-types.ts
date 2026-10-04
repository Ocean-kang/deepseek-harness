/** Project-owned turn summaries and durable extraction jobs. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { ProjectId, RawRange } from './types.ts'

/** Stable identity of one turn's logical memory. */
export type MemoryId = Branded<'MemoryId'>
/** Stable identity of one extraction and its eventual commit. */
export type OperationId = Branded<'MemoryOperationId'>
/** Exact immutable version; never follows the current version implicitly. */
export interface MemoryRef { readonly id: MemoryId; readonly revision: number }
/** Event identity within the source project's Session. */
export interface EventRef { readonly sessionId: SessionId; readonly seq: SessionSeq }

/** Optional L1 deployment choices; an absent configuration leaves L0 alone. */
export interface L1Config {
  provider: string
  model: string
  maxInputBytes?: number
  maxOutputTokens?: number
  timeoutMs?: number
  maxCalls?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

/** Resolved configuration stored with every task, including its prompt version. */
export interface L1Spec {
  readonly provider: string
  readonly model: string
  readonly promptVersion: 'l1-v1' | 'l1-v2'
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly maxCalls: number
  readonly maxAttempts: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
}

/** Model content only; task identity and end reason are supplied by the manager. */
export interface L1Summary {
  /** Separately generated display sentence; absent from historical summaries. */
  readonly description?: string
  readonly goal: string
  readonly actions: readonly string[]
  readonly outcome: 'success' | 'failure' | 'incomplete' | 'unknown'
  readonly result: string
  readonly solution: string | null
  readonly sources: readonly EventRef[]
}

/** A validated summary or an explicit absence of extractable content. */
export type L1Candidate = { readonly kind: 'memory'; readonly summary: L1Summary } | { readonly kind: 'empty' }

/** Persisted scheduling state; prepared candidates survive model-independent retries. */
export type L1TaskStatus = 'pending' | 'running' | 'prepared' | 'retry' | 'failed' | 'done' | 'empty'

/** A diagnostic intentionally excludes provider messages and source bodies. */
export interface L1Failure { readonly code: string; readonly retryable: boolean }

/** Persisted source interval and immutable extraction configuration. */
export interface L1Task extends RawRange {
  readonly operationId: OperationId
  readonly memoryId: MemoryId
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly turn: number
  readonly reason: TurnEndReason
  readonly config: L1Spec
  readonly expectedRevision: number | null
  readonly status: L1TaskStatus
  readonly attempts: number
  readonly calls: number
  readonly nextRetryAt: number
  readonly failure: L1Failure | null
  readonly candidate: L1Candidate | null
  readonly leaseUntil: number
}

/** Immutable L1 version with program-owned source and completion metadata. */
export interface L1Memory extends MemoryRef {
  readonly projectId: ProjectId
  readonly operationId: OperationId
  readonly level: 'L1'
  readonly sessionId: SessionId
  readonly turn: number
  readonly reason: TurnEndReason
  readonly range: RawRange
  readonly config: L1Spec
  readonly summary: L1Summary
  readonly createdAt: number
  readonly state: 'active' | 'superseded'
}
