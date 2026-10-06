/** New card, execution-verification and conflict behavior over actual SQLite versions and provider-neutral streams. */
import { expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { executionRefs, evidenceStatus, episodeTrace } from '../src/evidence.ts'
import { L1Extractor } from '../src/l1-extractor.ts'
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'
import { parseKnowledge, parseKnowledgeCandidates } from '../src/knowledge-validation.ts'
import { vectorDocument } from '../src/vector-store.ts'
import { MemoryRetriever } from '../src/retrieval.ts'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import { HybridMemoryRetriever, resolveHybridConfig } from '../src/hybrid-retrieval.ts'
import { resolveEmbeddingConfig } from '../src/embedding.ts'
import { panelRowOf } from '../src/panel-host.ts'
import { knowledgeFixture, knowledgeCandidate, commitKnowledge } from './knowledge-fixtures.ts'
import { batch, fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import type { EvidenceReceiptId, KnowledgeCandidate, KnowledgeInput } from '../src/knowledge-types.ts'
import type { MemoryRef } from '../src/l1-types.ts'

function card(ref: MemoryRef, body = 'Declare project and workspace explicitly', kind: 'knowledge' | 'profile' = 'knowledge'): KnowledgeCandidate {
  const candidate = knowledgeCandidate(ref, body)
  return { ...candidate, action: 'store', knowledge: { ...candidate.knowledge, scenario: 'Workspace management', conclusion: body,
    reason: 'Project identity determines storage ownership', whenToUse: ['Multiple projects'], recommendedAction: body,
    limitations: ['Does not migrate existing data'], kind, conflicts: [], description: body } }
}

function executionEvents(output = 'Tests passed', args = '{"command":"pnpm test"}'): SessionEvent[] {
  const base = turnEvents()
  const callId = ToolCallId('checked-command')
  return [base[0]!, base[1]!, { type: 'tool/call', seq: SessionSeq(2), time: 3,
    data: { turn: 1, step: 1, callId, name: 'bash', arguments: args } },
  { type: 'tool/result', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1,
    message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: output }] }) }, surfaceOp: 'append' },
  { ...base[2]!, seq: SessionSeq(4), time: 5 }]
}

