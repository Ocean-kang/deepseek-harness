/** Explicit SQLite FTS5/BM25 retrieval over a bounded, authorized in-memory corpus. */
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as yieldHost } from 'node:timers/promises'
import type { SqliteMemory } from './sqlite.ts'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import type { RetrievalHit, RetrievalRequest, RetrievalResult } from './retrieval.ts'
import { renderRecall } from './retrieval.ts'
import type { VectorDocument } from './vector-store.ts'
import { vectorDocument } from './vector-store.ts'

/** Text search is selected explicitly and never replaces a failing vector query. */
export interface TextSearchConfig {
  tokenizer?: 'unicode61' | 'trigram'
  limit?: number
  maxBytes?: number
  maxCandidates?: number
  pageSize?: number
  timeoutMs?: number
  maxQueryBytes?: number
  maxTerms?: number
}
/** Complete text-search settings, resolved before execution. */
export type TextSearchSpec = Readonly<Required<TextSearchConfig>>

/** @param input - deployment choices.
 * @returns validated immutable values; no credentials or vector model are required.
 */
export function resolveTextSearchConfig(input: TextSearchConfig): TextSearchSpec {
  const numbers = { limit: input.limit ?? 5, maxBytes: input.maxBytes ?? 8192, maxCandidates: input.maxCandidates ?? 10000,
    pageSize: input.pageSize ?? 128, timeoutMs: input.timeoutMs ?? 5000, maxQueryBytes: input.maxQueryBytes ?? 8192, maxTerms: input.maxTerms ?? 64 }
  for (const [key, value] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new MemoryError('config', `text search ${key} must be a positive bounded integer`)
  }
  const tokenizer = input.tokenizer ?? 'unicode61'
  if (!['unicode61', 'trigram'].includes(tokenizer) || numbers.limit > numbers.maxCandidates) throw new MemoryError('config', 'invalid text search tokenizer or count')
  return Object.freeze({ ...numbers, tokenizer })
}

/** Rebuilds a transient corpus per query, so stale versions and foreign IDF statistics cannot affect ranking. */
export class TextMemoryRetriever {
  private closed = false
  private readonly abort = new AbortController()
  private readonly queries = new Set<Promise<RetrievalResult>>()
  /** @param provider - caller-owned open database.
   * @param spec - resolved search settings.
   */
  constructor(private readonly provider: SqliteMemory, readonly spec: TextSearchSpec) {}

  private assertOpen(): void { if (this.closed) throw new MemoryError('closed', 'text memory retriever is closed') }

  /** Queries build their own authorized corpus; no background index is retained. */
  schedule(): void { this.assertOpen() }
  /** @returns immediate settlement; there is no background index work. */
  async flush(): Promise<void> { this.assertOpen() }
  /** No stored text index exists to rebuild. */
  async rebuildIndex(): Promise<void> { this.assertOpen() }

  /** @param project - requester.
   * @returns current authorized candidate count and whether it fits the configured scan limit.
   */
  getIndexStatus(project: ProjectId) {
    this.assertOpen()
    let candidates = 0
    for (const _document of this.provider.vectors.documents(project, this.spec.pageSize)) {
      if (candidates === this.spec.maxCandidates) return { method: 'bm25' as const, candidates, truncated: true, ready: false }
      candidates++
    }
    return { method: 'bm25' as const, candidates, truncated: false, ready: true }
  }

  /** @param request - natural-language query; FTS operators are treated as ordinary words.
   * @returns BM25-ranked historical references; similarity is null because no vector comparison occurs.
   */
  retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const work = this.query(request)
    this.queries.add(work)
    void work.then(() => this.queries.delete(work), () => this.queries.delete(work))
    return work
  }

  private async query(request: RetrievalRequest): Promise<RetrievalResult> {
    this.assertOpen()
    const start = performance.now()
    const signal = AbortSignal.any([this.abort.signal, ...request.signal === undefined ? [] : [request.signal]])
    const check = () => {
      signal.throwIfAborted()
      if (performance.now() - start >= this.spec.timeoutMs) throw new MemoryError('timeout', 'text memory retrieval timed out')
    }
    check()
    const limit = request.limit ?? this.spec.limit
    const maxBytes = request.maxBytes ?? this.spec.maxBytes
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.spec.maxCandidates || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MemoryError('config', 'invalid retrieval count or byte budget')
    if (Buffer.byteLength(request.text, 'utf8') > this.spec.maxQueryBytes) throw new MemoryError('budget', 'text query exceeds configured byte limit')
    const terms = [...new Set(request.text.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [])]
    if (terms.length > this.spec.maxTerms) throw new MemoryError('budget', 'text query exceeds configured term limit')
    const result = (hits: RetrievalHit[], scanned: number): RetrievalResult => ({ method: 'bm25', hits, text: renderRecall(hits), scanned, elapsedMs: performance.now() - start })
    if (!terms.length || request.levels?.length === 0) return result([], 0)
    const corpus = new DatabaseSync(':memory:')
    try {
      corpus.exec(`CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='${this.spec.tokenizer}')`)
      const insert = corpus.prepare('INSERT INTO docs(rowid,body) VALUES (?,?)')
      const documents: VectorDocument[] = []
      const generation = this.provider.vectors.generation()
      // ponytail: a per-query corpus avoids persistent index migrations; scans are explicitly capped.
      for (const document of this.provider.vectors.documents(request.projectId, this.spec.pageSize)) {
        check()
        if (request.levels !== undefined && !request.levels.includes(document.memory.level)) continue
        if (documents.length === this.spec.maxCandidates) throw new MemoryError('budget', 'memory candidate scan exceeds configured limit')
        documents.push(document)
        insert.run(documents.length, document.text)
        if (documents.length % this.spec.pageSize === 0) await yieldHost()
      }
      check()
      const match = terms.map(term => `"${term}"`).join(' OR ')
      const rows = corpus.prepare('SELECT rowid,bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank,rowid').all(match)
      const ranked = rows.map(row => ({ document: documents[Number(row.rowid) - 1]!, score: -Number(row.rank) }))
        .sort((a, b) => b.score - a.score || (a.document.memory.id < b.document.memory.id ? -1 : a.document.memory.id > b.document.memory.id ? 1 : 0))
      const hits: RetrievalHit[] = []
      for (const { document, score } of ranked) {
        check()
        if (!this.provider.vectors.current(request.projectId, document)) continue
        const memory = document.memory
        const hit: RetrievalHit = { ref: { id: memory.id, revision: memory.revision }, projectId: memory.projectId,
          shared: 'shared' in memory, text: document.text, similarity: null, score }
        if (Buffer.byteLength(renderRecall([...hits, hit]), 'utf8') > maxBytes) continue
        hits.push(hit)
        if (hits.length === limit) break
      }
      if (this.provider.vectors.generation() !== generation) throw new MemoryError('conflict', 'memory changed during text retrieval')
      check()
      return result(hits, documents.length)
    } finally { corpus.close() }
  }

  /** @param project - requester.
   * @param result - earlier exact response.
   * @returns original response with replaced, invalidated or revoked references removed.
   */
  revalidate(project: ProjectId, result: RetrievalResult): RetrievalResult {
    this.assertOpen()
    const hits = result.hits.filter(hit => {
      const memory = this.provider.knowledge.getMemory(project, hit.ref)
      if (memory === null) return false
      const document = vectorDocument(memory)
      return this.provider.vectors.current(project, document) && document.text === hit.text
    })
    return { ...result, hits, text: renderRecall(hits) }
  }

  /** Cancel queries and release their transient databases before the parent closes SQLite. */
  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await Promise.allSettled(this.queries)
  }
}
