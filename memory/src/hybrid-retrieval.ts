/** BM25 and optional vectors share authorization; reciprocal ranks combine their different score scales. */
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import type { MemoryRetriever, RetrievalHit, RetrievalRequest, RetrievalResult } from './retrieval.ts'
import { renderRecall } from './retrieval.ts'
import type { TextMemoryRetriever } from './text-retrieval.ts'

/** Deployment choices for fusion and the final context budget. */
export interface HybridConfig { rrfK?: number; candidateLimit?: number; limit?: number; maxBytes?: number }
/** Resolved fusion settings; candidateLimit applies independently to each search. */
export type HybridSpec = Readonly<Required<HybridConfig>>

/** Resolve bounded fusion settings before opening a retriever.
 * @param input - optional deployment values.
 * @returns complete validated fusion and final-result budgets.
 */
export function resolveHybridConfig(input: HybridConfig): HybridSpec {
  const spec = { rrfK: input.rrfK ?? 60, candidateLimit: input.candidateLimit ?? 20, limit: input.limit ?? 5, maxBytes: input.maxBytes ?? 8192 }
  if (Object.values(spec).some(value => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    || spec.limit > spec.candidateLimit) throw new MemoryError('config', 'Invalid hybrid search budgets')
  return Object.freeze(spec)
}

/** Owns both search lifetimes; a failed vector query rejects instead of silently changing retrieval mode. */
export class HybridMemoryRetriever {
  /** @param text - owned BM25 retriever.
   * @param vector - owned vector retriever over the same database.
   * @param spec - resolved fusion and final-result budgets.
   */
  constructor(private readonly text: TextMemoryRetriever, private readonly vector: MemoryRetriever, readonly spec: HybridSpec) {
    if (spec.candidateLimit > Math.min(text.spec.maxCandidates, vector.spec.maxCandidates)) throw new MemoryError('config', 'Hybrid pool exceeds a retriever scan limit')
  }

  /** Schedule the vector index; BM25 queries construct their own corpus. */
  schedule(): void { this.vector.schedule() }
  /** @returns settlement of queued vector indexing. */
  async flush(): Promise<void> { await this.vector.flush() }
  /** @returns settlement of an explicit vector rebuild. */
  async rebuildIndex(): Promise<void> { await this.vector.rebuildIndex() }
  /** @param project - requesting owner.
   * @returns completeness of both configured searches.
   */
  getIndexStatus(project: ProjectId) {
    const text = this.text.getIndexStatus(project)
    const vector = this.vector.getIndexStatus(project)
    return { method: 'hybrid' as const, text, vector, ready: text.ready && vector.ready }
  }

  /** Fuse exact-version ranks, deduplicate and enforce the final rendered byte budget.
   * @param request - owner, query and optional level/scenario/kind selectors.
   * @returns authorized fused results; both searches must settle successfully.
   */
  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const start = performance.now()
    const limit = request.limit ?? this.spec.limit
    const maxBytes = request.maxBytes ?? this.spec.maxBytes
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.spec.candidateLimit || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MemoryError('config', 'Invalid hybrid result budget')
    const pool = { ...request, limit: this.spec.candidateLimit, maxBytes: Math.min(2147483647, maxBytes * this.spec.candidateLimit) }
    const settled = await Promise.allSettled([this.text.retrieve(pool), this.vector.retrieve(pool)])
    request.signal?.throwIfAborted()
    const results = settled.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    const ranked = new Map<string, { hit: RetrievalHit; score: number }>()
    for (const result of results) for (const [index, hit] of result.hits.entries()) {
      const key = JSON.stringify([hit.projectId, hit.ref.id, hit.ref.revision])
      const previous = ranked.get(key)
      ranked.set(key, { hit: previous === undefined ? hit : { ...previous.hit, similarity: hit.similarity ?? previous.hit.similarity },
        score: (previous?.score ?? 0) + 1 / (this.spec.rrfK + index + 1) })
    }
    const hits: RetrievalHit[] = []
    for (const { hit, score } of [...ranked.values()].sort((a, b) => b.score - a.score || a.hit.ref.id.localeCompare(b.hit.ref.id))) {
      const fused = { ...hit, score }
      if (Buffer.byteLength(renderRecall([...hits, fused]), 'utf8') > maxBytes) continue
      hits.push(fused)
      if (hits.length === limit) break
    }
    return this.revalidate(request.projectId, { method: 'hybrid', hits, text: renderRecall(hits),
      scanned: Math.max(...results.map(result => result.scanned)), elapsedMs: performance.now() - start })
  }

  /** @param project - requesting owner.
   * @param result - earlier fused exact-version results.
   * @returns results with replaced, stale or revoked references removed.
   */
  revalidate(project: ProjectId, result: RetrievalResult): RetrievalResult { return this.text.revalidate(project, result) }
  /** Cancel and drain both searches before the parent database closes. */
  async close(): Promise<void> { await Promise.all([this.text.close(), this.vector.close()]) }
}