async function* response(value: unknown): AsyncIterable<StreamChunk> {
  const text = JSON.stringify(value)
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

it.each([
  ['Tests passed', '{}', 1], ['Failed\n[exit code: 1]', '{}', 0], ['Cut short\n[timed out after 20ms]', '{}', 0],
  ['Killed\n[killed by signal: SIGTERM]', '{}', 0], ['No status\n[exit code: null]', '{}', 0], ['Stopped\n[stopped: user]', '{}', 0], ['started background job job-a', '{}', 0],
  ['Tests passed', '{"run_in_background":true}', 0], ['Tests passed', 'invalid-json', 0],
])('checks recorded shell settlement %s without asking the model', (output, args, count) => {
  expect(executionRefs(header().id, executionEvents(output, args))).toHaveLength(count)
  expect(executionRefs(header().id, turnEvents({ kind: 'completed' }, 'Assistant claims all tests passed'))).toEqual([])
})

it('extracts and commits a readable episode in one recorded call while retaining trace and checked results', async () => {
  const item = await fixture()
  try {
    const provider = await item.open()
    const events = executionEvents()
    await provider.appendRaw(batch(item.spec, events))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test', maxCalls: 1 }), 10)
    const task = provider.l1.claim(item.spec.projectId, header().id, 'worker', 1)!
    const value = { kind: 'memory', summary: { title: 'Parser repair', goal: 'Repair parser', problem: 'Failing parser', actions: ['Ran pnpm test'],
      outcome: 'success', result: 'Tests passed', solution: 'Correct parsing', summary: 'Parser repaired and tested', description: 'Parser repaired and tested',
      sources: [{ sessionId: task.sessionId, seq: 2 }, { sessionId: task.sessionId, seq: 3 }] } }
    let calls = 0
    let records = 0
    const llm: Pick<LlmRuntime, 'stream'> = { stream: () => { expect(records).toBe(1); calls++; return response(value) } }
    const extractor = new L1Extractor(llm, async () => { records++ })
    const candidate = await extractor.extractTurn(task, events, new AbortController().signal,
      () => provider.l1.reserveCall(item.spec.projectId, task.operationId, 'worker'))
    expect(calls).toBe(1)
    provider.l1.prepare(item.spec.projectId, task.operationId, 'worker', candidate)
    const memory = provider.l1.commitMemory(item.spec.projectId, task.operationId, 'worker', 2)!
    expect(memory.summary.executionEvidence).toEqual([{ sessionId: task.sessionId, seq: 3 }])
    expect(memory.summary.trace?.commands.join()).toContain('pnpm test')
    expect(vectorDocument(memory).text).not.toContain('pnpm test')
    const panel = panelRowOf(memory)
    expect(panel.sections.map(section => section.label)).not.toContain('actions')
    expect(panel.trace).toContain('pnpm test')
    const spec = resolveKnowledgeConfig({ provider: 'test', model: 'test' })
    let source: MemoryRef = memory
    for (const level of ['L2', 'L3'] as const) {
      const operation = provider.knowledge.enqueue(item.spec.projectId, level, [source], spec)
      provider.knowledge.claim(item.spec.projectId, operation, 'worker', 10)
      const method = card(source, 'Repair parsing and run the parser tests')
      provider.knowledge.prepare(item.spec.projectId, operation, 'worker', [{ ...method, knowledge: {
        ...method.knowledge, category: 'method', evidenceStatus: 'execution_verified' } }])
      source = provider.knowledge.commit(item.spec.projectId, operation, 'worker', 11)[0]!
      expect(provider.knowledge.getMemory(item.spec.projectId, source)).toMatchObject({ knowledge: { evidenceStatus: 'execution_verified' } })
    }
    await provider.close()
    const reopened = await item.open()
    expect(reopened.l1.getMemory(item.spec.projectId, memory)).toEqual(memory)
  } finally { await item.close() }
})

it('rejects model-claimed and forged program-owned execution success', async () => {
  const item = await fixture()
  try {
    const provider = await item.open()
    await provider.appendRaw(batch(item.spec, executionEvents('Failed\n[exit code: 1]')))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(item.spec.projectId, header().id, 'worker', 1)!
    const value = { kind: 'memory' as const, summary: { goal: 'Repair', actions: [], outcome: 'success' as const, result: 'Claimed success', solution: 'Claimed fix',
      sources: [{ sessionId: task.sessionId, seq: SessionSeq(3) }], executionEvidence: [{ sessionId: task.sessionId, seq: SessionSeq(3) }] } }
    expect(() => provider.l1.prepare(item.spec.projectId, task.operationId, 'worker', value)).toThrow('execution evidence')
    expect(episodeTrace(executionEvents('Failed\n[exit code: 1]'), []).errors.join()).toContain('Failed')
  } finally { await item.close() }
})

it('keeps unresolved alternatives, prior versions and timestamps while suspending derived recall', async () => {
  const item = await knowledgeFixture()
  try {
    const store = item.provider.knowledge
    const old = commitKnowledge(item, 'L2', [item.source], [card(item.source)])[0]!
    const stable = commitKnowledge(item, 'L3', [old], [card(old)])[0]!
    const conflicting = card(item.source, 'Explicit project identity versus inherited defaults remains unresolved')
    const next = commitKnowledge(item, 'L2', [item.source], [{ ...conflicting, action: 'conflict', target: old, knowledge: { ...conflicting.knowledge,
      evidence: 'conflict', evidenceStatus: 'conflicted', conflicts: [{ ref: old, reason: 'New recommendation contradicts the recorded rule' }],
      sources: [...conflicting.knowledge.sources, { kind: 'memory', ref: old }] } }], 'conflict')[0]!
    expect(next).toEqual({ id: old.id, revision: 2 })
    expect(store.getMemory(item.project, old)).toMatchObject({ state: 'superseded', createdAt: 11 })
    expect(store.getMemory(item.project, next)).toMatchObject({ knowledge: { conflicts: [{ ref: old }], evidenceStatus: 'conflicted' } })
    expect(store.sourcesCurrent(item.project, stable)).toBe(false)
    expect(store.listCandidates(item.project, 'L3')).toEqual([])
    const skipped = commitKnowledge(item, 'L2', [item.source], [{ ...card(item.source), action: 'skip' }], 'skip')
    expect(skipped).toEqual([])
    await item.provider.close()
    expect((await item.open()).knowledge.getMemory(item.project, next)).toMatchObject({ knowledge: { conflicts: [{ ref: old }] } })
  } finally { await item.close() }
})

it('requires checked execution ancestry for new methods and trusted receipts for confirmation', async () => {
  const item = await knowledgeFixture()
  try {
    const candidate = card(item.source)
    const input: KnowledgeInput = { projectId: item.project, level: 'L2', sources: [item.source], existing: [], lineage: [] }
    const spec = { ...item.config, promptVersion: 'knowledge-v4' as const }
    expect(() => parseKnowledgeCandidates([{ ...candidate, knowledge: { ...candidate.knowledge, category: 'method' } }], input, spec)).toThrow('program-verified')
    expect(() => parseKnowledge({ ...candidate.knowledge, evidenceStatus: 'user_confirmed' }, spec)).toThrow('receipt')
    expect(() => parseKnowledge({ ...candidate.knowledge, whenToUse: 'all' }, spec)).toThrow('text list')
    const ref = commitKnowledge(item, 'L2', [item.source], [candidate])[0]!
    const receipt = { status: 'user_confirmed' as const, actor: 'test-user', receiptId: 'test-receipt' as EvidenceReceiptId, reference: 'explicit UI confirmation', occurredAt: 20 }
    const forged = item.provider.knowledge.enqueue(item.project, 'L2', [item.source], { ...item.config, model: 'forged-confirmation' })
    item.provider.knowledge.claim(item.project, forged, 'worker', 20)
    expect(() => item.provider.knowledge.prepare(item.project, forged, 'worker', [{ ...candidate, knowledge: {
      ...candidate.knowledge, evidenceStatus: 'user_confirmed', confirmation: receipt } }])).toThrow('trusted confirmation')
    const next = item.provider.knowledge.confirmEvidence(item.project, ref, receipt)
    expect(item.provider.knowledge.confirmEvidence(item.project, ref, receipt)).toEqual(next)
    expect(() => item.provider.knowledge.confirmEvidence(item.project, ref, { ...receipt, actor: 'different' })).toThrow('reused')
    const memory = item.provider.knowledge.getMemory(item.project, next)!
    expect(memory).toMatchObject({ knowledge: { evidenceStatus: 'user_confirmed', confirmation: receipt } })
    expect(evidenceStatus(candidate.knowledge)).toBe('model_supported')
    expect(evidenceStatus(candidate.knowledge, false)).toBe('stale')
  } finally { await item.close() }
})

it('fuses lexical and vector ranks, separates profiles and respects exact scenario and byte selectors', async () => {
  const item = await knowledgeFixture()
  let hybrid: HybridMemoryRetriever | undefined
  try {
    const refs = commitKnowledge(item, 'L2', [item.source], [card(item.source), card(item.source, 'Prefer direct technical answers', 'profile')])
    const stable = commitKnowledge(item, 'L3', [...refs], [card(refs[0]!), card(refs[1]!, 'Prefer direct technical answers', 'profile')])
    const text = new TextMemoryRetriever(item.provider, resolveTextSearchConfig({}))
    const vector = new MemoryRetriever(item.provider, resolveEmbeddingConfig({ endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2,
      apiKeyEnv: 'TEST_KEY', threshold: 0 }), { embed: async texts => ({ vectors: texts.map(() => [1, 0]), tokens: null }) }, () => {})
    hybrid = new HybridMemoryRetriever(text, vector, resolveHybridConfig({ candidateLimit: 10 }))
    hybrid.schedule()
    await hybrid.flush()
    const result = await hybrid.retrieve({ projectId: item.project, text: 'workspace', levels: ['L3'], kinds: ['knowledge'], scenario: 'Workspace management' })
    expect(result.method).toBe('hybrid')
    expect(result.hits.map(hit => hit.ref)).toEqual([stable[0]])
    expect(result.hits[0]!.score).toBeCloseTo(2 / 61)
    expect((await hybrid.retrieve({ projectId: item.project, text: 'technical', levels: ['L3'], kinds: ['profile'] })).hits.map(hit => hit.ref)).toEqual([stable[1]])
    expect((await hybrid.retrieve({ projectId: item.project, text: 'workspace', maxBytes: 1 })).hits).toEqual([])
    expect(item.provider.knowledge.browse(item.project, 'L3', '', 10, '', { kind: 'profile' }).map(memory => memory.id)).toEqual([stable[1]!.id])
    expect(item.provider.knowledge.browse(item.project, 'L2', '', 10, '', { scenario: 'Missing' })).toEqual([])
    item.provider.vectors.clear(vector.spec)
    await expect(hybrid.retrieve({ projectId: item.project, text: 'workspace' })).rejects.toMatchObject({ code: 'index-not-ready' })
  } finally { await hybrid?.close(); await item.close() }
})
