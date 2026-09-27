/** Opt-in semantic check using explicitly configured real embeddings credentials. */
import { expect, it } from 'vitest'
import { HttpEmbedder, resolveEmbeddingConfig } from '../src/embedding.ts'

it.runIf(process.env.DSH_MEMORY_LIVE_EMBEDDING === '1')('ranks a paraphrase above unrelated knowledge with the configured provider', async () => {
  const spec = resolveEmbeddingConfig({ endpoint: process.env.DSH_MEMORY_EMBEDDING_ENDPOINT ?? '', model: process.env.DSH_MEMORY_EMBEDDING_MODEL ?? '',
    dimensions: Number(process.env.DSH_MEMORY_EMBEDDING_DIMENSIONS), apiKeyEnv: 'DSH_MEMORY_EMBEDDING_API_KEY' })
  const client = new HttpEmbedder(spec, process.env[spec.apiKeyEnv] ?? '')
  const { vectors } = await client.embed(['This project uses strict TypeScript and ESM modules.', 'Which module format and type checking settings does this codebase require?', 'The recipe needs potatoes and butter.'], new AbortController().signal)
  const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0)
  expect(cosine(vectors[0]!, vectors[1]!)).toBeGreaterThan(cosine(vectors[0]!, vectors[2]!))
})
