/** HTTP protocol validation with instance-local transports and cancellation. */
import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { HttpEmbedder, resolveEmbeddingConfig, unitVector } from '../src/embedding.ts'

const input = { endpoint: 'https://embedding.invalid/v1/embeddings', model: 'test', dimensions: 2, apiKeyEnv: 'TEST_KEY' }
const spec = resolveEmbeddingConfig({ ...input, retryBaseMs: 1, retryMaxMs: 1 })
const signal = new AbortController().signal
const payload = { model: 'test', data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }], usage: { prompt_tokens: 5 } }

it('restores explicit input order and sends the embeddings protocol', async () => {
  let sent: RequestInit | undefined
  const client = new HttpEmbedder(spec, 'private', async (_url, init) => { sent = init; return Response.json(payload) })
  expect(await client.embed(['first', 'second'], signal)).toEqual({ vectors: [[1, 0], [0, 1]], tokens: 5 })
  expect(JSON.parse(String(sent?.body))).toEqual({ model: 'test', input: ['first', 'second'], encoding_format: 'float' })
  expect(sent?.redirect).toBe('error')
})

it.each([
  { ...payload, data: [payload.data[0]] },
  { ...payload, data: [payload.data[0], payload.data[0]] },
  { ...payload, model: 'other' },
  { ...payload, data: [{ index: 0, embedding: [1] }, payload.data[0]] },
  { ...payload, data: [{ index: 0, embedding: [0, 0] }, payload.data[0]] },
  { ...payload, data: [{ index: 0, embedding: [null, 1] }, payload.data[0]] },
  { ...payload, usage: { prompt_tokens: -1 } },
])('rejects malformed responses without retrying or retaining provider text', async body => {
  let calls = 0
  const client = new HttpEmbedder(spec, 'private', async () => { calls++; return Response.json(body) })
  await expect(client.embed(['a', 'b'], signal)).rejects.toMatchObject({ code: 'output' })
  expect(calls).toBe(1)
})

it('bounds retries for throttling and does not retry authentication failures', async () => {
  let calls = 0
  const client = new HttpEmbedder(spec, 'private', async () => { calls++; return new Response('secret response', { status: 429 }) })
  await expect(client.embed(['a'], signal)).rejects.toThrow('embedding HTTP 429')
  expect(calls).toBe(3)
  const denied = new HttpEmbedder(spec, 'private', async () => { calls++; return new Response('secret', { status: 401 }) })
  await expect(denied.embed(['a'], signal)).rejects.toThrow('embedding HTTP 401')
  expect(calls).toBe(4)
})

it('cancels an in-flight request without retrying', async () => {
  const started = Promise.withResolvers<void>()
  const abort = new AbortController()
  let calls = 0
  const client = new HttpEmbedder(spec, 'private', async (_url, options) => {
    calls++; started.resolve()
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('sensitive transport detail')), { once: true }))
    throw new Error('unreachable')
  })
  const pending = client.embed(['a'], abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await started.promise
  abort.abort()
  await rejected
  expect(calls).toBe(1)
})

it('validates configuration and keeps vector spaces separate', () => {
  expect(resolveEmbeddingConfig(input)).toMatchObject({ batchSize: 16, concurrency: 1, maxBytes: 8192, limit: 5, maxCandidates: 10000 })
  for (const bad of [{ dimensions: 0 }, { threshold: NaN }, { endpoint: 'https://user:secret@example.test' }, { apiKeyEnv: '' }, { concurrency: 0 }]) {
    expect(() => resolveEmbeddingConfig({ ...input, ...bad })).toThrow()
  }
  expect(resolveEmbeddingConfig({ ...input, dimensions: 3 }).space).not.toBe(spec.space)
  expect(resolveEmbeddingConfig({ ...input, apiKeyEnv: 'OTHER_SECRET' }).space).toBe(spec.space)
  expect(() => new HttpEmbedder(spec, '')).toThrow('credential')
  expect(() => unitVector([Infinity, 1], 2)).toThrow()
  expect(unitVector([1e308, 1e308], 2)).toEqual([1 / Math.sqrt(2), 1 / Math.sqrt(2)])
})

it('uses real fetch against an isolated HTTP endpoint and enforces the request deadline', async () => {
  let hanging = false
  const server = createServer((_request, response) => {
    if (hanging) return
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: 'test', data: [{ index: 0, embedding: [1, 0] }] }))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing HTTP fixture address')
    const client = new HttpEmbedder(resolveEmbeddingConfig({ ...input, endpoint: `http://127.0.0.1:${address.port}/embeddings`, timeoutMs: 100, maxAttempts: 1 }), 'fixture-key')
    expect((await client.embed(['hello'], signal)).vectors).toEqual([[1, 0]])
    hanging = true
    await expect(client.embed(['hello'], signal)).rejects.toMatchObject({ code: 'model', message: 'embedding request timed out' })
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
})
