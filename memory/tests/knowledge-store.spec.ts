/** Scoring, immutable sources, transactional recovery and grant visibility against SQLite. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { resolveKnowledgeConfig, parseKnowledgeCandidates } from '../src/knowledge-validation.ts'
import type { MemoryId, OperationId } from '../src/l1-types.ts'
import type { ProjectId } from '../src/types.ts'
import type { KnowledgeMemory, ShareAction } from '../src/knowledge-types.ts'
import { knowledgeFixture, knowledgeCandidate, commitKnowledge } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'

const owned: Array<Awaited<ReturnType<typeof knowledgeFixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })
async function setup() { const item = await knowledgeFixture(); owned.push(item); return item }
const other = 'other-project' as ProjectId

it('migrates populated schema 2 while retaining exact L0 and L1 records', async () => {
  const item = await setup()
  const raw = await item.provider.readRaw({ projectId: item.project, sessionId: header().id, from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 10 })
  await item.provider.close()
  const db = new DatabaseSync(item.spec.databasePath)
  try { db.exec('DROP TRIGGER memory_l1_insert; DROP TRIGGER memory_knowledge_insert; DROP TRIGGER memory_knowledge_update; DROP TRIGGER memory_grant_insert; DROP TRIGGER memory_grant_delete; DROP INDEX memory_knowledge_candidates; DROP TABLE memory_vectors; DROP TABLE memory_index_state; DROP TABLE memory_generation; DROP TABLE knowledge_grants; DROP TABLE knowledge_share_actions; DROP TABLE knowledge_operations; DROP TABLE knowledge_tasks; DROP TABLE knowledge_versions; PRAGMA user_version = 2') } finally { db.close() }
  const provider = await item.open()
  expect(provider.l1.getMemory(item.project, item.source)).toEqual(item.source)
  expect(await provider.readRaw({ projectId: item.project, sessionId: header().id, from: SessionLogOffset(0), to: SessionLogOffset(3), limit: 10 })).toEqual(raw)
  const check = new DatabaseSync(item.spec.databasePath)
  try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(4) } finally { check.close() }
})

it('rolls back schema 3 migration failures without changing schema 2 data', async () => {
  const item = await setup()
  await item.provider.close()
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.exec('DROP TRIGGER memory_l1_insert; DROP TRIGGER memory_knowledge_insert; DROP TRIGGER memory_knowledge_update; DROP TRIGGER memory_grant_insert; DROP TRIGGER memory_grant_delete; DROP INDEX memory_knowledge_candidates; DROP TABLE memory_vectors; DROP TABLE memory_index_state; DROP TABLE memory_generation; DROP TABLE knowledge_grants; DROP TABLE knowledge_share_actions; DROP TABLE knowledge_operations; DROP TABLE knowledge_tasks; DROP TABLE knowledge_versions; CREATE TABLE knowledge_tasks (wrong TEXT); PRAGMA user_version = 2')
    await expect(item.open()).rejects.toThrow()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM l1_memories').get()?.n).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'knowledge_versions'").get()).toBeUndefined()
  } finally { db.close() }
})

it('filters low scores without removing original memory and deduplicates exact facts', async () => {
  const item = await setup()
  const candidate = knowledgeCandidate(item.source)
  expect(commitKnowledge(item, 'L2', [item.source], [{ ...candidate, knowledge: { ...candidate.knowledge, score: 2 } }])).toEqual([])
  const first = commitKnowledge(item, 'L2', [item.source], [candidate], 'next')[0]!
  expect(commitKnowledge(item, 'L2', [item.source], [candidate], 'repeat')).toEqual([first])
  expect(item.provider.knowledge.listCandidates(item.project, 'L2')).toHaveLength(1)
  expect(item.provider.knowledge.getMemory(item.project, item.source)).toEqual(item.source)
  const op = item.provider.knowledge.enqueue(item.project, 'L2', [item.source], { ...item.config, model: 'repeat' })
  expect(item.provider.knowledge.commit(item.project, op, 'unrelated', 999)).toEqual([first])
})

it('merges into a stable identity and keeps replaced content readable only as owned history', async () => {
  const item = await setup()
  const first = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const next = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'Use strict TypeScript and exact optional properties'), target: first }], 'changed')[0]!
  expect(next).toEqual({ id: first.id, revision: 2 })
  expect(item.provider.knowledge.getMemory(item.project, first)).toMatchObject({ state: 'superseded', knowledge: { body: 'Use strict TypeScript' } })
  expect(item.provider.knowledge.listCandidates(item.project, 'L2')).toMatchObject([{ ...next, state: 'active' }])
})

it('retains unresolved conflicts but excludes them from candidates and L3 sources', async () => {
  const item = await setup()
  const first = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const candidate = knowledgeCandidate(item.source, 'Conflicting requirements: strict and non-strict')
  const conflict = commitKnowledge(item, 'L2', [item.source], [{ target: first, knowledge: { ...candidate.knowledge, evidence: 'conflict' } }], 'conflict')[0]!
  expect(item.provider.knowledge.getMemory(item.project, conflict)).toMatchObject({ knowledge: { evidence: 'conflict' } })
  expect(item.provider.knowledge.listCandidates(item.project, 'L2')).toEqual([])
  expect(() => item.provider.knowledge.enqueue(item.project, 'L3', [conflict], item.config)).toThrow(/source/)
})

it('rejects foreign sources, forged output references and unsupported successful methods', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  expect(() => store.enqueue(other, 'L2', [item.source], item.config)).toThrow(/owned/)
  const op = store.enqueue(item.project, 'L2', [item.source], item.config)
  store.claim(item.project, op, 'worker', 10)
  const candidate = knowledgeCandidate(item.source)
  expect(() => store.prepare(item.project, op, 'worker', [{ ...candidate, knowledge: { ...candidate.knowledge, category: 'method' } }])).toThrow(/successful/)
  expect(() => store.prepare(item.project, op, 'worker', [knowledgeCandidate({ id: 'forged' as MemoryId, revision: 1 })])).toThrow(/outside/)
  expect(() => store.prepare(item.project, op, 'worker', [{ ...candidate, approved: true }])).toThrow(/Unexpected/)
  const input = store.getTask(item.project, op)!.input
  const parsed = parseKnowledgeCandidates([{ ...candidate, knowledge: { ...candidate.knowledge, sources: [...candidate.knowledge.sources, ...candidate.knowledge.sources] } }], input, item.config)
  expect(parsed[0]?.knowledge.sources).toHaveLength(1)
})

it('rejects invalid score configuration and model scores outside the configured range', async () => {
  expect(() => resolveKnowledgeConfig({ provider: 'test', model: 'test', l2Threshold: 5, l3Threshold: 4 })).toThrow()
  const item = await setup()
  const op = item.provider.knowledge.enqueue(item.project, 'L2', [item.source], item.config)
  const task = item.provider.knowledge.getTask(item.project, op)!
  const candidate = knowledgeCandidate(item.source)
  for (const score of [-1, 6, 2.5, NaN]) expect(() => parseKnowledgeCandidates([{ ...candidate, knowledge: { ...candidate.knowledge, score } }], task.input, item.config)).toThrow()
})

it('retains prepared candidates across a rolled-back commit and database reopen', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const op = store.enqueue(item.project, 'L2', [item.source], item.config)
  const task = store.claim(item.project, op, 'worker', 10)!
  store.prepare(item.project, op, 'worker', [knowledgeCandidate(item.source)])
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.exec("CREATE TRIGGER reject_knowledge BEFORE INSERT ON knowledge_versions BEGIN SELECT RAISE(ABORT, 'fixture'); END")
    expect(() => store.commit(item.project, op, 'worker', 11)).toThrow()
    expect(store.getTask(item.project, op)?.status).toBe('prepared')
    db.exec('DROP TRIGGER reject_knowledge')
  } finally { db.close() }
  await item.provider.close()
  const recovered = await item.open()
  expect(recovered.knowledge.claim(item.project, op, 'new', 11)).toBeNull()
  expect(recovered.knowledge.claim(item.project, op, 'new', task.leaseUntil + 1)?.candidates).toHaveLength(1)
  const result = recovered.knowledge.commit(item.project, op, 'new', task.leaseUntil + 2)
  expect(recovered.knowledge.commit(item.project, op, 'any', 999)).toEqual(result)
})

it('serializes projects across connections and discards stale merges after a version conflict', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const first = store.enqueue(item.project, 'L2', [item.source], item.config)
  const second = store.enqueue(item.project, 'L2', [item.source], { ...item.config, model: 'second' })
  store.claim(item.project, first, 'one', 10)
  const another = await item.open()
  expect(another.knowledge.claim(item.project, second, 'two', 10)).toBeNull()
  store.prepare(item.project, first, 'one', [knowledgeCandidate(item.source)])
  store.commit(item.project, first, 'one', 11)
  another.knowledge.claim(item.project, second, 'two', 12)
  another.knowledge.prepare(item.project, second, 'two', [knowledgeCandidate(item.source)])
  expect(() => another.knowledge.commit(item.project, second, 'two', 13)).toThrow(/revisions/)
  another.knowledge.fail(item.project, second, 'two', 'conflict', true, 14)
  expect(another.knowledge.getTask(item.project, second)).toMatchObject({ status: 'retry', candidates: null, input: { existing: [{ revision: 1 }] } })
})

function action(item: Awaited<ReturnType<typeof setup>>, ref: { id: MemoryId; revision: number }, name: string, kind: 'approve' | 'revoke' = 'approve'): ShareAction {
  return { operationId: name as OperationId, projectId: item.project, ref, action: kind, userId: 'human', receiptId: 'receipt-' + name, occurredAt: 1, expiresAt: 1000 }
}

it('shares only an exact current L3 projection and revokes visibility without exposing private sources', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2)])[0]!
  expect(store.getMemory(other, l3)).toBeNull()
  expect(() => store.approveShare(action(item, l2, 'wrong-level'), () => true, 10)).toThrow()
  expect(() => store.approveShare(action(item, l3, 'forged'), () => false, 10)).toThrow(/receipt/)
  expect(() => store.approveShare(action(item, l3, 'expired'), () => true, 1001)).toThrow(/receipt/)
  const approve = action(item, l3, 'approve')
  store.approveShare(approve, () => true, 10)
  store.approveShare(approve, () => true, 11)
  expect(store.getMemory(other, l3)).toEqual({ ...l3, projectId: item.project, level: 'L3', shared: true, title: 'Type checking', body: 'Use strict TypeScript' })
  expect(store.listCandidates(other, 'L3')).toHaveLength(1)
  expect(store.getMemory(other, l2)).toBeNull()
  expect(store.getMemory(other, item.source)).toBeNull()
  expect(() => store.approveShare({ ...approve, operationId: 'reuse' as OperationId }, () => true, 12)).toThrow(/consumed/)
  const revoke = action(item, l3, 'revoke', 'revoke')
  store.revokeShare(revoke, () => true, 20)
  store.revokeShare(revoke, () => true, 21)
  expect(store.getMemory(other, l3)).toBeNull()
  store.approveShare(approve, () => true, 22)
  expect(store.getMemory(other, l3)).toBeNull()
  expect(store.getMemory(item.project, l3)).toHaveProperty('knowledge.sources')
})

it('updates and invalidation retire grants atomically and require approval of the new version', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2)])[0]!
  store.approveShare(action(item, l3, 'old'), () => true, 10)
  const updated = commitKnowledge(item, 'L3', [l2], [{ ...knowledgeCandidate(l2, 'Use strict TypeScript for all new modules'), target: l3 }], 'updated')[0]!
  expect(store.getMemory(other, l3)).toBeNull()
  expect(store.getMemory(other, updated)).toBeNull()
  expect(() => store.approveShare(action(item, l3, 'stale'), () => true, 12)).toThrow()
  store.approveShare(action(item, updated, 'new'), () => true, 12)
  store.invalidateMemory(item.project, updated, 'No longer applies', 'invalidate' as OperationId)
  store.invalidateMemory(item.project, updated, 'No longer applies', 'invalidate' as OperationId)
  expect(() => store.invalidateMemory(item.project, updated, 'Different reason', 'invalidate' as OperationId)).toThrow(/reused/)
  expect(store.listCandidates(other, 'L3')).toEqual([])
  expect((store.getMemory(item.project, updated) as KnowledgeMemory).state).toBe('invalidated')
})

it('keeps even low-scored conflicts from leaving an old fact eligible', async () => {
  const item = await setup()
  const first = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const candidate = knowledgeCandidate(item.source, 'The strictness requirement is disputed')
  commitKnowledge(item, 'L2', [item.source], [{ target: first, knowledge: { ...candidate.knowledge, evidence: 'conflict', score: 0 } }], 'low-conflict')
  expect(item.provider.knowledge.listCandidates(item.project, 'L2')).toEqual([])
  expect(item.provider.knowledge.getMemory(item.project, first)).toMatchObject({ state: 'superseded' })
})

it('provides L3 with original evidence and rejects laundering an unverified outcome through L2', async () => {
  const item = await setup()
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const store = item.provider.knowledge
  const op = store.enqueue(item.project, 'L3', [l2], item.config)
  const task = store.claim(item.project, op, 'worker', 10)!
  expect(task.input.lineage).toEqual([item.source])
  const candidate = knowledgeCandidate(l2)
  expect(() => store.prepare(item.project, op, 'worker', [{ ...candidate, knowledge: { ...candidate.knowledge, category: 'method' } }])).toThrow(/successful/)
  expect(() => store.prepare(item.project, op, 'worker', [{ ...candidate, knowledge: { ...candidate.knowledge, category: 'local' } }])).toThrow(/L3 requires/)
})

it('rejects stale sources and stale workers without publishing', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const op = store.enqueue(item.project, 'L2', [item.source], item.config)
  const first = store.claim(item.project, op, 'first', 10)!
  store.claim(item.project, op, 'second', first.leaseUntil + 1)
  expect(() => store.prepare(item.project, op, 'first', [knowledgeCandidate(item.source)])).toThrow(/owns/)
  expect(store.getTask(other, op)).toBeNull()
  expect(store.listTasks(other)).toEqual([])
  expect(store.listCandidates(item.project, 'L1', item.source.id)).toEqual([])
  expect(() => store.listCandidates(item.project, 'L2', '', 0)).toThrow()
})

it('promotes a successful method through L2 and L3 with exact original sources', async () => {
  const item = await setup()
  const l1 = item.provider.l1
  const operation = l1.rerun(item.project, item.source.operationId, 'reextract', item.source.config)
  l1.claim(item.project, header().id, 'worker', 10)
  l1.prepare(item.project, operation, 'worker', { kind: 'memory', summary: { ...item.source.summary, outcome: 'success', result: 'The parser regression test passed', solution: 'Enable strict checks' } })
  const source = l1.commitMemory(item.project, operation, 'worker', 11)!
  expect(() => item.provider.knowledge.enqueue(item.project, 'L2', [item.source], item.config)).toThrow(/source/)
  const candidate = knowledgeCandidate(source)
  const l2 = commitKnowledge(item, 'L2', [source], [{ ...candidate, knowledge: { ...candidate.knowledge, category: 'method' } }])[0]!
  const l3Candidate = knowledgeCandidate(l2)
  const l3 = commitKnowledge(item, 'L3', [l2], [{ ...l3Candidate, knowledge: { ...l3Candidate.knowledge, category: 'method' } }])[0]!
  expect(item.provider.knowledge.getMemory(item.project, l3)).toMatchObject({ level: 'L3', knowledge: { category: 'method', sources: [{ kind: 'memory', ref: l2 }] } })
})
