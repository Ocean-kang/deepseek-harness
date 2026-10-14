/** Host-side lifecycle and recorded expansion; full-text SQL executes in the storage worker. */
import type { MemoryDatabase } from './sqlite.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { revalidateRecall } from './retrieval.ts'
import type { RetrievalRequest, RetrievalResult } from './retrieval.ts'
import type { TextSearchSpec } from './text-retrieval-backend.ts'
import { textTerms } from './text-retrieval-backend.ts'
export { resolveTextSearchConfig } from './text-retrieval-backend.ts'
export type { TextSearchConfig, TextSearchSpec } from './text-retrieval-backend.ts'

/** Async BM25 retrieval with optional journaled query expansion. */
export class TextMemoryRetriever {
  private closed = false
  private readonly abort = new AbortController()
  private readonly queries = new Set<Promise<RetrievalResult>>()
  /** @param provider - caller-owned async database. @param spec - resolved limits.
   * @param expand - optional logged model adapter.
   */
  constructor(private readonly provider: MemoryDatabase, readonly spec: TextSearchSpec,
    private readonly expand?: (request: RetrievalRequest, signal: AbortSignal) => Promise<string>) {
    if (spec.expandQuery && expand === undefined) throw new MemoryError('config', 'text query expansion requires a configured model adapter')
  }
  private assertOpen(): void { if (this.closed) throw new MemoryError('closed', 'text memory retriever is closed') }
  /** Queries use transient worker-owned corpora. */
  schedule(): void { this.assertOpen() }
  /** @returns settlement; there is no background index. */
  async flush(): Promise<void> { this.assertOpen() }
  /** There is no durable text index to rebuild. */
  async rebuildIndex(): Promise<void> { this.assertOpen() }
  /** @param project - requester. @returns current candidate completeness. */
  async getIndexStatus(project: ProjectId) { this.assertOpen(); return this.provider.textStatus(this.spec, project) }
  /** @param request - authorized query. @returns budgeted version-bound references. */
  retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const work = this.query(request)
    this.queries.add(work)
    void work.then(() => this.queries.delete(work), () => this.queries.delete(work))
    return work
  }
  private async query(request: RetrievalRequest): Promise<RetrievalResult> {
    this.assertOpen()
    const signal = AbortSignal.any([this.abort.signal, ...request.signal === undefined ? [] : [request.signal]])
    signal.throwIfAborted()
    const start = performance.now()
    if (textTerms(request, this.spec).length === 0 || request.levels?.length === 0) return { method: 'bm25', hits: [], text: '', scanned: 0, elapsedMs: performance.now() - start }
    const response = await this.queryCorpus(request, signal)
    let result = response.result
    signal.throwIfAborted()
    if (!response.matched && result.scanned !== 0 && this.spec.expandQuery && this.expand !== undefined) {
      const text = await this.expand(request, signal)
      textTerms({ ...request, text }, this.spec)
      result = (await this.queryCorpus({ ...request, text }, signal)).result
      signal.throwIfAborted()
    }
    return { ...result, elapsedMs: performance.now() - start }
  }
  private async queryCorpus(request: RetrievalRequest, signal: AbortSignal) {
    const snapshot = await this.provider.textSnapshot(this.spec, { ...request, signal })
    signal.throwIfAborted()
    const response = await this.provider.textQuery(this.spec, { ...request, signal })
    signal.throwIfAborted()
    if (response.fingerprint !== snapshot) throw new MemoryError('conflict', 'memory changed during text retrieval')
    return response
  }
  /** @param project - requester. @param result - earlier response. @returns rechecked references. */
  async revalidate(project: ProjectId, result: RetrievalResult): Promise<RetrievalResult> {
    this.assertOpen(); return revalidateRecall(this.provider, project, result)
  }
  /** Cancel consumers and await worker requests before closing the database. */
  async close(): Promise<void> { this.closed = true; this.abort.abort(); await Promise.allSettled(this.queries) }
}
