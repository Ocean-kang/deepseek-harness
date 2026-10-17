/** Derived index recovery preserves immutable memories and exact snapshot identities. */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { TextIndex } from '../src/text-index.ts'
import { resolveTextSearchConfig } from '../src/text-retrieval.ts'
import type { OperationId } from '../src/l1-types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function setup() {
  const item = await knowledgeFixture()
  cleanups.push(() => item.close())
  const database = new DatabaseSync(item.spec.databasePath)
  database.exec('PRAGMA foreign_keys=ON')
  cleanups.push(async () => { database.close() })
  return { ...item, database, index: new TextIndex(database, item.provider.knowledge, 1), textSpec: resolveTextSearchConfig({}) }
}

it('rebuilds a missing persistent FTS table and issues a new snapshot identity', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Recoverable ESM reference')])[0]!
  const request = { projectId: item.project, text: 'ESM', levels: ['L2'] as const }
  const before = await item.index.snapshot(item.textSpec, request)
  const key = before.split(':')[0]!
  item.database.exec(`DROP TABLE memory_fts_${key}`)
  const result = await item.index.query(item.textSpec, request, ['ESM'])
  expect(result.result.hits.map(hit => hit.ref)).toEqual([ref])
  expect(result.fingerprint).not.toBe(before)
  expect(item.provider.knowledge.getMemory(item.project, ref)).toMatchObject(ref)
})

it.each(['eviction', 'reset'])('rolls back FTS table deletion together with failed corpus metadata %s', async operation => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Atomic ESM reference')])[0]!
  const request = { projectId: item.project, text: 'ESM', levels: ['L2'] as const }
  const before = await item.index.snapshot(item.textSpec, request)
  const key = before.split(':')[0]!
  item.database.exec("CREATE TRIGGER deny_corpus_delete BEFORE DELETE ON memory_text_corpora BEGIN SELECT RAISE(ABORT,'Fixture metadata failure'); END")
  try {
    if (operation === 'eviction') await expect(item.index.snapshot(item.textSpec, { ...request, levels: ['L3'] })).rejects.toThrow('Fixture metadata failure')
    else expect(() => item.index.reset()).toThrow('Fixture metadata failure')
  } finally { item.database.exec('DROP TRIGGER deny_corpus_delete') }
  expect(item.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`memory_fts_${key}`)).toBeDefined()
  const result = await item.index.query(item.textSpec, request, ['ESM'])
  expect(result.result.hits.map(hit => hit.ref)).toEqual([ref])
  expect(result.fingerprint).toBe(before)
})

it('changes snapshot identities across a rebuild with the same document count', async () => {
  const item = await setup()
  const original = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Original ESM reference')])[0]!
  const request = { projectId: item.project, text: 'ESM', levels: ['L2'] as const }
  const before = await item.index.snapshot(item.textSpec, request)
  item.provider.knowledge.invalidateMemory(item.project, original, 'Reference replaced', 'replace-index-reference' as OperationId)
  const next = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Replacement ESM reference')], 'replacement')[0]!
  item.index.reset()
  const result = await item.index.query(item.textSpec, request, ['ESM'])
  expect(result.candidates).toBe(1)
  expect(result.result.hits.map(hit => hit.ref)).toEqual([next])
  expect(result.fingerprint).not.toBe(before)
})
