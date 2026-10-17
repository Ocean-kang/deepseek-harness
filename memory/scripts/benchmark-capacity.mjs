/** Fixed synthetic capacity diagnostic through built public memory calls under plain Node. */
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { cpus } from 'node:os'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const root = fileURLToPath(new URL('../', import.meta.url))
const lib = resolve(root, process.argv[2] ?? 'lib/index.mjs')
const reportPath = resolve(root, process.argv[3] ?? '.artifacts/capacity-current.json')
if (![lib, reportPath].every(path => path.startsWith(root))) throw new Error('Capacity inputs and outputs must stay under memory/')
const api = await import(pathToFileURL(lib).href)
// This is the same existing bundled constructor imported by the shipped Workspace implementation.
let Pool
const workspaceChunk = (await readdir(dirname(lib))).find(name => /^workspace-storage-.*\.mjs$/u.test(name))
if (workspaceChunk !== undefined) {
  const workspaceSource = await readFile(join(dirname(lib), workspaceChunk), 'utf8')
  const ownerImport = workspaceSource.split('\n').find(line => line.includes(' as StoragePool,'))
  const alias = ownerImport?.match(/\b(\w+) as StoragePool\b/u)?.[1]
  const ownerModule = ownerImport?.match(/from "(.+)"/u)?.[1]
  if (alias !== undefined && ownerModule !== undefined) Pool = (await import(new URL(ownerModule, pathToFileURL(join(dirname(lib), workspaceChunk)))))[alias]
}
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/capacity-'))
const report = { kind: 'fixed-synthetic-text-capacity', lib, databaseRoot: temporary, node: process.version, platform: process.platform,
  cpu: cpus()[0]?.model, repetitions: 20, query: 'parser route731', records: [],
  limits: { warmP95Ms: 1000, independentStoreP95Ms: 200 },
  exclusions: ['Model and network latency', 'Browser rendering', 'Cold process launch; openMs includes worker and database open'] }
const measure = async action => { const start = performance.now(); const value = await action(); return { ms: performance.now() - start, value } }
const percentile = samples => [...samples].sort((a,b) => a-b)[Math.ceil(samples.length * .95)-1]
const continueIndex = async (action, attempts) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const start = performance.now()
    try { const value = await action(); attempts.push({ elapsedMs: performance.now() - start, outcome: 'ready' }); return value }
    catch (error) {
      attempts.push({ elapsedMs: performance.now() - start, outcome: error.code ?? error.name })
      if (error.code !== 'index-not-ready') throw error
    }
  }
  throw new Error('Index remained unready after eight saved-page continuation attempts')
}

