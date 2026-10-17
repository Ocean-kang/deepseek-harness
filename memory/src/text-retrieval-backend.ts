/** Shared text-search configuration and query validation for the Host and storage worker. */
import { MemoryError } from './types.ts'
import type { RetrievalRequest } from './retrieval.ts'

/** Text search is selected explicitly and never replaces a failing vector query. */
export interface TextSearchConfig {
  tokenizer?: 'unicode61' | 'trigram'
  limit?: number
  maxBytes?: number
  maxCandidates?: number
  pageSize?: number
  timeoutMs?: number
  /** Maximum one resumable index synchronization; completed pages survive a timeout. */
  indexTimeoutMs?: number
  maxQueryBytes?: number
  maxTerms?: number
  expandQuery?: boolean
  expansionTimeoutMs?: number
}
/** Complete text-search settings, resolved before execution. */
export type TextSearchSpec = Readonly<Required<TextSearchConfig>>

/** @param input - deployment choices.
 * @returns validated immutable values; no credentials or vector model are required.
 */
export function resolveTextSearchConfig(input: TextSearchConfig): TextSearchSpec {
  const numbers = { limit: input.limit ?? 5, maxBytes: input.maxBytes ?? 8192, maxCandidates: input.maxCandidates ?? 10000,
    pageSize: input.pageSize ?? 128, timeoutMs: input.timeoutMs ?? 5000, maxQueryBytes: input.maxQueryBytes ?? 8192, maxTerms: input.maxTerms ?? 64,
    expansionTimeoutMs: input.expansionTimeoutMs ?? 15000, indexTimeoutMs: input.indexTimeoutMs ?? 60000 }
  for (const [key, value] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new MemoryError('config', `text search ${key} must be a positive bounded integer`)
  }
  const tokenizer = input.tokenizer ?? 'unicode61'
  if (!['unicode61', 'trigram'].includes(tokenizer) || numbers.limit > numbers.maxCandidates) throw new MemoryError('config', 'invalid text search tokenizer or count')
  const expandQuery = input.expandQuery ?? false
  if (typeof expandQuery !== 'boolean') throw new MemoryError('config', 'text search expandQuery must be boolean')
  return Object.freeze({ ...numbers, tokenizer, expandQuery })
}

/** Validate query budgets before any corpus reads.
 * @param request - authorized query. @param spec - resolved search limits.
 * @returns deduplicated literal terms, including Han trigrams.
 */
export function textTerms(request: RetrievalRequest, spec: TextSearchSpec): string[] {
  const limit = request.limit ?? spec.limit
  const maxBytes = request.maxBytes ?? spec.maxBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > spec.maxCandidates || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MemoryError('config', 'invalid retrieval count or byte budget')
  if (Buffer.byteLength(request.text, 'utf8') > spec.maxQueryBytes) throw new MemoryError('budget', 'text query exceeds configured byte limit')
  const terms = [...new Set((request.text.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []).flatMap(word => {
    if (spec.tokenizer !== 'trigram' || !/\p{Script=Han}/u.test(word)) return [word]
    const characters = Array.from(word)
    return characters.length < 3 ? [word] : characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join(''))
  }))]
  if (terms.length > spec.maxTerms) throw new MemoryError('budget', 'text query exceeds configured term limit')
  return terms
}
