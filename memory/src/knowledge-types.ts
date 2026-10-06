/** Versioned project knowledge and durable consolidation inputs. */
import type { EventRef, L1Config, L1Memory, L1Spec, MemoryRef, OperationId } from './l1-types.ts'
import type { ProjectId } from './types.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Project knowledge levels; L3 remains private until an exact-version approval. */
export type KnowledgeLevel = 'L2' | 'L3'
/** Importance never establishes factual support. */
export type Evidence = 'supported' | 'unverified' | 'conflict'
/** Confidence origin is independent of importance and source freshness. */
export type EvidenceStatus = 'claimed' | 'model_supported' | 'user_confirmed' | 'execution_verified' | 'externally_verified' | 'conflicted' | 'stale'
/** An unresolved alternative retains the exact previous version and the reason for disagreement. */
export interface KnowledgeConflict { readonly ref: MemoryRef; readonly reason: string }
/** Immutable parent version, resolved only inside its owning project. */
export interface MemorySource { readonly kind: 'memory'; readonly ref: MemoryRef }
/** Knowledge content and program-owned inspection metadata; the store assigns identities and revisions. */
export interface Knowledge {
  readonly title: string
  readonly body: string
  /** Scenario groups project knowledge by module, problem or working context. */
  readonly scenario?: string
  readonly conclusion?: string
  readonly reason?: string
  readonly whenToUse?: readonly string[]
  readonly recommendedAction?: string
  readonly limitations?: readonly string[]
  /** Stable engineering knowledge and interaction preferences are separately searchable. */
  readonly kind?: 'knowledge' | 'profile'
  /** Assigned by the verifier; historical supported records imply model_supported only. */
  readonly evidenceStatus?: EvidenceStatus
  readonly conflicts?: readonly KnowledgeConflict[]
  /** Trusted confirmation receipt, unavailable to extraction models. */
  readonly confirmation?: EvidenceConfirmation
  /** Single-sentence display text generated with the knowledge card; historical versions may omit it. */
  readonly description?: string
  /** L0 events supplied to the contributing verification steps; this records inspection, not independent factual proof. */
  readonly examinedEvents?: readonly EventRef[]
  readonly category: 'temporary' | 'local' | 'method' | 'constraint' | 'decision'
  readonly score: number
  readonly rationale: string
  readonly evidence: Evidence
  readonly sources: readonly MemorySource[]
}
/** Trusted user or external verifier confirms one exact immutable conclusion. */
export interface EvidenceConfirmation {
  readonly status: 'user_confirmed' | 'externally_verified'
  readonly actor: string
  readonly receiptId: EvidenceReceiptId
  readonly reference: string
  readonly occurredAt: number
}
/** Opaque identity of a trusted confirmation receipt. */
export type EvidenceReceiptId = Branded<'MemoryEvidenceReceiptId'>
/** Optional consolidation deployment settings. */
export interface KnowledgeConfig extends L1Config { scoreMin?: number; scoreMax?: number; l2Threshold?: number; l3Threshold?: number }
/** Complete, persisted model and scoring settings. */
export interface KnowledgeSpec extends Omit<L1Spec, 'promptVersion'> {
  readonly promptVersion: 'knowledge-v1' | 'knowledge-v2' | 'knowledge-v3' | 'knowledge-v4'
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
  readonly scenario?: string
  readonly kind?: 'knowledge' | 'profile'
}
/** Browsing selectors use public card organization fields. */
export interface KnowledgeFilter { readonly kind?: 'knowledge' | 'profile'; readonly scenario?: string }
/** A model may reference only an existing input target, never assign a revision. */
export interface KnowledgeCandidate {
  readonly knowledge: Knowledge
  readonly target: MemoryRef | null
  /** Legacy candidates infer store/merge; new tasks make the comparison decision explicit. */
  readonly action?: 'store' | 'update' | 'merge' | 'skip' | 'conflict'
}
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
  /** Exact affected version for a recheck; ordinary and legacy tasks omit it. */
  readonly recheck?: MemoryRef
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
