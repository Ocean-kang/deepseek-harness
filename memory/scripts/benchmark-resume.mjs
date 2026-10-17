/** Resume a completed synthetic index and measure warm, incremental and competing distillation operations. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const databaseRoot = resolve(root, process.argv[2])
if (!databaseRoot.startsWith(root)) throw new Error('Synthetic databases must be under memory/')
const reportPath = resolve(root, process.argv[3] ?? '.artifacts/capacity-resumed.json')
if (!reportPath.startsWith(root)) throw new Error('Capacity report must be under memory/')
const api = await import(new URL('../lib/index.mjs', import.meta.url))
const chunk = (await readdir(join(root, 'lib'))).find(name => /^workspace-storage-.*\.mjs$/u.test(name))
const ownerImport = (await readFile(join(root, 'lib', chunk), 'utf8')).split('\n').find(line => line.includes(' as StoragePool,'))
const alias = ownerImport.match(/\b(\w+) as StoragePool\b/u)[1]
const ownerModule = ownerImport.match(/from "(.+)"/u)[1]
const Pool = (await import(new URL(ownerModule, pathToFileURL(join(root, 'lib', chunk)))))[alias]
const measure = async action => { const start = performance.now(); const value = await action(); return { ms: performance.now() - start, value } }
const p95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]
const report = { kind: 'saved-page-capacity-continuation', databaseRoot, node: process.version, records: [] }
for (const count of [1000, 10000, 100000]) {
  const databasePath = join(databaseRoot, `capacity-${count}.sqlite`)
  const spec = await api.resolveConfig({ projectId: 'capacity-project', databasePath, dataRoot: databaseRoot,
    textSearch: { maxCandidates: 10000, timeoutMs: 120000, pageSize: 256 } })
  const pool = new Pool(spec)
  const provider = await api.SqliteMemory.open(spec, pool)
  const retriever = new api.TextMemoryRetriever(provider, spec.textSearch)
  const record = { count, warmSamplesMs: [], failures: [] }
  report.records.push(record)
  try {
    const request = { projectId: spec.projectId, text: 'parser route731', levels: ['L2'], limit: 5 }
    const ready = await retriever.retrieve(request)
    if (ready.hits.length !== 5) throw new Error('Expected five authorized synthetic hits')
    for (let index = 0; index < 20; index++) record.warmSamplesMs.push((await measure(() => retriever.retrieve(request))).ms)
    record.warmP95Ms = p95(record.warmSamplesMs)
    record.warmPassed = record.warmP95Ms <= 1000
    const tasks = await provider.l1.listTasks(spec.projectId, '', 10)
    const task = tasks.find(task => task.operationId !== 'capacity-background-operation')
    const source = await provider.l1.byOperation(spec.projectId, task.operationId)
    const config = { ...api.resolveKnowledgeConfig({ provider: 'synthetic', model: 'resume-diagnostic' }), promptVersion: 'knowledge-v3' }
    const preparation = await measure(() => provider.knowledge.enqueue(spec.projectId, 'L2', [source], config))
    record.distillationPreparationMs = preparation.ms
    record.distillationExisting = (await provider.knowledge.getTask(spec.projectId, preparation.value)).input.existing.length
    const update = await measure(async () => {
      const operation = await provider.knowledge.enqueue(spec.projectId, 'L2', [source], { ...config, model: 'resume-incremental' })
      await provider.knowledge.claim(spec.projectId, operation, 'benchmark', Date.now())
      await provider.knowledge.prepare(spec.projectId, operation, 'benchmark', [{ target: null, knowledge: {
        title: 'Warm incremental diagnostic', body: 'incrementalmarker742 is the newly stored diagnostic.', category: 'constraint', score: 4,
        rationale: 'Explicit synthetic policy', evidence: 'supported', sources: [{ kind: 'memory', ref: { id: source.id, revision: source.revision } }] } }])
      return provider.knowledge.commit(spec.projectId, operation, 'benchmark', Date.now())
    })
    record.incrementalCommitMs = update.ms
    const query = await measure(() => retriever.retrieve({ ...request, text: 'incrementalmarker742' }))
    if (!query.value.hits.some(hit => hit.ref.id === update.value[0].id)) throw new Error('Incremental result missing from warmed corpus')
    record.incrementalQueryMs = query.ms
    if (count === 100000) {
      const otherSpec = await api.resolveConfig({ ...spec, projectId: 'other-capacity-project', databasePath: join(databaseRoot, 'other-resume.sqlite') })
      const other = await api.SqliteMemory.open(otherSpec, pool)
      const samples = []
      let completed = false
      const heavy = (async () => {
        for (let index = 0; index < 20; index++) await provider.knowledge.enqueue(spec.projectId, 'L2', [source], { ...config, model: `resume-overlap-${index}` })
      })()
      void heavy.then(() => { completed = true }, () => { completed = true })
      try {
        record.independentStoreOverlapped = []
        for (let index = 0; index < 20; index++) {
          record.independentStoreOverlapped.push(!completed)
          samples.push((await measure(() => other.listProjects())).ms)
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        await heavy
        record.independentStoreSamplesMs = samples
        record.independentStoreP95Ms = p95(samples)
        record.independentStorePassed = record.independentStoreP95Ms <= 200
        record.contentionOperation = 'Production StoragePool, twenty bounded distillation preparations overlap another database listProjects; routing, model and browser excluded'
      } finally { await heavy.catch(() => undefined); await other.close() }
    }
  } catch (error) { record.failures.push({ code: error.code ?? error.name, message: error.message }) }
  finally { await retriever.close(); await provider.close(); await pool.close() }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(record))
}
