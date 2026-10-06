/** Real SQLite knowledge lifecycle fixtures; no external model or production grant adapter. */
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'
import type { KnowledgeCandidate, KnowledgeConfig, KnowledgeLevel, KnowledgeSpec } from '../src/knowledge-types.ts'
import type { MemoryRef } from '../src/l1-types.ts'
import { batch, fixture, header } from './helpers.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'

/** Create a durable source L1 and a knowledge-ready provider.
 * @param overrides - knowledge model settings.
 * @returns memory-owned fixture and source version.
 */
export async function knowledgeFixture(overrides: Partial<KnowledgeConfig> = {}) {
  const item = await fixture()
  try {
    const provider = await item.open()
    const project = item.spec.projectId
    await provider.appendRaw(batch(item.spec, turnEvents()))
    provider.scanTurns(project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(project, header().id, 'fixture', 1)!
    provider.l1.prepare(project, task.operationId, 'fixture', candidate(task))
    const source = provider.l1.commitMemory(project, task.operationId, 'fixture', 2)!
    const config: KnowledgeSpec = { ...resolveKnowledgeConfig({ provider: 'test', model: 'test', ...overrides }), promptVersion: 'knowledge-v3' as const }
    return { ...item, provider, project, source, config }
  } catch (error) { await item.close(); throw error }
}

/** A supported constraint with an exact supplied source.
 * @param source - preceding-level memory.
 * @param body - knowledge text.
 * @returns candidate fixture.
 */
export function knowledgeCandidate(source: MemoryRef, body = 'Use strict TypeScript'): KnowledgeCandidate {
  return { target: null, knowledge: { title: 'Type checking', body, category: 'constraint', score: 4, rationale: 'Explicit project constraint',
    evidence: 'supported', sources: [{ kind: 'memory', ref: { id: source.id, revision: source.revision } }] } }
}

/** Commit a fixture batch through the production enqueue, prepare and transaction methods.
 * @param fixture - open fixture.
 * @param level - target level.
 * @param sources - preceding-level records.
 * @param candidates - model fixture batch.
 * @param model - distinct task configuration where needed.
 * @returns committed references.
 */
export function commitKnowledge(fixture: Awaited<ReturnType<typeof knowledgeFixture>>, level: KnowledgeLevel, sources: MemoryRef[], candidates: KnowledgeCandidate[], model = 'test') {
  const store = fixture.provider.knowledge
  const operation = store.enqueue(fixture.project, level, sources, { ...fixture.config, model })
  store.claim(fixture.project, operation, 'fixture', 10)
  store.prepare(fixture.project, operation, 'fixture', candidates)
  return store.commit(fixture.project, operation, 'fixture', 11)
}
