/** Validate model output and memory-owned JSON at external and durable reads. */
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { MemoryError } from './types.ts'
import { resolveL1Config } from './l1-config.ts'
import type { EventRef, L1Candidate, L1Spec } from './l1-types.ts'

/**
 * Read a JSON object without trusting its prototype or fields.
 * @param value - untrusted JSON value.
 * @returns a record suitable for field validation.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('output', 'L1 expected an object')
  return value as Record<string, unknown>
}

/**
 * Read a nonempty string without including its content in diagnostics.
 * @param value - untrusted scalar.
 * @returns validated text.
 */
export function textValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new MemoryError('output', 'L1 expected nonempty text')
  return value
}

/**
 * Read a safe nonnegative integer.
 * @param value - untrusted scalar.
 * @returns validated integer.
 */
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MemoryError('corrupt', 'L1 expected a nonnegative integer')
  return value
}

/**
 * Decode JSON without placing sensitive input in the exception chain.
 * @param value - serialized JSON.
 * @returns unknown JSON requiring validation.
 */
export function json(value: unknown): unknown {
  if (typeof value !== 'string') throw new MemoryError('corrupt', 'L1 expected stored JSON text')
  try { return JSON.parse(value) } catch (error) {
    // JSON parser messages can contain source text; do not retain that error.
    throw new MemoryError('output', error instanceof SyntaxError ? 'L1 invalid JSON' : 'L1 JSON decoding failed')
  }
}

/**
 * Recover immutable extraction settings without applying defaults to missing fields.
 * @param value - stored configuration object.
 * @returns validated supported settings.
 */
export function storedSpec(value: unknown): L1Spec {
  const row = object(value)
  if (row.promptVersion !== 'l1-v1') throw new MemoryError('schema', 'unsupported L1 prompt version')
  return resolveL1Config({
    provider: textValue(row.provider), model: textValue(row.model),
    maxInputBytes: integer(row.maxInputBytes), maxOutputTokens: integer(row.maxOutputTokens),
    timeoutMs: integer(row.timeoutMs), maxCalls: integer(row.maxCalls), maxAttempts: integer(row.maxAttempts),
    retryBaseMs: integer(row.retryBaseMs), retryMaxMs: integer(row.retryMaxMs),
  })
}

/**
 * Preserve merge-extensible turn end reasons after validating the discriminant.
 * @param value - JSON from a complete source event or memory row.
 * @returns reason including plugin-specific fields.
 */
export function storedReason(value: unknown): TurnEndReason {
  const row = object(value)
  textValue(row.kind)
  return row as TurnEndReason
}

function exact(row: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) throw new MemoryError('output', 'L1 unexpected or missing output fields')
}

/**
 * Validate a candidate and its references against exactly the supplied input.
 * @param value - parsed model output or persisted candidate.
 * @param allowed - supplied event identities, or a persisted task's source-membership check.
 * @param reason - program-owned end reason; non-completed turns cannot be successes.
 * @returns detached candidate with validated sources.
 */
export function parseCandidate(value: unknown, allowed: readonly EventRef[] | ((ref: EventRef) => boolean), reason: TurnEndReason): L1Candidate {
  const row = object(value)
  if (row.kind === 'empty') { exact(row, ['kind']); return { kind: 'empty' } }
  if (row.kind !== 'memory') throw new MemoryError('output', 'L1 invalid result kind')
  exact(row, ['kind', 'summary'])
  const summary = object(row.summary)
  exact(summary, ['goal', 'actions', 'outcome', 'result', 'solution', 'sources'])
  if (!Array.isArray(summary.actions) || !Array.isArray(summary.sources) || summary.sources.length === 0) throw new MemoryError('output', 'L1 requires actions and nonempty sources')
  const outcome = summary.outcome
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'incomplete' && outcome !== 'unknown') throw new MemoryError('output', 'L1 invalid outcome')
  const solution = summary.solution === null ? null : textValue(summary.solution)
  if (reason.kind !== 'completed' && (outcome === 'success' || solution !== null)) throw new MemoryError('output', 'L1 non-completed turn cannot assert a successful solution')
  if (solution !== null && outcome !== 'success') throw new MemoryError('output', 'L1 solution requires a successful outcome')
  const seen = new Set<string>()
  const sources = summary.sources.map((source: unknown) => {
    const ref = object(source)
    exact(ref, ['sessionId', 'seq'])
    const sessionId = SessionId(textValue(ref.sessionId))
    const seq = SessionSeq(integer(ref.seq))
    const key = JSON.stringify([sessionId, seq])
    const supplied = typeof allowed === 'function' ? allowed({ sessionId, seq }) : allowed.some(item => item.sessionId === sessionId && item.seq === seq)
    if (seen.has(key) || !supplied) throw new MemoryError('output', 'L1 duplicate or unprovided event reference')
    seen.add(key)
    return { sessionId, seq }
  })
  return { kind: 'memory', summary: { goal: textValue(summary.goal), actions: summary.actions.map(textValue), outcome, result: textValue(summary.result), solution, sources } }
}
