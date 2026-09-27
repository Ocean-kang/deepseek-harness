/** Real Agent admission and JSONL replay with an explicit test-only memory source. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveEmbeddingConfig } from '../src/embedding.ts'
import type { Embedder } from '../src/embedding.ts'
import { MemoryRetriever } from '../src/retrieval.ts'
import { installMemoryInjector } from '../src/injector.ts'
import { knowledgeFixture } from './knowledge-fixtures.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(embedder?: Embedder, responses?: StreamChunk[][]) {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  const queries: string[][] = []
  const retriever = new MemoryRetriever(item.provider, resolveEmbeddingConfig({ endpoint: 'https://example.invalid/embeddings', model: 'test', dimensions: 2, apiKeyEnv: 'TEST_KEY' }), embedder ?? {
    embed: async texts => { queries.push([...texts]); return { vectors: texts.map(() => [1, 0]), tokens: null } },
  }, () => {})
  cleanup.push(() => retriever.close())
  retriever.schedule()
  await retriever.flush()
  queries.length = 0
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: `${item.root}/sessions`, compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(responses ?? [textResponse('first'), textResponse('second'), textResponse('third')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const errors: string[] = []
  const dispose = installMemoryInjector(ctx, retriever, async () => item.project, error => errors.push(error.code))
  const agent = await ctx.agentLoop.create(SessionId('memory-reader'), { provider: 'mock', model: 'mock' })
  return { ...item, ctx, agent, retriever, adapter, queries, errors, dispose }
}
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text }] })

it('records exact recall before the real request and replays unchanged after the index is removed', async () => {
  const item = await setup()
  item.ctx.on('agent/pre-step', async (_payload, next) => ({ ...await next(), startsRequestSeries: true }))
  item.agent.followup(user('parser question'))
  await item.agent.whenIdle()
  await item.ctx.sessions.flush(item.agent.session)
  const events = item.agent.session.snapshotEvents()
  const recalls = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')
  expect(recalls).toHaveLength(1)
  const recall = recalls[0]!
  if (recall.type !== 'user/message') throw new Error('expected user message')
  expect(item.adapter.requests[0]!.messages).toContainEqual(recall.data)
  expect(item.queries).toEqual([['parser question']])
  item.provider.vectors.clear(item.retriever.spec)
  const reader = await item.ctx.sessionPersistence.open(item.agent.session.id, 'read')
  try {
    const stored = (await reader.read()).events
    expect(stored).toContainEqual(recall)
  } finally { await reader.close() }
  expect(item.agent.session.snapshotEvents()).toEqual(events)
})

it('does not search rejected input and forwards later accepted text', async () => {
  const item = await setup()
  const reject = item.ctx.on('agent/pre-step', async () => ({ kind: 'reject', reason: 'test rejection' }))
  item.agent.followup(user('rejected'))
  await item.agent.whenIdle()
  expect(item.queries).toEqual([])
  reject()
  item.agent.followup(user('accepted'))
  await item.agent.whenIdle()
  expect(item.queries).toEqual([['accepted']])
})

it('continues the task on index failure and unregisters without leaving a listener', async () => {
  const item = await setup()
  item.provider.vectors.clear(item.retriever.spec)
  item.agent.followup(user('not ready'))
  await item.agent.whenIdle()
  expect(item.adapter.requests).toHaveLength(1)
  expect(item.errors).toEqual(['index-not-ready'])
  expect(item.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')).toEqual([])
  await item.retriever.flush()
  item.queries.length = 0
  await item.dispose()
  item.agent.followup(user('after unload'))
  await item.agent.whenIdle()
  expect(item.queries).toEqual([])
})

it('searches once across multiple model steps in the same turn', async () => {
  const item = await setup()
  let steered = false
  item.ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!steered) { steered = true; agent.steer(user('additional request')) }
  })
  item.agent.followup(user('initial request'))
  await item.agent.whenIdle()
  expect(item.adapter.requests).toHaveLength(2)
  expect(item.queries).toEqual([['initial request']])
  expect(item.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')).toHaveLength(1)
})

it('cancels retrieval before admission without logging a successful recall', async () => {
  const entered = Promise.withResolvers<void>()
  let hold = false
  const item = await setup({ embed: async (texts, signal) => {
    if (hold) {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return { vectors: texts.map(() => [1, 0]), tokens: null }
  } })
  hold = true
  item.agent.followup(user('cancel this'))
  try { await entered.promise } finally { item.agent.cancel({ kind: 'user' }) }
  await item.agent.whenIdle()
  expect(item.adapter.requests).toEqual([])
  expect(item.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
})

it('uses committed log state after injector reload rather than a process-local success flag', async () => {
  const item = await setup()
  let resumed = false
  item.ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (resumed) return
    resumed = true
    await item.dispose()
    installMemoryInjector(item.ctx, item.retriever, async () => item.project, error => item.errors.push(error.code))
    agent.steer(user('continue the same turn'))
  })
  item.agent.followup(user('first query'))
  await item.agent.whenIdle()
  expect(item.queries).toEqual([['first query']])
  expect(item.adapter.requests).toHaveLength(2)
})

it('retains one recall across a failed model attempt and its retry', async () => {
  const item = await setup(undefined, [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } }], textResponse('recovered')])
  item.ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
  item.agent.followup(user('retry query'))
  await item.agent.whenIdle()
  expect(item.adapter.requests).toHaveLength(2)
  expect(item.queries).toEqual([['retry query']])
  expect(item.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')).toHaveLength(1)
})
