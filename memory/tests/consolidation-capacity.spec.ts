/** Bounded indexed consolidation, mandatory source comparisons and optimistic publication. */
import { afterEach, expect, it } from 'vitest'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DatabaseSync } from 'node:sqlite'
import type { OperationId } from '../src/l1-types.ts'
import { resolveKnowledgeConfig, resolveL1Config } from '../src/l1-config.ts'
import { knowledgeCandidate, knowledgeFixture, commitKnowledge } from './knowledge-fixtures.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import { header } from './helpers.ts'
import { backfillConsolidationIndex } from '../src/knowledge-store.ts'

const owned: Array<Awaited<ReturnType<typeof knowledgeFixture>>> = []
afterEach(async () => { for (const item of owned.splice(0)) await item.close() })
async function setup() { const item = await knowledgeFixture(); owned.push(item); return item }

async function anotherSource(item: Awaited<ReturnType<typeof knowledgeFixture>>, id: string, goal?: string) {
  const session = header(id)
  await item.provider.appendRaw({ projectId: item.project, header: session, inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
  item.provider.scanTurns(item.project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
  const task = item.provider.l1.claim(item.project, session.id, 'fixture', 1)!
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('Expected source summary')
  item.provider.l1.prepare(item.project, task.operationId, 'fixture', { ...value, summary: { ...value.summary, ...goal === undefined ? {} : { goal } } })
  return item.provider.l1.commitMemory(item.project, task.operationId, 'fixture', 2)!
}

it('bounds indexed relevant comparisons independently of total knowledge count and retains frozen settings', async () => {
  const item = await setup()
  const values = Array.from({ length: 80 }, (_, index) => knowledgeCandidate(item.source, `Parser constraint ${index}`))
  commitKnowledge(item, 'L2', [item.source], values)
  const source = await anotherSource(item, 'independent-source')
  const config = { ...item.config, maxExisting: 7, maxSearchTerms: 12 }
  const operation = item.provider.knowledge.enqueue(item.project, 'L2', [source], config)
  const task = item.provider.knowledge.getTask(item.project, operation)!
  expect(task.input.existing).toHaveLength(7)
  expect(task.input.requiredExisting).toEqual([])
  expect(task.config).toMatchObject({ maxExisting: 7, maxSearchTerms: 12 })
  expect(task.input.lineage.every(record => record.id === item.source.id)).toBe(true)
})

it('fails explicitly when directly related versions exceed the frozen comparison budget', async () => {
  const item = await setup()
  commitKnowledge(item, 'L2', [item.source], Array.from({ length: 4 }, (_, index) => knowledgeCandidate(item.source, `Related fact ${index}`)))
  expect(() => item.provider.knowledge.enqueue(item.project, 'L2', [item.source], { ...item.config, maxExisting: 3 }))
    .toThrow(/Required related knowledge exceeds maxExisting/)
})

it('includes explicit recheck targets even without indexed lexical overlap', async () => {
  const item = await setup()
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Unrelated unique vocabulary')])[0]!
  const source = await anotherSource(item, 'recheck-source')
  const operation = item.provider.knowledge.enqueue(item.project, 'L2', [source], { ...item.config, maxExisting: 1 }, target)
  const task = item.provider.knowledge.claim(item.project, operation, 'recheck', 10)!
  expect(task.input.existing).toMatchObject([target])
  expect(task.input.requiredExisting).toEqual([target])
})

it('rejects a prepared result when any target-level version changes outside the selected set', async () => {
  const item = await setup()
  const other = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Unrelated fact')])[0]!
  const source = await anotherSource(item, 'generation-source')
  const store = item.provider.knowledge
  const operation = store.enqueue(item.project, 'L2', [source], { ...item.config, maxExisting: 1 })
  store.claim(item.project, operation, 'worker', 10)
  store.prepare(item.project, operation, 'worker', [knowledgeCandidate(source, 'Proposed fact')])
  store.invalidateMemory(item.project, other, 'Concurrent withdrawal', 'withdraw-outside-input' as OperationId)
  expect(() => store.commit(item.project, operation, 'worker', 11)).toThrow(/Knowledge revisions changed/)
})

it('validates comparison settings and freezes their defaults', () => {
  expect(resolveKnowledgeConfig({ provider: 'test', model: 'test' })).toMatchObject({ maxExisting: 64, maxSearchTerms: 64 })
  for (const value of [0, -1, 1.5, Infinity, 10001]) {
    expect(() => resolveKnowledgeConfig({ provider: 'test', model: 'test', maxExisting: value })).toThrow()
    expect(() => resolveKnowledgeConfig({ provider: 'test', model: 'test', maxSearchTerms: value })).toThrow()
  }
})

it('finds short Chinese terms through the persistent selection index', async () => {
  const item = await setup()
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '数据库性能诊断')])[0]!
  const source = await anotherSource(item, 'chinese-source', '数据库')
  const operation = item.provider.knowledge.enqueue(item.project, 'L2', [source], item.config)
  expect(item.provider.knowledge.getTask(item.project, operation)!.input.existing).toMatchObject([target])
})

