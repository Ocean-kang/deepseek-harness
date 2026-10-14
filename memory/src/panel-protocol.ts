/** Browser-safe JSON validation shared by the authenticated panel endpoint and its client. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryId, OperationId } from './l1-types.ts'

const id = z.string().min(1).transform(value => value as MemoryId)
const operationId = z.string().min(1).transform(value => value as OperationId)
const sessionId = z.string().min(1).transform(value => value as SessionId)
/** Exact-version selector validated at the wire. */
const panelRef = z.object({ id, revision: z.number().int().positive() }).strict()
/** Level filter; L0/L1 are read-only in the panel. */
const panelLevel = z.enum(['L0', 'L1', 'L2', 'L3'])
/** Composite paging position, interpreted only in the authenticated Session's project. */
const panelPosition = z.union([
  z.object({ level: z.literal('L0'), sessionId, seq: z.number().int().nonnegative() }).strict(),
  z.object({ level: z.enum(['L1', 'L2', 'L3']), id }).strict(),
])
/** One projected row; shared rows carry no private source references. */
const panelRow = z.object({
  level: panelLevel, title: z.string(), description: z.string().nullable().default(null), body: z.string(), projectId: z.string(), shared: z.boolean(),
  scenario: z.string().optional(), kind: z.enum(['knowledge', 'profile']).optional(), trace: z.string().optional(),
  ref: panelRef.nullable(), state: z.enum(['active', 'superseded', 'invalidated']), selectable: z.boolean(),
  sources: z.array(z.union([
    z.object({ kind: z.literal('memory'), ref: panelRef }).strict(),
    z.object({ kind: z.literal('event'), sessionId, seq: z.number().int().nonnegative() }).strict(),
  ])),
  sections: z.array(z.object({ label: z.enum(['conversation', 'execution', 'record', 'topic', 'actions', 'result', 'solution', 'experience', 'principle', 'extractionRequest', 'returned', 'cancelled', 'threw', 'recalled', 'problem', 'summary', 'conclusion', 'reason', 'whenToUse', 'recommendedAction', 'limitations']), text: z.string() }).strict()),
  outcome: z.enum(['success', 'failure', 'incomplete', 'unknown']).nullable(),
  sourceStatus: z.enum(['current', 'needs-review']),
  trust: z.object({ score: z.number().int(), scoreMin: z.number().int(), scoreMax: z.number().int(),
    evidence: z.enum(['supported', 'unverified', 'conflict']), evidenceStatus: z.enum(['claimed', 'model_supported', 'user_confirmed', 'execution_verified', 'externally_verified', 'conflicted', 'stale']).optional(), rationale: z.string(),
    category: z.enum(['temporary', 'local', 'method', 'constraint', 'decision']),
  }).strict().nullable(),
  generation: z.object({ provider: z.string(), model: z.string(), createdAt: z.number().int().nonnegative() }).strict().nullable(),
  raw: z.string().nullable(),
}).strict()
const traceCursor = z.object({ chunk: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict()
const importItem = z.object({ sessionId, createdAt: z.number().int().nonnegative(), eventCount: z.number().int().nonnegative().nullable(),
  status: z.enum(['available', 'imported', 'unsupported']), reason: z.string().optional() }).strict()
const importTask = z.object({ id: operationId, projectId: z.string(), status: z.enum(['pending', 'running', 'done', 'cancelled']), createdAt: z.number().int().nonnegative(),
  items: z.array(z.object({ sessionId, targetTo: z.number().int().nonnegative(), committedTo: z.number().int().nonnegative(),
    status: z.enum(['pending', 'running', 'done', 'failed']), failure: z.string().nullable() }).strict()) }).strict()
const cleanupPreview = z.object({ cutoff: z.number(), eligibleSessions: z.number().int().nonnegative(), protectedSessions: z.number().int().nonnegative(), eventCount: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), protectedEventCount: z.number().int().nonnegative(), protectedBytes: z.number().int().nonnegative() }).strict()
const cleanupTask = cleanupPreview.extend({ id: operationId, status: z.literal('done'), deletedSessions: z.number().int().nonnegative(), completedAt: z.number().int().nonnegative() }).strict()
/** Requests identify a Session, never a caller-chosen project. */
export const panelRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('trace'), sessionId, ref: panelRef, cursor: traceCursor.nullable() }).strict(),
  z.object({ action: z.literal('importPreview'), sessionId, fromCreatedAt: z.number().int().nonnegative().optional(), toCreatedAt: z.number().int().nonnegative().optional(), after: sessionId.nullable() }).strict(),
  z.object({ action: z.literal('importStart'), sessionId, sessionIds: z.array(sessionId).min(1).max(1000) }).strict(),
  z.object({ action: z.literal('importStatus'), sessionId, id: operationId.nullable() }).strict(),
  z.object({ action: z.literal('importCancel'), sessionId, id: operationId }).strict(),
  z.object({ action: z.literal('cleanupPreview'), sessionId, maxAgeDays: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('cleanup'), sessionId, maxAgeDays: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('cleanupStatus'), sessionId }).strict(),
  z.object({ action: z.literal('compact'), sessionId }).strict(),
  z.object({ action: z.literal('retryKnowledge'), sessionId, id: operationId }).strict(),

  z.object({ action: z.literal('browse'), sessionId, level: panelLevel, query: z.string(), after: panelPosition.nullable(), kind: z.enum(['knowledge', 'profile']).optional(), scenario: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal('detail'), sessionId, ref: panelRef }).strict(),
  z.object({ action: z.literal('history'), sessionId, id, before: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('state'), sessionId }).strict(),
  z.object({ action: z.literal('select'), sessionId, refs: z.array(panelRef), automatic: z.boolean() }).strict(),
  z.object({ action: z.literal('automatic'), sessionId, automatic: z.boolean() }).strict(),
])
/** All responses are decoded before entering the React panel. */
export const panelResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('trace'), found: z.boolean(), text: z.string(), nextCursor: traceCursor.nullable() }).strict(),
  z.object({ action: z.literal('importPreview'), items: z.array(importItem), nextCursor: sessionId.nullable(), autoLearning: z.boolean() }).strict(),
  z.object({ action: z.literal('importStart'), task: importTask }).strict(),
  z.object({ action: z.literal('importStatus'), task: importTask.nullable() }).strict(),
  z.object({ action: z.literal('importCancel'), task: importTask.nullable() }).strict(),
  z.object({ action: z.literal('cleanupPreview'), preview: cleanupPreview }).strict(),
  z.object({ action: z.literal('cleanup'), task: cleanupTask }).strict(),
  z.object({ action: z.literal('cleanupStatus'), task: cleanupTask.nullable() }).strict(),
  z.object({ action: z.literal('compact') }).strict(),
  z.object({ action: z.literal('retryKnowledge') }).strict(),

  z.object({ action: z.literal('browse'), rows: z.array(panelRow), next: panelPosition.nullable() }).strict(),
  z.object({ action: z.literal('detail'), row: panelRow.nullable() }).strict(),
  z.object({ action: z.literal('history'), refs: z.array(panelRef), next: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal('state'), projectId: z.string(), refs: z.array(panelRef), automatic: z.boolean(),
    injectionReady: z.boolean(), maintenanceReady: z.boolean().default(false), failedKnowledgeTasks: z.array(z.object({ id: operationId, level: z.enum(['L2', 'L3']), failure: z.string().nullable() }).strict()).default([]), valid: z.boolean(), bytes: z.number().int().nonnegative(), limit: z.number().int().positive(), maxBytes: z.number().int().positive(),
    used: z.array(z.object({ turn: z.number().int().nonnegative(), body: z.string(), refs: z.array(panelRef) }).strict()),
    pending: z.array(panelRow),
    revision: z.string(), refreshIntervalMs: z.number().int().positive(),
    recallMethod: z.enum(['disabled', 'vector', 'hybrid', 'unicode61', 'trigram']),
    learning: z.object({ enabled: z.boolean(), pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(), generated: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({ action: z.literal('select'), refs: z.array(panelRef), automatic: z.boolean() }).strict(),
  z.object({ action: z.literal('automatic'), refs: z.array(panelRef), automatic: z.boolean() }).strict(),
])
/** Validated panel request. */
export type PanelRequest = z.infer<typeof panelRequest>
/** Validated panel response. */
export type PanelResponse = z.infer<typeof panelResponse>
/** Renderable browser-safe record. */
export type PanelRow = z.infer<typeof panelRow>
