/** Real FTS5 ranking, authorization and version checks without an embedding service. */
import { afterEach, expect, it, vi } from 'vitest'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import type { TextSearchConfig } from '../src/text-retrieval.ts'
import type { RetrievalRequest } from '../src/retrieval.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { queryExpander } from '../src/query-expansion.ts'
import { resolveConfig } from '../src/config.ts'
import type { ProjectId } from '../src/types.ts'
import { MemoryError } from '../src/types.ts'
import type { OperationId } from '../src/l1-types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import { header } from './helpers.ts'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(options: TextSearchConfig = {}, expand?: (request: RetrievalRequest, signal: AbortSignal) => Promise<string>) {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  const search = new TextMemoryRetriever(item.provider, resolveTextSearchConfig(options), expand)
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

it.each([false, true])('checks the authorized corpus after a concurrent private commit to same project=%s', async (sameProject) => {
  const item = await setup({ pageSize: 1 })
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])[0]!
  const project = sameProject ? item.project : 'private-other-project' as ProjectId
  const sourceHeader = header('concurrent-private')
  await item.provider.appendRaw({ projectId: project, header: sourceHeader,
    inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
  item.provider.scanTurns(project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
  const task = item.provider.l1.claim(project, sourceHeader.id, 'fixture', 1)!
  item.provider.l1.prepare(project, task.operationId, 'fixture', candidate(task))
  const query = item.search.retrieve({ projectId: item.project, text: 'ESM' })
  const outcome = query.then(result => ({ result }), (error: unknown) => ({ error }))
  item.provider.l1.commitMemory(project, task.operationId, 'fixture', 2)
  if (sameProject) expect(await outcome).toMatchObject({ error: { code: 'conflict' } })
  else expect(await outcome).toMatchObject({ result: { hits: [{ ref }] } })
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

it.each(['approve', 'revoke'] as const)('rejects a shared corpus change during scanning: %s', async (change) => {
  const item = await setup({ pageSize: 1 })
  const parent = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const refs = [...commitKnowledge(item, 'L3', [parent], [knowledgeCandidate(parent, 'ESM first'), knowledgeCandidate(parent, 'ESM second')])]
    .sort((a, b) => b.id.localeCompare(a.id))
  const reader = 'shared-reader' as ProjectId
  const action = { operationId: 'shared-before-query' as OperationId, projectId: item.project, ref: refs[0]!, action: 'approve' as const,
    userId: 'local', receiptId: 'before-query', occurredAt: 10, expiresAt: 100 }
  item.provider.knowledge.approveShare(action, () => true, 11)
  const outcome = item.search.retrieve({ projectId: reader, text: 'ESM' }).catch((error: unknown) => error)
  if (change === 'approve') item.provider.knowledge.approveShare({ ...action, ref: refs[1]!, operationId: 'shared-added' as OperationId, receiptId: 'added' }, () => true, 12)
  else item.provider.knowledge.revokeShare({ ...action, action: 'revoke', operationId: 'shared-removed' as OperationId, receiptId: 'removed' }, () => true, 12)
  expect(await outcome).toMatchObject({ code: 'conflict' })
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
  expect((await item.search.retrieve({ projectId: item.project, text: '请帮我完成严格类型检查', levels: ['L2'] })).hits).toHaveLength(1)
  expect((await item.search.retrieve({ projectId: item.project, text: '类型', levels: ['L2'] })).hits).toHaveLength(1)
  expect((await item.search.retrieve({ projectId: item.project, text: '规', levels: ['L2'] })).hits).toHaveLength(1)
  expect((await item.search.retrieve({ projectId: item.project, text: '静态分析政策', levels: ['L2'] })).hits).toEqual([])
})

it('uses literal authorized short-term matches after BM25 hits without fabricating a relevance score', async () => {
  const item = await setup({ tokenizer: 'trigram' })
  const shortRef = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '类型 I/O guidance')])[0]!
  const rankedRef = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM guidance')], 'short-ranked')[0]!
  const result = await item.search.retrieve({ projectId: item.project, text: 'ESM 类型', levels: ['L2'] })
  expect(result.hits.map(hit => hit.ref)).toEqual([rankedRef, shortRef])
  expect(result.hits[0]!.score).toBeGreaterThan(0)
  expect(result.hits[1]!.score).toBeUndefined()
  expect((await item.search.retrieve({ projectId: item.project, text: 'io', levels: ['L2'] })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: 'i', levels: ['L2'] })).hits.some(hit => hit.ref.id === shortRef.id)).toBe(true)
  expect((await item.search.retrieve({ projectId: 'short-foreign' as ProjectId, text: '类型' })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: '类型', maxBytes: 1 })).hits).toEqual([])
  item.provider.knowledge.invalidateMemory(item.project, shortRef, 'Withdrawn', 'short-invalidated' as OperationId)
  expect((await item.search.retrieve({ projectId: item.project, text: '类型' })).hits).toEqual([])
})

