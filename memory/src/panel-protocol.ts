/** Browser-safe JSON validation shared by the authenticated panel endpoint and its client. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryId } from './l1-types.ts'

const id = z.string().min(1).transform(value => value as MemoryId)
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
  level: panelLevel, title: z.string(), body: z.string(), projectId: z.string(), shared: z.boolean(),
  ref: panelRef.nullable(), state: z.enum(['active', 'superseded', 'invalidated']), selectable: z.boolean(),
  sources: z.array(z.union([
    z.object({ kind: z.literal('memory'), ref: panelRef }).strict(),
    z.object({ kind: z.literal('event'), sessionId, seq: z.number().int().nonnegative() }).strict(),
  ])),
}).strict()
/** Requests identify a Session, never a caller-chosen project. */
export const panelRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browse'), sessionId, level: panelLevel, query: z.string(), after: panelPosition.nullable() }).strict(),
  z.object({ action: z.literal('detail'), sessionId, ref: panelRef }).strict(),
  z.object({ action: z.literal('history'), sessionId, id, before: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('state'), sessionId }).strict(),
  z.object({ action: z.literal('select'), sessionId, refs: z.array(panelRef), automatic: z.boolean() }).strict(),
])
/** All responses are decoded before entering the React panel. */
export const panelResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browse'), rows: z.array(panelRow), next: panelPosition.nullable() }).strict(),
  z.object({ action: z.literal('detail'), row: panelRow.nullable() }).strict(),
  z.object({ action: z.literal('history'), refs: z.array(panelRef), next: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal('state'), projectId: z.string(), refs: z.array(panelRef), automatic: z.boolean(),
    injectionReady: z.boolean(), valid: z.boolean(), bytes: z.number().int().nonnegative(), limit: z.number().int().positive(), maxBytes: z.number().int().positive(),
    used: z.array(z.object({ turn: z.number().int().nonnegative(), body: z.string(), refs: z.array(panelRef) }).strict()),
  }).strict(),
  z.object({ action: z.literal('select'), refs: z.array(panelRef), automatic: z.boolean() }).strict(),
])
/** Validated panel request. */
export type PanelRequest = z.infer<typeof panelRequest>
/** Validated panel response. */
export type PanelResponse = z.infer<typeof panelResponse>
/** Renderable browser-safe record. */
export type PanelRow = z.infer<typeof panelRow>