it('resumes selection backfill from its saved page without changing immutable versions', async () => {
  const item = await setup()
  const versions = commitKnowledge(item, 'L2', [item.source], Array.from({ length: 3 }, (_, index) => knowledgeCandidate(item.source, `Backfill ${index}`)))
  await item.provider.close()
  const first = new DatabaseSync(item.spec.databasePath)
  try {
    first.exec("DELETE FROM knowledge_selection_fts; DELETE FROM knowledge_selection_sources; UPDATE knowledge_selection_backfill SET after_id='',after_revision=0,ready=0")
    expect(backfillConsolidationIndex(first, 1)).toEqual({ pending: true })
    expect(first.prepare('SELECT COUNT(*) AS count FROM knowledge_selection_fts').get()?.count).toBe(1)
  } finally { first.close() }
  const resumed = new DatabaseSync(item.spec.databasePath)
  try {
    while (backfillConsolidationIndex(resumed, 1).pending) { /* Each call commits its own page. */ }
    expect(resumed.prepare('SELECT COUNT(*) AS count FROM knowledge_selection_fts').get()?.count).toBe(3)
    expect(resumed.prepare('SELECT id,revision FROM knowledge_versions ORDER BY id').all()).toEqual([...versions].sort((a, b) => a.id.localeCompare(b.id)))
  } finally { resumed.close() }
})

it('removes deleted versions from selector and recheck queues without blocking remaining work', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const parent = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const derived = commitKnowledge(item, 'L3', [parent], [knowledgeCandidate(parent)])[0]!
  store.invalidateMemory(item.project, parent, 'Parent withdrawn', 'deleted-parent' as OperationId)
  store.invalidateMemory(item.project, derived, 'Derived version retired', 'deleted-derived' as OperationId)
  const database = new DatabaseSync(item.spec.databasePath)
  try {
    expect(database.prepare('SELECT 1 FROM knowledge_recheck_pending WHERE id=?').get(derived.id)).toBeDefined()
    database.prepare('DELETE FROM knowledge_versions WHERE id=? AND revision=?').run(derived.id, derived.revision)
    expect(database.prepare('SELECT 1 FROM knowledge_recheck_pending WHERE id=?').get(derived.id)).toBeUndefined()
    expect(database.prepare('SELECT 1 FROM knowledge_selection_sources WHERE id=?').get(derived.id)).toBeUndefined()
    expect(database.prepare('SELECT 1 FROM knowledge_selection_fts WHERE id=?').get(derived.id)).toBeUndefined()
    expect(() => store.enqueueRechecks(item.project, 'L3', item.config)).not.toThrow()
  } finally { database.close() }
})