it('expands one empty text query through the configured adapter and searches the authorized corpus once more', async () => {
  const requests: string[] = []
  const item = await setup({ expandQuery: true }, async request => { requests.push(request.text); return 'ESM' })
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM guidance')])[0]!
  const result = await item.search.retrieve({ projectId: item.project, text: 'module conventions' })
  expect(result.hits.map(hit => hit.ref)).toEqual([ref])
  expect(requests).toEqual(['module conventions'])
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  await item.search.retrieve({ projectId: item.project, text: 'ESM' })
  await item.search.retrieve({ projectId: 'empty-expansion-project' as ProjectId, text: 'module conventions' })
  expect(requests).toHaveLength(1)

  let misses = 0
  const failing = await setup({ expandQuery: true }, async () => { misses++; return 'alsoabsent' })
  commitKnowledge(failing, 'L2', [failing.source], [knowledgeCandidate(failing.source, 'ESM')])
  expect((await failing.search.retrieve({ projectId: failing.project, text: 'absent' })).hits).toEqual([])
  expect(misses).toBe(1)
})

it('does not expand BM25 or literal short-term matches excluded only by the recall byte budget', async () => {
  const expand = vi.fn(async () => 'different')
  const item = await setup({ tokenizer: 'trigram', expandQuery: true }, expand)
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM 类型指导')])
  expect((await item.search.retrieve({ projectId: item.project, text: 'ESM', maxBytes: 1 })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: '类型', maxBytes: 1 })).hits).toEqual([])
  expect(expand).not.toHaveBeenCalled()
})

it('validates expanded term limits before building a second corpus', async () => {
  const item = await setup({ expandQuery: true, maxTerms: 2 }, async () => 'ESM second third')
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])
  const documents = vi.spyOn(item.provider.vectors, 'documents')
  await expect(item.search.retrieve({ projectId: item.project, text: 'absent' })).rejects.toMatchObject({ code: 'budget' })
  expect(documents).toHaveBeenCalledTimes(1)
})

it('rejects oversized initial queries before expansion and skips empty or wholly private authorized corpora', async () => {
  const expand = vi.fn(async () => 'ESM')
  const item = await setup({ expandQuery: true, maxQueryBytes: 10, maxTerms: 1 }, expand)
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])
  const documents = vi.spyOn(item.provider.vectors, 'documents')
  await expect(item.search.retrieve({ projectId: item.project, text: 'elevenbyteslong' })).rejects.toMatchObject({ code: 'budget' })
  await expect(item.search.retrieve({ projectId: item.project, text: 'two words' })).rejects.toMatchObject({ code: 'budget' })
  expect(documents).not.toHaveBeenCalled()
  expect((await item.search.retrieve({ projectId: item.project, text: 'absent', levels: ['L3'] })).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: 'private-corpus-reader' as ProjectId, text: 'absent' })).hits).toEqual([])
  expect(expand).not.toHaveBeenCalled()
})

