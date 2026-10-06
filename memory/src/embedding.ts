/** Bounded embeddings HTTP client and explicit deployment configuration. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { MemoryError } from './types.ts'

/** Identity of one incompatible vector space, excluding credentials. */
export type VectorSpaceId = Branded<'MemoryVectorSpace'>
/** Optional tunables; endpoint is the complete embeddings URL. */
export interface EmbeddingConfig {
  endpoint: string
  model: string
  dimensions: number
  apiKeyEnv: string
  sendDimensions?: boolean
  batchSize?: number
  concurrency?: number
  timeoutMs?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  retrievalTimeoutMs?: number
  limit?: number
  maxBytes?: number
  threshold?: number
  pageSize?: number
  maxCandidates?: number
}
/** Complete deployment values; secrets are read separately at activation. */
export interface EmbeddingSpec extends Required<EmbeddingConfig> { readonly space: VectorSpaceId }

/** Resolve all defaults before network or database activity.
 * @param input - deployment configuration.
 * @returns immutable specification.
 */
export function resolveEmbeddingConfig(input: EmbeddingConfig): EmbeddingSpec {
  let url: URL
  try { url = new URL(input.endpoint) } catch { throw new MemoryError('config', 'embedding endpoint must be an absolute URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MemoryError('config', 'embedding endpoint must be HTTP(S) without credentials, query or fragment')
  if (typeof input.model !== 'string' || !input.model.trim() || input.model !== input.model.trim()
    || typeof input.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv)) throw new MemoryError('config', 'embedding model and credential environment name are required')
  const values = { dimensions: input.dimensions, batchSize: input.batchSize ?? 16, concurrency: input.concurrency ?? 1,
    timeoutMs: input.timeoutMs ?? 15000, maxAttempts: input.maxAttempts ?? 3, retryBaseMs: input.retryBaseMs ?? 500,
    retryMaxMs: input.retryMaxMs ?? 5000, retrievalTimeoutMs: input.retrievalTimeoutMs ?? 5000,
    limit: input.limit ?? 5, maxBytes: input.maxBytes ?? 8192, pageSize: input.pageSize ?? 128, maxCandidates: input.maxCandidates ?? 10000 }
  for (const [key, value] of Object.entries(values)) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new MemoryError('config', `embedding ${key} must be a positive bounded integer`)
  const threshold = input.threshold ?? 0.65
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1 || values.retryMaxMs < values.retryBaseMs) throw new MemoryError('config', 'invalid embedding threshold or retry interval')
  if (input.sendDimensions !== undefined && typeof input.sendDimensions !== 'boolean') throw new MemoryError('config', 'sendDimensions must be boolean')
  const endpoint = url.href
  const space = createHash('sha256').update(JSON.stringify([endpoint, input.model, input.dimensions, 'memory-text-v1'])).digest('hex') as VectorSpaceId
  return Object.freeze({ ...values, endpoint, model: input.model, apiKeyEnv: input.apiKeyEnv, threshold, sendDimensions: input.sendDimensions ?? false, space })
}

/** Validate external or persisted vectors and return their unit representation.
 * @param value - external vector.
 * @param dimensions - configured dimension.
 * @returns finite unit vector.
 */
export function unitVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n))) throw new MemoryError('output', 'invalid embedding vector')
  const numbers: number[] = value
  const scale = numbers.reduce((max, n) => Math.max(max, Math.abs(n)), 0)
  if (scale === 0) throw new MemoryError('output', 'zero embedding vector')
  const norm = Math.sqrt(numbers.reduce((sum, n) => sum + (n / scale) ** 2, 0))
  return numbers.map(n => (n / scale) / norm)
}

/** Ordered vectors and provider-reported input usage, when supplied. */
export interface EmbeddingResult { readonly vectors: readonly number[][]; readonly tokens: number | null }
/** Cancellable embeddings provider, also used by deterministic test adapters. */
export interface Embedder {
  /** @param texts - nonempty inputs in output order.
   * @param signal - cancellation including the caller's total deadline.
   * @returns validated vectors and optional token usage.
   */
  embed(texts: readonly string[], signal: AbortSignal): Promise<EmbeddingResult>
}

/** HTTP adapter; response errors never retain provider bodies or credentials. */
export class HttpEmbedder implements Embedder {
  /** @param spec - resolved configuration.
   * @param key - explicit secret read at activation, never stored in SQLite.
   * @param request - instance-local transport for tests.
   */
  constructor(private readonly spec: EmbeddingSpec, private readonly key: string, private readonly request: typeof fetch = fetch) {
    if (!key.trim()) throw new MemoryError('config', 'embedding credential is missing')
  }

  /** @param texts - nonempty inputs.
   * @param signal - owner cancellation.
   * @returns vectors in input order.
   */
  async embed(texts: readonly string[], signal: AbortSignal): Promise<EmbeddingResult> {
    if (!texts.length || texts.some(text => !text.trim())) throw new MemoryError('output', 'embedding inputs must be nonempty')
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted()
      const timer = new AbortController()
      const timeout = setTimeout(() => timer.abort(), this.spec.timeoutMs)
      let transient = false
      try {
        let response: Response
        try {
          response = await this.request(this.spec.endpoint, { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
            body: JSON.stringify({ model: this.spec.model, input: texts, encoding_format: 'float', ...(this.spec.sendDimensions ? { dimensions: this.spec.dimensions } : {}) }),
            signal: AbortSignal.any([signal, timer.signal]) })
        } catch (error) {
          signal.throwIfAborted()
          transient = true
          throw new MemoryError('model', timer.signal.aborted ? 'embedding request timed out' : 'embedding transport failed')
        }
        if (!response.ok) {
          transient = response.status === 429 || response.status >= 500
          await response.body?.cancel()
          throw new MemoryError('model', `embedding HTTP ${response.status}`)
        }
        let body: unknown
        try { body = await response.json() } catch (error) {
          signal.throwIfAborted()
          transient = timer.signal.aborted
          throw new MemoryError('output', 'embedding response is not complete JSON')
        }
        signal.throwIfAborted()
        if (body === null || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length !== texts.length
          || !('model' in body) || body.model !== this.spec.model) throw new MemoryError('output', 'embedding response count or model mismatch')
        const vectors: number[][] = Array.from({ length: texts.length })
        for (const entry of body.data) {
          const row: unknown = entry
          if (row === null || typeof row !== 'object' || !('index' in row) || typeof row.index !== 'number' || !Number.isSafeInteger(row.index)
            || row.index < 0 || row.index >= texts.length || vectors[row.index] !== undefined || !('embedding' in row)) throw new MemoryError('output', 'embedding response index mismatch')
          vectors[row.index] = unitVector(row.embedding, this.spec.dimensions)
        }
        let tokens: number | null = null
        if ('usage' in body && body.usage !== null && typeof body.usage === 'object' && 'prompt_tokens' in body.usage) {
          const value = body.usage.prompt_tokens
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MemoryError('output', 'invalid embedding usage')
          tokens = value
        }
        return { vectors, tokens }
      } catch (error) {
        signal.throwIfAborted()
        if (!transient || attempt >= this.spec.maxAttempts) throw error
      } finally { clearTimeout(timeout) }
      await delay(Math.min(this.spec.retryMaxMs, this.spec.retryBaseMs * 2 ** (attempt - 1)), undefined, { signal })
    }
  }
}
