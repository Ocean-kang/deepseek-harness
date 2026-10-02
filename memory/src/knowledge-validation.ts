/** Explicit knowledge scoring configuration and model-output validation. */
import { integer, object, textValue } from './l1-validation.ts'
import { MemoryError } from './types.ts'
import type { MemoryId, MemoryRef } from './l1-types.ts'
import type { Knowledge, KnowledgeCandidate, KnowledgeInput, KnowledgeSpec, OwnedMemory } from './knowledge-types.ts'

/** Decode an exact version reference from JSON.
 * @param value - external or durable JSON.
 * @returns nonempty identity and positive revision.
 */
export function knowledgeRef(value: unknown): MemoryRef {
  const item = object(value)
  const revision = integer(item.revision)
  if (revision < 1) throw new MemoryError('output', 'Memory revision must be positive')
  return { id: textValue(item.id) as MemoryId, revision }
}

/** Compare exact immutable references.
 * @param left - first reference.
 * @param right - second reference.
 * @returns whether both identity and revision match.
 */
export function sameRef(left: MemoryRef, right: MemoryRef): boolean {
  return left.id === right.id && left.revision === right.revision
}

/** Decode content without accepting model-owned metadata.
 * @param value - external or durable knowledge body.
 * @param config - allowed score range.
 * @returns validated content and deduplicated exact sources.
 */
export function parseKnowledge(value: unknown, config: KnowledgeSpec): Knowledge {
  const item = object(value)
  const keys = ['title', 'body', 'category', 'score', 'rationale', 'evidence', 'sources']
  if (Object.keys(item).some(key => !keys.includes(key))) throw new MemoryError('output', 'Unexpected knowledge field')
  const category = textValue(item.category)
  const evidence = textValue(item.evidence)
  if (!['temporary', 'local', 'method', 'constraint', 'decision'].includes(category)
    || !['supported', 'unverified', 'conflict'].includes(evidence)
    || typeof item.score !== 'number' || !Number.isSafeInteger(item.score) || item.score < config.scoreMin || item.score > config.scoreMax
    || !Array.isArray(item.sources) || item.sources.length === 0) throw new MemoryError('output', 'Invalid knowledge score, evidence or sources')
  const sources = item.sources.map((value: unknown) => {
    const source = object(value)
    if (source.kind !== 'memory' || Object.keys(source).some(key => key !== 'kind' && key !== 'ref')) throw new MemoryError('output', 'Invalid source kind')
    return { kind: 'memory' as const, ref: knowledgeRef(source.ref) }
  })
  return { title: textValue(item.title), body: textValue(item.body), category: category as Knowledge['category'],
    score: item.score, rationale: textValue(item.rationale), evidence: evidence as Knowledge['evidence'],
    sources: [...new Map(sources.map(source => [JSON.stringify(source.ref), source])).values()] }
}

/** Validate a complete model batch before any durable publication.
 * @param value - parsed model JSON array.
 * @param input - exact project-owned input records.
 * @param config - scoring specification.
 * @returns candidates; low scores are filtered only at commit.
 */
export function parseKnowledgeCandidates(value: unknown, input: KnowledgeInput, config: KnowledgeSpec): KnowledgeCandidate[] {
  if (!Array.isArray(value)) throw new MemoryError('output', 'Expected a knowledge candidate array')
  const targets = new Set<string>()
  return value.map((value: unknown) => {
    const item = object(value)
    if (Object.keys(item).some(key => key !== 'knowledge' && key !== 'target')) throw new MemoryError('output', 'Unexpected candidate field')
    const knowledge = parseKnowledge(item.knowledge, config)
    const target = item.target === null ? null : knowledgeRef(item.target)
    if (target !== null && (!input.existing.some(record => sameRef(record, target)) || targets.has(target.id))) throw new MemoryError('output', 'Invalid or repeated merge target')
    if (target !== null) targets.add(target.id)
    const records = knowledge.sources.map(source => {
      const record = [...input.sources, ...input.existing].find(record => sameRef(record, source.ref))
      if (record === undefined || record.projectId !== input.projectId || record.state !== 'active') throw new MemoryError('source', 'Knowledge source is outside the current input')
      return record
    })
    if (!records.some(record => input.sources.some(source => sameRef(record, source)))) throw new MemoryError('source', 'Candidate must cite a source from the preceding level')
    if (input.level === 'L3' && (['temporary', 'local'].includes(knowledge.category) || knowledge.evidence !== 'supported' || records.some(record => record.level === 'L1' || record.knowledge.evidence !== 'supported'))) {
      throw new MemoryError('output', 'L3 requires supported, nonconflicting sources')
    }
    const roots = new Map<string, OwnedMemory>()
    const seen = new Set<string>()
    const pending = [...records]
    while (pending.length > 0) {
      const record = pending.pop()!
      const identity = JSON.stringify({ id: record.id, revision: record.revision })
      if (seen.has(identity)) continue
      seen.add(identity)
      if (record.level === 'L1') {
        const origin = JSON.stringify([...record.summary.sources].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq))
        const previous = roots.get(origin)
        // Conflicting summaries of the same source cannot create independent positive evidence.
        if (previous === undefined || record.summary.outcome !== 'success') roots.set(origin, record)
      } else {
        for (const source of record.knowledge.sources) {
          const parent = [...input.sources, ...input.existing, ...input.lineage].find(parent => sameRef(parent, source.ref))
          if (parent === undefined) throw new MemoryError('source', 'Missing knowledge ancestry')
          pending.push(parent)
        }
      }
    }
    if (knowledge.evidence === 'supported' && knowledge.category === 'method'
      && ![...roots.values()].some(record => record.level === 'L1' && record.summary.outcome === 'success')) {
      throw new MemoryError('output', 'A method requires a successful source outcome')
    }
    return { knowledge, target }
  })
}

/** Exact deduplication preserves case and punctuation that can change technical facts.
 * @param knowledge - content to normalize.
 * @returns stable content key; evidence remains a separate state.
 */
export function knowledgeKey(knowledge: Knowledge): string {
  return JSON.stringify([knowledge.category, knowledge.body.normalize('NFC').trim().replace(/\s+/gu, ' ')])
}