for (const count of [1000, 10000, 100000]) {
  const databasePath = join(temporary, `capacity-${count}.sqlite`)
  const spec = await api.resolveConfig({ projectId: 'capacity-project', databasePath,
    dataRoot: temporary, textSearch: { maxCandidates: 10000, timeoutMs: 120000, pageSize: 256 } })
  let provider = await api.SqliteMemory.open(spec)
  const source = Session.create(SessionId(`capacity-source-${count}`))
  source.append('turn/start', { turn: 1 })
  source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Project routing policy: parser route731 uses strict ESM. This is an explicit project constraint.' }] }), { surfaceOp: 'append' })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await provider.appendRaw({ projectId: spec.projectId, header: source.header, inheritedEventCount: source.inheritedEventCount, events: source.snapshotEvents() })
  await provider.scanTurns(spec.projectId, api.resolveL1Config({ provider: 'synthetic', model: 'synthetic' }), 32)
  const task = await provider.l1.claim(spec.projectId, source.id, 'benchmark', Date.now())
  await provider.l1.prepare(spec.projectId, task.operationId, 'benchmark', { kind: 'memory', summary: {
    goal: 'Project routing policy', actions: [], outcome: 'unknown', result: 'Parser route731 uses strict ESM.', solution: null,
    sources: [{ sessionId: source.id, seq: 1 }] } })
  const l1 = await provider.l1.commitMemory(spec.projectId, task.operationId, 'benchmark', Date.now())
  const config = { ...api.resolveKnowledgeConfig({ provider: 'synthetic', model: 'synthetic' }), promptVersion: 'knowledge-v3' }
  const operation = await provider.knowledge.enqueue(spec.projectId, 'L2', [l1], config)
  await provider.knowledge.claim(spec.projectId, operation, 'benchmark', Date.now())
  await provider.knowledge.prepare(spec.projectId, operation, 'benchmark', [{ target: null, knowledge: {
    title: 'Parser routing', body: 'Parser route731 uses strict ESM.', category: 'constraint', score: 4,
    rationale: 'Explicit project policy', evidence: 'supported', sources: [{ kind: 'memory', ref: { id: l1.id, revision: l1.revision } }] } }])
  const seed = (await provider.knowledge.commit(spec.projectId, operation, 'benchmark', Date.now()))[0]
  await provider.close()
  const db = new DatabaseSync(databasePath)
  const seeded = await measure(async () => {
    db.exec('BEGIN')
    // Background cards share another valid L1 root, so selection need not retain all of them as direct source dependants.
    const columns = db.prepare('PRAGMA table_info(l1_tasks)').all().map(row => String(row.name))
    const sourceTask = db.prepare('SELECT * FROM l1_tasks WHERE id=?').get(l1.operationId)
    const backgroundTask = { ...sourceTask, id: 'capacity-background-operation', memory_id: 'capacity-background-source' }
    db.prepare(`INSERT INTO l1_tasks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => backgroundTask[column]))
    db.prepare(`INSERT INTO l1_memories SELECT 'capacity-background-source',revision,project,'capacity-background-operation',summary,created_at FROM l1_memories WHERE id=?`).run(l1.id)
    const insert = db.prepare(`INSERT INTO knowledge_versions SELECT ?,revision,project,level,operation_id,?,json_set(knowledge,'$.body',?,'$.sources[0].ref.id','capacity-background-source'),config,created_at,state FROM knowledge_versions WHERE id=?`)
    for (let index = 1; index < count; index++) insert.run(`capacity-${String(index).padStart(6,'0')}`, `capacity-key-${index}`,
      `Component route${index} parser policy uses strict ESM; preserve failure details for component ${index}.`, seed.id)
    db.exec('COMMIT')
  })
  db.close()
  const pool = Pool === undefined ? undefined : new Pool(spec)
  const opened = await measure(() => api.SqliteMemory.open(spec, pool))
  provider = opened.value
  let retriever = new api.TextMemoryRetriever(provider, spec.textSearch)
  const request = { projectId: spec.projectId, text: 'parser route731', levels: ['L2'], limit: 5 }
  const record = { count, databasePath, syntheticSeedMs: seeded.ms, openMs: opened.ms, warmSamplesMs: [], failures: [], rssBefore: process.memoryUsage().rss }
  const query = async () => {
    const result = await retriever.retrieve(request)
    if (!result.hits.length) throw new Error('Benchmark query produced no hits')
    return result
  }
  try {
    record.indexBuildAttempts = []
    const first = await measure(() => continueIndex(query, record.indexBuildAttempts))
    record.firstQueryMs = first.ms
    record.firstScanned = first.value.scanned
    for (let repetition = 0; repetition < 20; repetition++) record.warmSamplesMs.push((await measure(query)).ms)
    record.warmP95Ms = percentile(record.warmSamplesMs)
    record.warmPassed = record.warmP95Ms <= report.limits.warmP95Ms
    if (pool !== undefined) {
      const otherSpec = await api.resolveConfig({ ...spec, projectId: 'other-capacity-project', databasePath: join(temporary, `other-${count}.sqlite`) })
      const other = await api.SqliteMemory.open(otherSpec, pool)
      const samples = []
      let heavySettled = false
      const heavyStart = performance.now()
      await provider.rebuildTextIndex()
      record.rebuildAttempts = []
      const heavy = continueIndex(() => retriever.flush(), record.rebuildAttempts)
      void heavy.then(() => { heavySettled = true }, () => { heavySettled = true })
      try {
        const overlaps = []
        for (let index = 0; index < 20; index++) {
          const startedWhileHeavyPending = !heavySettled
          samples.push((await measure(() => other.listProjects())).ms)
          overlaps.push(startedWhileHeavyPending)
          // Fixed diagnostic sampling cadence spreads observations across index pages; it is not a readiness signal.
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        await heavy
        record.independentStoreSamplesMs = samples
        record.independentStoreOverlapped = overlaps
        record.contentionRebuildMs = performance.now() - heavyStart
        record.independentStoreP95Ms = percentile(samples)
        record.independentStorePassed = record.independentStoreP95Ms <= report.limits.independentStoreP95Ms
        record.contentionOperation = 'Production Workspace StoragePool: rebuildIndex() overlaps another database listProjects(); Workspace routing and browser excluded'
      } finally { await heavy.catch(() => undefined); await other.close() }
      // Rebuild populated the default unfiltered corpus; restore the exact L2 corpus before timing an incremental change.
      record.filteredRebuildAttempts = []
      await continueIndex(query, record.filteredRebuildAttempts)
    }
    const prepared = await measure(() => provider.knowledge.enqueue(spec.projectId, 'L2', [l1], { ...config, model: 'preparation-measurement' }))
    record.distillationPreparationMs = prepared.ms
    const pending = await provider.knowledge.getTask(spec.projectId, prepared.value)
    record.distillationExisting = pending?.input.existing.length
    const incremental = await measure(async () => {
      const operation = await provider.knowledge.enqueue(spec.projectId, 'L2', [l1], { ...config, model: 'incremental-measurement' })
      await provider.knowledge.claim(spec.projectId, operation, 'benchmark', Date.now())
      await provider.knowledge.prepare(spec.projectId, operation, 'benchmark', [{ target: null, knowledge: {
        title: 'Incremental diagnostic', body: 'incrementalmarker741 is the newly stored diagnostic.', category: 'constraint', score: 4,
        rationale: 'Explicit synthetic policy', evidence: 'supported', sources: [{ kind: 'memory', ref: { id: l1.id, revision: l1.revision } }] } }])
      return provider.knowledge.commit(spec.projectId, operation, 'benchmark', Date.now())
    })
    record.incrementalCommitMs = incremental.ms
    const incrementalQuery = await measure(() => retriever.retrieve({ ...request, text: 'incrementalmarker741' }))
    if (!incrementalQuery.value.hits.some(hit => hit.ref.id === incremental.value[0].id)) throw new Error('Newly committed knowledge is missing from text index')
    record.incrementalQueryMs = incrementalQuery.ms
  } catch (error) { record.failures.push({ code: error.code ?? error.name, message: error.message }) }
  finally { await retriever.close(); await provider.close(); await pool?.close() }
  const reopened = await measure(() => api.SqliteMemory.open(spec))
  provider = reopened.value
  retriever = new api.TextMemoryRetriever(provider, spec.textSearch)
  record.reopenMs = reopened.ms
  try { record.recoveryQueryMs = (await measure(query)).ms }
  catch (error) { record.failures.push({ phase: 'recovery', code: error.code ?? error.name, message: error.message }) }
  finally { await retriever.close(); await provider.close() }
  const size = new DatabaseSync(databasePath)
  record.databaseBytes = Number(size.prepare('PRAGMA page_count').get().page_count) * Number(size.prepare('PRAGMA page_size').get().page_size)
  size.close()
  record.rssAfter = process.memoryUsage().rss
  report.records.push(record)
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(record))
}
console.log(`Capacity report: ${reportPath}`)