it('validates expanded query budgets and drains an in-flight expansion before closing', async () => {
  const oversized = await setup({ expandQuery: true, maxQueryBytes: 12 }, async () => 'expandedquerytoolong')
  commitKnowledge(oversized, 'L2', [oversized.source], [knowledgeCandidate(oversized.source, 'ESM')])
  await expect(oversized.search.retrieve({ projectId: oversized.project, text: 'absent' })).rejects.toMatchObject({ code: 'budget' })
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let stopped = false
  const item = await setup({ expandQuery: true }, async (_request, signal) => {
    started()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(signal.reason) }, { once: true }))
    return 'ESM'
  })
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])
  const work = item.search.retrieve({ projectId: item.project, text: 'absent' }).catch((error: unknown) => error)
  await entered
  await item.search.close()
  expect(stopped).toBe(true)
  expect(await work).toBeInstanceOf(Error)
  expect(() => resolveTextSearchConfig({ expansionTimeoutMs: 0 })).toThrow()
  expect(() => new TextMemoryRetriever(item.provider, resolveTextSearchConfig({ expandQuery: true }))).toThrow(MemoryError)
})

it('waits for model teardown and durable expansion settlement before close completes', async () => {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  const spec = resolveTextSearchConfig({ expandQuery: true })
  let modelStarted!: () => void
  let modelStopping!: () => void
  let releaseModel!: () => void
  let resultStarted!: () => void
  let releaseResult!: () => void
  const entered = new Promise<void>(resolve => { modelStarted = resolve })
  const stopping = new Promise<void>(resolve => { modelStopping = resolve })
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
  const resultEntered = new Promise<void>(resolve => { resultStarted = resolve })
  const resultGate = new Promise<void>(resolve => { releaseResult = resolve })
  let modelSettled = false
  let resultSettled = false
  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('Expansion did not receive cancellation')
    modelStarted()
    try {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } finally {
      modelStopping()
      await modelGate
      modelSettled = true
    }
  }
  const search = new TextMemoryRetriever(item.provider, spec,
    queryExpander(item.provider, { stream }, resolveL1Config({ provider: 'test', model: 'test' }), spec))
  cleanup.push(() => search.close())
  commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM')])
  const append = item.provider.appendRaw.bind(item.provider)
  const writes = vi.spyOn(item.provider, 'appendRaw').mockImplementation(async request => {
    if (request.events[0]?.type !== 'memory/extraction-result') return append(request)
    resultStarted()
    await resultGate
    const written = await append(request)
    resultSettled = true
    return written
  })
  try {
    const work = search.retrieve({ projectId: item.project, text: 'nonmatchingterm' }).catch((error: unknown) => error)
    await entered
    let closed = false
    const closing = search.close().then(() => { closed = true })
    await stopping
    expect(closed).toBe(false)
    releaseModel()
    await resultEntered
    expect(modelSettled).toBe(true)
    expect(closed).toBe(false)
    releaseResult()
    await closing
    expect(resultSettled).toBe(true)
    expect(await work).toBeInstanceOf(Error)
    const auxiliary = item.provider.listSessions(item.project).find(session => session.header.id.startsWith('memory-request-'))!
    expect(auxiliary.committedTo).toBe(2)
    const stored = await item.provider.readRaw({ projectId: item.project, sessionId: auxiliary.header.id,
      from: SessionLogOffset(0), to: auxiliary.committedTo, limit: 2 })
    expect(stored.events[1]).toMatchObject({ type: 'memory/extraction-result', data: { outcome: 'cancelled' } })
  } finally { releaseModel(); releaseResult(); await search.close(); writes.mockRestore() }
})

it('removes derived text hits when their exact source becomes obsolete', async () => {
  const item = await setup()
  const l2 = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM source')])[0]!
  const l3 = commitKnowledge(item, 'L3', [l2], [knowledgeCandidate(l2, 'ESM stable principle')])[0]!
  const before = await item.search.retrieve({ projectId: item.project, text: 'ESM', levels: ['L3'] })
  expect(before.hits.map(hit => hit.ref)).toEqual([l3])
  item.provider.knowledge.invalidateMemory(item.project, l2, 'Withdrawn', 'text-parent-invalidated' as OperationId)
  expect(item.search.revalidate(item.project, before).hits).toEqual([])
  expect((await item.search.retrieve({ projectId: item.project, text: 'ESM', levels: ['L3'] })).hits).toEqual([])
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
  } })).resolves.toMatchObject({ hybrid: { rrfK: 60 } })
  for (const config of [{ limit: 0 }, { maxCandidates: 1, limit: 2 }, { maxTerms: Infinity }, { timeoutMs: -1 }]) expect(() => resolveTextSearchConfig(config)).toThrow()
})
