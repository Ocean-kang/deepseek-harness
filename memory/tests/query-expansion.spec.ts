/** A recorded model expands search terms; only authorized stored records can enter the recall. */
import { expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { queryExpander } from '../src/query-expansion.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { TextMemoryRetriever, resolveTextSearchConfig } from '../src/text-retrieval.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'

async function* response(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

it('uses a single logged paraphrase call after no text hits and never returns model-invented records', async () => {
  const item = await knowledgeFixture()
  let retriever: TextMemoryRetriever | undefined
  try {
    const [ref] = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '项目禁止泄露凭据。')])
    const search = resolveTextSearchConfig({ tokenizer: 'trigram', expandQuery: true })
    const stream = vi.fn((options: GenerateOptions) => {
      expect(item.provider.listSessions(item.project).filter(session => session.header.id.startsWith('memory-request-'))).toHaveLength(1)
      expect(JSON.stringify(options.messages)).toContain('机密外传')
      return response(JSON.stringify(['泄露凭据']))
    })
    retriever = new TextMemoryRetriever(item.provider, search,
      queryExpander(item.provider, { stream }, resolveL1Config({ provider: 'test', model: 'test' }), search))
    const result = await retriever.retrieve({ projectId: item.project, text: '机密外传' })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(result.hits.map(hit => hit.ref)).toEqual([ref])
    expect(result.text).toContain('项目禁止泄露凭据。')
    const source = item.provider.listSessions(item.project).find(session => session.header.id.startsWith('memory-request-'))!
    const events = (await item.provider.readRaw({ projectId: item.project, sessionId: source.header.id,
      from: SessionLogOffset(0), to: source.committedTo, limit: 10 })).events
    expect(events).toMatchObject([{ type: 'memory/extraction-request', ignorable: true, data: { level: 'recall' } },
      { type: 'memory/extraction-result', data: { outcome: 'returned' } }])
    await retriever.retrieve({ projectId: item.project, text: '泄露凭据' })
    expect(stream).toHaveBeenCalledTimes(1)
  } finally { await retriever?.close(); await item.close() }
})

it.each(['{}', '[]', '[""]', '["a\\nb"]'])('rejects malformed expansion %s and retains the stored memory', async output => {
  const item = await knowledgeFixture()
  let retriever: TextMemoryRetriever | undefined
  try {
    const [ref] = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])
    const search = resolveTextSearchConfig({ tokenizer: 'trigram', expandQuery: true })
    retriever = new TextMemoryRetriever(item.provider, search,
      queryExpander(item.provider, { stream: () => response(output) }, resolveL1Config({ provider: 'test', model: 'test' }), search))
    await expect(retriever.retrieve({ projectId: item.project, text: 'unmatched' })).rejects.toMatchObject({ code: 'output' })
    expect(item.provider.knowledge.getMemory(item.project, ref!)).not.toBeNull()
  } finally { await retriever?.close(); await item.close() }
})
