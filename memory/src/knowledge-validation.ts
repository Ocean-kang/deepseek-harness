/** Explicit knowledge scoring configuration and model-output validation. */
import { integer, object, textValue, textList } from './l1-validation.ts'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MemoryError } from './types.ts'
import type { L1Memory, MemoryId, MemoryRef } from './l1-types.ts'
import type { EvidenceReceiptId, Knowledge, KnowledgeCandidate, KnowledgeInput, KnowledgeSpec } from './knowledge-types.ts'

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

/** Decode content and stored inspection references; model requests separately reject inspection fields.
 * @param value - external or durable knowledge body.
 * @param config - allowed score range.
 * @returns validated content and deduplicated exact sources.
 */
export function parseKnowledge(value: unknown, config: KnowledgeSpec): Knowledge {
  const item = object(value)
  const keys = ['title', 'body', 'description', 'examinedEvents', 'category', 'score', 'rationale', 'evidence', 'sources', 'scenario', 'conclusion', 'reason', 'whenToUse', 'recommendedAction', 'limitations', 'kind', 'evidenceStatus', 'conflicts', 'confirmation']
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
  const description = item.description === undefined ? undefined : textValue(item.description).trim()
  if (description !== undefined && (/[\r\n]/u.test(description) || Array.from(description).length > 240)) throw new MemoryError('output', 'Knowledge description must be one short line')
  if (item.examinedEvents !== undefined && (!Array.isArray(item.examinedEvents) || item.examinedEvents.length === 0)) throw new MemoryError('output', 'Knowledge examined events must be a nonempty array')
  const examinedEvents = item.examinedEvents === undefined ? undefined : item.examinedEvents.map((value: unknown) => {
    const ref = object(value)
    if (Object.keys(ref).some(key => key !== 'sessionId' && key !== 'seq')) throw new MemoryError('output', 'Invalid examined event reference')
    return { sessionId: SessionId(textValue(ref.sessionId)), seq: SessionSeq(integer(ref.seq)) }
  })
  const card = item.scenario === undefined ? {} : { scenario: textValue(item.scenario), conclusion: textValue(item.conclusion),
    reason: textValue(item.reason), whenToUse: textList(item.whenToUse), recommendedAction: textValue(item.recommendedAction), limitations: textList(item.limitations) }
  if (item.scenario === undefined && ['conclusion', 'reason', 'whenToUse', 'recommendedAction', 'limitations'].some(key => item[key] !== undefined)) throw new MemoryError('output', 'Incomplete knowledge card')
  if (item.kind !== undefined && item.kind !== 'knowledge' && item.kind !== 'profile') throw new MemoryError('output', 'Invalid stable memory kind')
  if (item.evidenceStatus !== undefined && !['claimed', 'model_supported', 'user_confirmed', 'execution_verified', 'externally_verified', 'conflicted', 'stale'].includes(textValue(item.evidenceStatus))) throw new MemoryError('output', 'Invalid evidence status')
  if ((item.evidenceStatus === 'conflicted' && evidence !== 'conflict')
    || (['model_supported', 'execution_verified', 'user_confirmed', 'externally_verified'].includes(String(item.evidenceStatus)) && evidence !== 'supported')) throw new MemoryError('output', 'Evidence origin disagrees with support state')
  if (item.conflicts !== undefined && !Array.isArray(item.conflicts)) throw new MemoryError('output', 'Invalid knowledge conflicts')
  const conflicts = item.conflicts === undefined ? undefined : item.conflicts.map((value: unknown) => {
    const conflict = object(value)
    if (Object.keys(conflict).some(key => key !== 'ref' && key !== 'reason')) throw new MemoryError('output', 'Invalid conflict fields')
    return { ref: knowledgeRef(conflict.ref), reason: textValue(conflict.reason) }
  })
  const confirmation = item.confirmation === undefined ? undefined : object(item.confirmation)
  if (confirmation !== undefined && (Object.keys(confirmation).some(key => !['status', 'actor', 'receiptId', 'reference', 'occurredAt'].includes(key))
    || !['user_confirmed', 'externally_verified'].includes(textValue(confirmation.status)) || confirmation.status !== item.evidenceStatus)) throw new MemoryError('output', 'Invalid evidence confirmation')
  if (['user_confirmed', 'externally_verified'].includes(String(item.evidenceStatus)) && confirmation === undefined) throw new MemoryError('output', 'Trusted evidence status requires a receipt')
  return { ...confirmation === undefined ? {} : { confirmation: { status: confirmation.status as 'user_confirmed' | 'externally_verified',
    actor: textValue(confirmation.actor), receiptId: textValue(confirmation.receiptId) as EvidenceReceiptId, reference: textValue(confirmation.reference), occurredAt: integer(confirmation.occurredAt) } }, ...card, ...item.kind === undefined ? {} : { kind: item.kind as NonNullable<Knowledge['kind']> },
    ...item.evidenceStatus === undefined ? {} : { evidenceStatus: item.evidenceStatus as NonNullable<Knowledge['evidenceStatus']> },
    ...conflicts === undefined ? {} : { conflicts }, title: textValue(item.title), body: textValue(item.body), ...description === undefined ? {} : { description },
    ...examinedEvents === undefined ? {} : { examinedEvents: [...new Map(examinedEvents.map(ref => [JSON.stringify(ref), ref])).values()] }, category: category as Knowledge['category'],
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
  const directRecords = [...input.sources, ...input.existing]
  const allRecords = new Map([...directRecords, ...input.lineage].map(record => [JSON.stringify([record.id, record.revision]), record]))
  return value.map((value: unknown) => {
    const item = object(value)
    if (Object.keys(item).some(key => key !== 'knowledge' && key !== 'target' && key !== 'action')) throw new MemoryError('output', 'Unexpected candidate field')
    const knowledge = parseKnowledge(item.knowledge, config)
    const action = item.action
    if (action !== undefined && !['store', 'update', 'merge', 'skip', 'conflict'].includes(textValue(action))) throw new MemoryError('output', 'Invalid candidate action')
    const target = item.target === null ? null : knowledgeRef(item.target)
    if (target !== null && (!input.existing.some(record => sameRef(record, target)) || targets.has(target.id))) throw new MemoryError('output', 'Invalid or repeated merge target')
    if (target !== null) targets.add(target.id)
    if ((action === 'store' && target !== null) || (['update', 'merge', 'conflict'].includes(String(action)) && target === null)) throw new MemoryError('output', 'Candidate action requires a matching target')
    if (action === 'conflict' && (knowledge.evidence !== 'conflict' || !knowledge.conflicts?.some(conflict => target !== null && sameRef(conflict.ref, target)))) throw new MemoryError('output', 'Conflict must retain its previous version and reason')
    for (const conflict of knowledge.conflicts ?? []) if (!input.existing.some(record => sameRef(record, conflict.ref)) && !input.lineage.some(record => sameRef(record, conflict.ref))) throw new MemoryError('source', 'Conflict version is outside the input')
    const records = knowledge.sources.map(source => {
      const record = directRecords.find(record => sameRef(record, source.ref))
      if (record === undefined || record.projectId !== input.projectId || record.state !== 'active') throw new MemoryError('source', 'Knowledge source is outside the current input')
      return record
    })
    if (!records.some(record => input.sources.some(source => sameRef(record, source)))) throw new MemoryError('source', 'Candidate must cite a source from the preceding level')
    if (input.level === 'L3' && (['temporary', 'local'].includes(knowledge.category) || knowledge.evidence !== 'supported' || records.some(record => record.level === 'L1' || record.knowledge.evidence !== 'supported'))) {
      throw new MemoryError('output', 'L3 requires supported, nonconflicting sources')
    }
    const roots = new Map<string, L1Memory>()
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
          const parent = allRecords.get(JSON.stringify([source.ref.id, source.ref.revision]))
          if (parent === undefined) throw new MemoryError('source', 'Missing knowledge ancestry')
          pending.push(parent)
        }
      }
    }
    if (knowledge.examinedEvents?.some(ref => ![...roots.values()].some(root => root.summary.sources.some(source => source.sessionId === ref.sessionId && source.seq === ref.seq)))) {
      throw new MemoryError('source', 'Examined event is outside the candidate ancestry')
    }
    const successful = [...roots.values()].filter(record => record.summary.outcome === 'success')
    const method = knowledge.evidence === 'supported' && knowledge.category === 'method'
    if (config.promptVersion === 'knowledge-v4' && (method || knowledge.evidenceStatus === 'execution_verified')
      && !successful.some(record => record.summary.executionEvidence?.length)) {
      throw new MemoryError('output', knowledge.evidenceStatus === 'execution_verified'
        ? 'Execution verification requires checked successful ancestry' : 'A method requires program-verified successful execution')
    }
    if (method && successful.length === 0) throw new MemoryError('output', 'A method requires a successful source outcome')
    return { knowledge, target, ...action === undefined ? {} : { action: action as NonNullable<KnowledgeCandidate['action']> } }
  })
}

/** Exact deduplication preserves case and punctuation that can change technical facts.
 * @param knowledge - content to normalize.
 * @returns stable content key; evidence remains a separate state.
 */
export function knowledgeKey(knowledge: Knowledge): string {
  return JSON.stringify([knowledge.kind ?? 'knowledge', knowledge.scenario ?? '', knowledge.category, knowledge.body.normalize('NFC').trim().replace(/\s+/gu, ' ')])
}
