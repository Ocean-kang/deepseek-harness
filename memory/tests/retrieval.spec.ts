/** Real SQLite authorization, indexing recovery and bounded retrieval. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { resolveEmbeddingConfig } from '../src/embedding.ts'
import type { Embedder, EmbeddingConfig } from '../src/embedding.ts'
import { MemoryRetriever, renderRecall } from '../src/retrieval.ts'
import type { OperationId } from '../src/l1-types.ts'
import type { ProjectId } from '../src/types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'
import { turnEvents, candidate } from './l1-fixtures.ts'
import { resolveL1Config } from '../src/l1-config.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const fake: Embedder = { embed: async texts => ({ vectors: texts.map(text => text === 'unrelated' ? [0, 1] : [1, 0]), tokens: null }) }
async function setup(overrides: Partial<EmbeddingConfig> = {}, embedder = fake) {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  const spec = resolveEmbeddingConfig({ endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2, apiKeyEnv: 'TEST_KEY', ...overrides })
  const errors: string[] = []
  const retriever = new MemoryRetriever(item.provider, spec, embedder, error => errors.push(error.code))
  cleanup.push(() => retriever.close())
  return { ...item, retriever, embedding: spec, errors }
}

it('reports missing vectors, persists them and returns bounded stable authorized results', async () => {
  const item = await setup()
  const refs = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source), knowledgeCandidate(item.source, 'Use ESM')])
  await item.retriever.flush()
  expect(item.retriever.getIndexStatus(item.project)).toMatchObject({ ready: true, candidates: 3, missing: 0 })
  const result = await item.retriever.retrieve({ projectId: item.project, text: 'typescript' })
  expect(result.hits.map(hit => hit.ref.id)).toEqual([item.source.id, ...refs.map(ref => ref.id)].sort())
  expect(result.text).toBe(renderRecall(result.hits))
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192)
  expect((await item.retriever.retrieve({ projectId: item.project, text: 'unrelated' })).hits).toEqual([])
  expect((await item.retriever.retrieve({ projectId: 'other' as ProjectId, text: 'typescript' })).hits).toEqual([])
  expect((await item.retriever.retrieve({ projectId: item.project, text: 'typescript', maxBytes: 1 })).hits).toEqual([])
  const [owned, privateProject] = await Promise.all([
    item.retriever.retrieve({ projectId: item.project, text: 'typescript' }),
    item.retriever.retrieve({ projectId: 'private-other' as ProjectId, text: 'typescript' }),
  ])
  expect(owned.hits).toHaveLength(3)
  expect(privateProject.hits).toEqual([])
  const reopened = await item.open()
  expect(reopened.vectors.read(item.embedding, [...reopened.vectors.documents(item.project, 2)][0]!)).toEqual([1, 0])
})

it('rejects incomplete or over-capacity scans and never mixes vector spaces', async () => {
  const item = await setup({ maxCandidates: 1, limit: 1 })
  expect(item.retriever.getIndexStatus(item.project).ready).toBe(false)
  await expect(item.retriever.retrieve({ projectId: item.project, text: 'x' })).rejects.toMatchObject({ code: 'index-not-ready' })
  await item.retriever.flush()
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])
  await item.retriever.flush()
  await expect(item.retriever.retrieve({ projectId: item.project, text: 'x' })).rejects.toMatchObject({ code: 'budget' })
  const next = { ...item.embedding, ...resolveEmbeddingConfig({ ...item.embedding, model: 'different' }) }
  expect(item.provider.vectors.read(next, [...item.provider.vectors.documents(item.project, 2)][0]!)).toBeNull()
  expect(item.retriever.getIndexStatus(item.project)).toMatchObject({ ready: false, truncated: true })
})

it('removes replaced and revoked versions before admission', async () => {
  const item = await setup()
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2)])[0]!
  const action = { operationId: 'approve' as OperationId, projectId: item.project, ref: l3, action: 'approve' as const, userId: 'local', receiptId: 'receipt', occurredAt: 10, expiresAt: 100 }
  item.provider.knowledge.approveShare(action, () => true, 11)
  await item.retriever.flush()
  const other = 'other' as ProjectId
  const result = await item.retriever.retrieve({ projectId: other, text: 'typescript' })
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0]).toMatchObject({ ref: l3, shared: true })
  expect(result.text).not.toContain(item.source.id)
  item.provider.knowledge.revokeShare({ ...action, action: 'revoke', operationId: 'revoke' as OperationId, receiptId: 'receipt-2' }, () => true, 12)
  expect(item.retriever.revalidate(other, result).hits).toEqual([])
  const old = await item.retriever.retrieve({ projectId: item.project, text: 'typescript', levels: ['L2'] })
  const newer = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'Use another compiler'), target: l2 }], 'new')[0]!
  expect(item.retriever.revalidate(item.project, old).hits).toEqual([])
  await item.retriever.flush()
  expect((await item.retriever.retrieve({ projectId: item.project, text: 'x', levels: ['L2'] })).hits[0]?.ref).toEqual(newer)
})

it('discards a retired in-flight vector and waits for cancellation on unload', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const item = await setup({}, { embed: async (texts, signal) => {
    if (hold) { entered.resolve(); await release.promise; signal.throwIfAborted() }
    return fake.embed(texts, signal)
  } })
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  await item.retriever.flush()
  hold = true
  const rebuilding = item.retriever.rebuildIndex()
  try {
    await entered.promise
    item.provider.knowledge.invalidateMemory(item.project, l2, 'obsolete', 'invalidate' as OperationId)
    let closed = false
    const closing = item.retriever.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    await closing
    await rebuilding
    const db = new DatabaseSync(item.spec.databasePath)
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(0) } finally { db.close() }
  } finally { release.resolve(); await rebuilding }
})

it('atomically rejects an invalid vector batch and recovers a failed index', async () => {
  let invalid = true
  const item = await setup({}, { embed: async texts => ({ vectors: texts.map(() => invalid ? [0, 0] : [1, 0]), tokens: 0 }) })
  item.retriever.schedule()
  await item.retriever.flush()
  expect(item.errors).toEqual(['output'])
  expect(item.retriever.getIndexStatus(item.project)).toMatchObject({ ready: false, status: 'failed' })
  invalid = false
  await item.retriever.rebuildIndex()
  expect(item.retriever.getIndexStatus(item.project).ready).toBe(true)
  const documents = [...item.provider.vectors.documents(item.project, 10)]
  item.provider.vectors.clear(item.embedding)
  expect(() => item.provider.vectors.put(item.embedding, item.project, documents, [[NaN, 1]])).toThrow()
  expect(item.provider.vectors.read(item.embedding, documents[0]!)).toBeNull()
})

it('migrates schema 3 transactionally without altering source memories', async () => {
  const item = await setup()
  await item.retriever.close()
  await item.provider.close()
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.exec(`DROP TRIGGER memory_l1_insert; DROP TRIGGER memory_knowledge_insert; DROP TRIGGER memory_knowledge_update;
      DROP TRIGGER memory_grant_insert; DROP TRIGGER memory_grant_delete; DROP INDEX memory_knowledge_candidates;
      DROP TABLE memory_vectors; DROP TABLE memory_index_state; DROP TABLE memory_generation; PRAGMA user_version = 3;
      CREATE TABLE memory_index_state (wrong TEXT)`)
    await expect(item.open()).rejects.toThrow()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get()).toBeUndefined()
    db.exec('DROP TABLE memory_index_state')
    const migrated = await item.open()
    expect(migrated.l1.getMemory(item.project, item.source)).toEqual(item.source)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
  } finally { db.close() }
})

it('rolls back a failed batch write without leaving a partial index', async () => {
  const item = await setup()
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])
  await item.retriever.flush()
  const documents = [...item.provider.vectors.documents(item.project, 10)]
  item.provider.vectors.clear(item.embedding)
  const db = new DatabaseSync(item.spec.databasePath)
  try {
    db.exec("CREATE TRIGGER fail_vectors BEFORE INSERT ON memory_vectors WHEN (SELECT COUNT(*) FROM memory_vectors) > 0 BEGIN SELECT RAISE(ABORT, 'write failure'); END")
    expect(() => item.provider.vectors.put(item.embedding, item.project, documents, documents.map(() => [1, 0]))).toThrow('write failure')
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(0)
  } finally { db.close() }
})

it('rejects a query whose permissions changed while embedding was in flight', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const item = await setup({}, { embed: async (texts, signal) => {
    if (hold) { started.resolve(); await release.promise }
    return fake.embed(texts, signal)
  } })
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  await item.retriever.flush()
  hold = true
  const result = item.retriever.retrieve({ projectId: item.project, text: 'x' })
  const rejected = expect(result).rejects.toMatchObject({ code: 'conflict' })
  try {
    await started.promise
    item.provider.knowledge.invalidateMemory(item.project, ref, 'obsolete', 'invalidate-query' as OperationId)
  } finally { release.resolve() }
  await rejected
})

it('skips an oversized higher-ranked entry and budgets complete Unicode text', async () => {
  const item = await setup({}, { embed: async texts => ({ vectors: texts.map(text => text.includes('small-marker') ? [0.99, 0.1] : [1, 0]), tokens: null }) })
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'large-marker'.repeat(1000)), knowledgeCandidate(item.source, 'small-marker 中文😀')])
  await item.retriever.flush()
  const result = await item.retriever.retrieve({ projectId: item.project, text: 'x', levels: ['L2'], maxBytes: 512 })
  expect(result.hits).toHaveLength(1)
  expect(result.text).toContain('small-marker 中文😀')
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512)
  expect((await item.retriever.retrieve({ projectId: item.project, text: '   ' })).hits).toEqual([])
})

it('enforces the online deadline and drains an in-flight query on close', async () => {
  let hold = false
  const entered = Promise.withResolvers<void>()
  const item = await setup({ retrievalTimeoutMs: 50 }, { embed: async (texts, signal) => {
    if (hold) {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return fake.embed(texts, signal)
  } })
  item.retriever.schedule()
  await item.retriever.flush()
  hold = true
  await expect(item.retriever.retrieve({ projectId: item.project, text: 'deadline' })).rejects.toMatchObject({ code: 'timeout' })
  const pending = item.retriever.retrieve({ projectId: item.project, text: 'close' })
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  await item.retriever.close()
  await rejected
})

it('does not invalidate an authorized query when another project commits private memory', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const item = await setup({}, { embed: async (texts, signal) => {
    if (texts[0] === 'concurrent-query') { entered.resolve(); await release.promise }
    return fake.embed(texts, signal)
  } })
  item.retriever.schedule()
  await item.retriever.flush()
  const pending = item.retriever.retrieve({ projectId: item.project, text: 'concurrent-query' })
  try {
    await entered.promise
    const project = 'another-project' as ProjectId
    const source = header('other-source')
    await item.provider.appendRaw({ projectId: project, header: source, inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
    item.provider.scanTurns(project, resolveL1Config({ provider: 'fixture', model: 'fixture' }), 10)
    const task = item.provider.l1.claim(project, source.id, 'fixture', 1)!
    item.provider.l1.prepare(project, task.operationId, 'fixture', candidate(task))
    item.provider.l1.commitMemory(project, task.operationId, 'fixture', 2)
  } finally { release.resolve() }
  expect((await pending).hits.map(hit => hit.projectId)).toEqual([item.project])
})

it('bounds parallel index batches and discards a version retired during embedding', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  const item = await setup({ batchSize: 1, concurrency: 2 }, { embed: async (texts, signal) => {
    active++
    peak = Math.max(peak, active)
    if (active === 2) entered.resolve()
    try { await release.promise; return await fake.embed(texts, signal) } finally { active-- }
  } })
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  try {
    await entered.promise
    item.provider.knowledge.invalidateMemory(item.project, ref, 'retired in flight', 'retire-inflight' as OperationId)
  } finally { release.resolve() }
  await item.retriever.flush()
  expect(peak).toBe(2)
  expect(item.retriever.getIndexStatus(item.project)).toMatchObject({ ready: true, candidates: 1 })
  const db = new DatabaseSync(item.spec.databasePath)
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE id = ?').get(ref.id)?.n).toBe(0) } finally { db.close() }
})
