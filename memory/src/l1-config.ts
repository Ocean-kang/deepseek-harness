/** L1 defaults are resolved once and persisted with the extraction task. */
import { createHash } from 'node:crypto'
import { MemoryError } from './types.ts'
import type { L1Config, L1Spec } from './l1-types.ts'
import type { KnowledgeConfig, KnowledgeSpec } from './knowledge-types.ts'

/**
 * Resolve all L1 deployment values before scanning or model dispatch.
 * @param input - explicit provider/model and optional bounded tunables.
 * @returns immutable complete extraction settings.
 */
export function resolveL1Config(input: L1Config): L1Spec {
  for (const value of [input.provider, input.model]) {
    if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) throw new MemoryError('config', 'L1 provider and model must be explicit nonempty identifiers')
  }
  const numbers = {
    maxInputBytes: input.maxInputBytes ?? 65536, maxOutputTokens: input.maxOutputTokens ?? 2048,
    timeoutMs: input.timeoutMs ?? 60000, maxCalls: input.maxCalls ?? 32,
    maxAttempts: input.maxAttempts ?? 3, retryBaseMs: input.retryBaseMs ?? 1000, retryMaxMs: input.retryMaxMs ?? 30000,
  }
  for (const [name, value] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new MemoryError('config', `L1 ${name} must be a positive bounded integer`)
  }
  if (numbers.retryBaseMs > numbers.retryMaxMs) throw new MemoryError('config', 'L1 retryBaseMs exceeds retryMaxMs')
  if (!Number.isSafeInteger(numbers.timeoutMs * numbers.maxCalls + numbers.retryMaxMs)) throw new MemoryError('config', 'L1 maximum task duration exceeds safe integer range')
  return Object.freeze({ provider: input.provider, model: input.model, promptVersion: 'l1-v1', ...numbers })
}

/** Resolve knowledge scoring and model settings before creating a task.
 * @param input - explicit model and optional scoring choices.
 * @returns validated settings persisted with the task.
 */
export function resolveKnowledgeConfig(input: KnowledgeConfig): KnowledgeSpec {
  const base = resolveL1Config(input)
  const scoreMin = input.scoreMin ?? 0
  const scoreMax = input.scoreMax ?? 5
  const l2Threshold = input.l2Threshold ?? 3
  const l3Threshold = input.l3Threshold ?? 4
  if (![scoreMin, scoreMax, l2Threshold, l3Threshold].every(Number.isSafeInteger)
    || scoreMin < 0 || scoreMax <= scoreMin || scoreMax > 100
    || l2Threshold < scoreMin || l3Threshold < l2Threshold || l3Threshold > scoreMax) {
    throw new MemoryError('config', 'Invalid knowledge score range or thresholds')
  }
  return Object.freeze({ ...base, promptVersion: 'knowledge-v2', scoreMin, scoreMax, l2Threshold, l3Threshold })
}

/**
 * Hash ordered identity parts without delimiter ambiguity.
 * @param parts - ordered JSON-serializable identity parts.
 * @returns stable hex digest.
 */
export function l1Key(...parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
