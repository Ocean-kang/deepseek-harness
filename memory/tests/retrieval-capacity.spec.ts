/** Opt-in local scan benchmark; synthetic vectors measure capacity, not semantic quality. */
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { memoryPath } from '../src/config.ts'
import { resolveEmbeddingConfig } from '../src/embedding.ts'
import { MemoryRetriever } from '../src/retrieval.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'

it.runIf(process.env.DSH_MEMORY_BENCHMARK === '1')('measures authorized scans at 100, 1000 and 10000 candidates', async () => {
  const records = []
  for (const count of [100, 1000, 10000]) {
    const item = await knowledgeFixture()
    let retriever: MemoryRetriever | undefined
    try {
      const seed = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
      const db = new DatabaseSync(item.spec.databasePath)
      try {
        db.exec('BEGIN')
        const insert = db.prepare(`INSERT INTO knowledge_versions SELECT ?,revision,project,level,operation_id,?,
          json_set(knowledge,'$.body',?),config,created_at,state FROM knowledge_versions WHERE id = ?`)
        for (let i = 1; i < count; i++) insert.run(`capacity-${String(i).padStart(5, '0')}`, `capacity-key-${i}`, `Use strict TypeScript for component ${i}`, seed.id)
        db.exec('COMMIT')
      } finally { db.close() }
      const spec = resolveEmbeddingConfig({ endpoint: 'https://synthetic.invalid/embeddings', model: 'synthetic-128', dimensions: 128, apiKeyEnv: 'UNUSED',
        batchSize: 128, maxCandidates: count + 1, retrievalTimeoutMs: 120000 })
      retriever = new MemoryRetriever(item.provider, spec, { embed: async texts => ({ vectors: texts.map(() => Array.from({ length: 128 }, (_, i) => i % 2 ? 0 : 1)), tokens: null }) }, error => { throw error })
      retriever.schedule()
      await retriever.flush()
      expect(retriever.getIndexStatus(item.project).ready).toBe(true)
      const samples: number[] = []
      const scans: number[] = []
      const heapBefore = process.memoryUsage().heapUsed
      let maxHeap = heapBefore
      for (let run = 0; run < 21; run++) {
        const scanStart = performance.now()
        let scanned = 0
        for (const document of item.provider.vectors.documents(item.project, spec.pageSize)) if (document.memory.level === 'L2') { item.provider.vectors.read(spec, document); scanned++ }
        const scanMs = performance.now() - scanStart
        const result = await retriever.retrieve({ projectId: item.project, text: 'TypeScript component', levels: ['L2'] })
        expect(result.scanned).toBe(count)
        expect(scanned).toBe(count)
        maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed)
        if (run > 0) { samples.push(result.elapsedMs); scans.push(scanMs) }
      }
      const dbSize = new DatabaseSync(item.spec.databasePath)
      let bytes: number
      try { bytes = Number(dbSize.prepare('PRAGMA page_count').get()!.page_count) * Number(dbSize.prepare('PRAGMA page_size').get()!.page_size) } finally { dbSize.close() }
      samples.sort((a, b) => a - b)
      scans.sort((a, b) => a - b)
      records.push({ candidates: count, dimensions: 128, repetitions: 20, scanP50Ms: scans[9], scanP95Ms: scans[18], retrievalP50Ms: samples[9], retrievalP95Ms: samples[18], databaseBytes: bytes, sampledHeapGrowthBytes: maxHeap - heapBefore })
    } finally { await retriever?.close(); await item.close() }
  }
  await writeFile(await memoryPath('.artifacts/task4-capacity.json'), JSON.stringify({ kind: 'synthetic-local-capacity', node: process.version, platform: process.platform, records }, null, 2) + '\n')
}, 120000)
