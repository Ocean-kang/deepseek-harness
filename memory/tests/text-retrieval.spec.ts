/** Real FTS5 ranking, authorization and version checks without an embedding service. */
import { afterEach, expect, it } from 'vitest'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import { resolveConfig } from '../src/config.ts'
import type { ProjectId } from '../src/types.ts'
import type { OperationId } from '../src/l1-types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(options = {}) {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  const search = new TextMemoryRetriever(item.provider, resolveTextSearchConfig(options))
  cleanup.push(() => search.close())
  return { ...item, search }
}

it('ranks literal text, returns an explicit method and preserves whole-entry budgets', async () => {
  const item = await setup()
  const refs = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM ESM ESM'), knowledgeCandidate(item.source, 'ESM with many unrelated words about potatoes butter milk cooking meals recipes')])
  const result = await item.search.retrieve({ projectId: item.project, text: 'ESM', levels: ['L2'] })
  expect(result.method).toBe('bm25')
  expect(result.hits.map(hit => hit.ref)).toEqual(refs)
  expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score!)
  expect(result.hits.every(hit => hit.similarity === null)).toBe(true)
  expect(result.text).toContain('Historical reference only')
  expect((await item.search.retrieve({ projectId: item.project, text: 'neverpresent' })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: 'ESM', maxBytes: 1 })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: '"ESM" OR (broken*)' })).hits).toHaveLength(2)
  expect((await item.search.retrieve({ projectId: item.project, text: '!?()' })).scanned).toBe(0)
  expect((await item.search.retrieve({ projectId: item.project, text: 'ESM', levels: [] })).hits).toEqual([])
  expect(item.search.getIndexStatus(item.project)).toMatchObject({ method: 'bm25', ready: true, candidates: 3 })
})

it('filters private memories before scoring and removes revoked grants before admission', async () => {
  const item = await setup()
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM private detail')])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2, 'ESM reusable guidance')])[0]!
  const other = 'text-other' as ProjectId
  expect((await item.search.retrieve({ projectId: other, text: 'ESM' })).hits).toEqual([])
  const action = { operationId: 'text-approve' as OperationId, projectId: item.project, ref: l3, action: 'approve' as const,
    userId: 'local', receiptId: 'receipt', occurredAt: 10, expiresAt: 100 }
  item.provider.knowledge.approveShare(action, () => true, 11)
  const result = await item.search.retrieve({ projectId: other, text: 'ESM' })
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0]).toMatchObject({ ref: l3, shared: true })
  expect(result.text).not.toContain('private detail')
  item.provider.knowledge.revokeShare({ ...action, action: 'revoke', operationId: 'text-revoke' as OperationId, receiptId: 'receipt-2' }, () => true, 12)
  expect(item.search.revalidate(other, result).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: other, text: 'ESM' })).hits).toEqual([])
})

it('reads current revisions after updates and database reopen without a persistent index', async () => {
  const item = await setup()
  const old = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'CommonJS')])[0]!
  const oldResult = await item.search.retrieve({ projectId: item.project, text: 'CommonJS' })
  const update = { ...knowledgeCandidate(item.source, 'ESM'), target: old }
  const current = commitKnowledge(item, 'L2', [item.source], [update], 'text-update')[0]!
  expect(item.search.revalidate(item.project, oldResult).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: 'CommonJS' })).hits).toEqual([])
  const reopened = await item.open()
  const search = new TextMemoryRetriever(reopened, resolveTextSearchConfig({}))
  cleanup.push(() => search.close())
  expect((await search.retrieve({ projectId: item.project, text: 'ESM' })).hits[0]!.ref).toEqual(current)
})

it('supports explicitly selected trigram substring search including Chinese text', async () => {
  const item = await setup({ tokenizer: 'trigram' })
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '项目统一使用严格类型检查和模块规范')])
  expect((await item.search.retrieve({ projectId: item.project, text: '严格类型检查', levels: ['L2'] })).hits).toHaveLength(1)
  expect((await item.search.retrieve({ projectId: item.project, text: '类型', levels: ['L2'] })).hits).toEqual([])
})

it('rejects invalid modes and configured budgets, cancels scans and drains on close', async () => {
  const item = await setup({ maxCandidates: 1, limit: 1, pageSize: 1, maxQueryBytes: 12, maxTerms: 2 })
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])
  expect(item.search.getIndexStatus(item.project)).toMatchObject({ ready: false, truncated: true })
  await expect(item.search.retrieve({ projectId: item.project, text: 'ESM' })).rejects.toMatchObject({ code: 'budget' })
  await expect(item.search.retrieve({ projectId: item.project, text: 'abcdefghijklmn' })).rejects.toMatchObject({ code: 'budget' })
  await expect(item.search.retrieve({ projectId: item.project, text: 'a b c' })).rejects.toMatchObject({ code: 'budget' })
  await expect(item.search.retrieve({ projectId: item.project, text: 'ESM', limit: 0 })).rejects.toMatchObject({ code: 'config' })
  const reason = new Error('cancel text search')
  await expect(item.search.retrieve({ projectId: item.project, text: 'ESM', signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  const work = item.search.retrieve({ projectId: item.project, text: 'ESM' }).catch(error => error)
  await item.search.close()
  expect(await work).toBeInstanceOf(Error)
  await expect(item.search.retrieve({ projectId: item.project, text: 'ESM' })).rejects.toMatchObject({ code: 'closed' })
  await expect(resolveConfig({ projectId: 'a', databasePath: 'data/text.sqlite', textSearch: {}, embedding: {
    endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2, apiKeyEnv: 'TEST_KEY',
  } })).rejects.toMatchObject({ code: 'config' })
  for (const config of [{ limit: 0 }, { maxCandidates: 1, limit: 2 }, { maxTerms: Infinity }, { timeoutMs: -1 }]) expect(() => resolveTextSearchConfig(config)).toThrow()
})
