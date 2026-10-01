/** Versioned project knowledge and durable consolidation inputs. */
import type { L1Config, L1Memory, L1Spec, MemoryRef, OperationId } from './l1-types.ts'
import type { ProjectId } from './types.ts'

/** Project knowledge levels; L3 remains private until an exact-version approval. */
export type KnowledgeLevel = 'L2' | 'L3'
/** Importance never establishes factual support. */
export type Evidence = 'supported' | 'unverified' | 'conflict'
/** Immutable parent version, resolved only inside its owning project. */
export interface MemorySource { readonly kind: 'memory'; readonly ref: MemoryRef }
/** Model-owned content; identities and revisions are assigned by the store. */
export interface Knowledge {
  readonly title: string
  readonly body: string
  readonly category: 'temporary' | 'local' | 'method' | 'constraint' | 'decision'
  readonly score: number
  readonly rationale: string
  readonly evidence: Evidence
  readonly sources: readonly MemorySource[]
}
/** Optional consolidation deployment settings. */
export interface KnowledgeConfig extends L1Config { scoreMin?: number; scoreMax?: number; l2Threshold?: number; l3Threshold?: number }
/** Complete, persisted model and scoring settings. */
export interface KnowledgeSpec extends Omit<L1Spec, 'promptVersion'> {
  readonly promptVersion: 'knowledge-v1' | 'knowledge-v2'
  readonly scoreMin: number
  readonly scoreMax: number
  readonly l2Threshold: number
  readonly l3Threshold: number
}
/** Immutable content version; state follows subsequent replacement or invalidation. */
export interface KnowledgeMemory extends MemoryRef {
  readonly projectId: ProjectId
  readonly operationId: OperationId
  readonly level: KnowledgeLevel
  readonly knowledge: Knowledge
  readonly config: KnowledgeSpec
  readonly createdAt: number
  readonly state: 'active' | 'superseded' | 'invalidated'
}
/** Same-project source or historical knowledge record. */
export type OwnedMemory = L1Memory | KnowledgeMemory
/** Cross-project projection deliberately excludes private sources and model metadata. */
export interface SharedMemory extends MemoryRef {
  readonly projectId: ProjectId
  readonly level: 'L3'
  readonly shared: true
  readonly title: string
  readonly body: string
}
/** A model may reference only an existing input target, never assign a revision. */
export interface KnowledgeCandidate { readonly knowledge: Knowledge; readonly target: MemoryRef | null }
/** Frozen input versions used for validation and optimistic concurrency. */
export interface KnowledgeInput {
  readonly projectId: ProjectId
  readonly level: KnowledgeLevel
  readonly sources: readonly OwnedMemory[]
  readonly existing: readonly KnowledgeMemory[]
  readonly lineage: readonly OwnedMemory[]
}
/** Durable task, including prepared results and exhausted budgets. */
export interface KnowledgeTask {
  readonly operationId: OperationId
  readonly input: KnowledgeInput
  readonly config: KnowledgeSpec
  readonly status: 'pending' | 'running' | 'prepared' | 'retry' | 'failed' | 'done'
  readonly attempts: number
  readonly calls: number
  readonly nextRetryAt: number
  readonly failure: string | null
  readonly candidates: readonly KnowledgeCandidate[] | null
  readonly result: readonly MemoryRef[] | null
  readonly owner: string | null
  readonly leaseUntil: number
}
/** Receipt supplied by a future trusted user adapter, never by a model tool. */
export interface ShareAction {
  readonly operationId: OperationId
  readonly projectId: ProjectId
  readonly ref: MemoryRef
  readonly action: 'approve' | 'revoke'
  readonly userId: string
  readonly receiptId: string
  readonly occurredAt: number
  readonly expiresAt: number
}
