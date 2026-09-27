/** Resolve knowledge model and scoring settings without loading Session runtime modules. */
import { resolveL1Config } from './l1-config.ts'
import { MemoryError } from './types.ts'
import type { KnowledgeConfig, KnowledgeSpec } from './knowledge-types.ts'

/** Resolve scoring and bounded model settings once per operation.
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
  return Object.freeze({ ...base, promptVersion: 'knowledge-v1', scoreMin, scoreMax, l2Threshold, l3Threshold })
}
