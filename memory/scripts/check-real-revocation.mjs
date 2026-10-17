/** Verify revocation without model calls against a copied, genuinely learned L3 diagnostic database. */
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, SqliteMemory, TextMemoryRetriever } from '../lib/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = resolve(root, process.argv[2])
if (!run.startsWith(resolve(root, '.artifacts') + sep) || await realpath(run) !== run) throw new Error('Real diagnostic must remain under memory/.artifacts/')
const report = JSON.parse(await readFile(join(run, 'report.json'), 'utf8'))
const learned = report.cases.find(item => item.id === 'approved-shared')
assert.equal(report.mode, 'diagnostic-subset')
assert.equal(learned?.isolationPassed, true)
assert.ok(learned.approvedRef)
const directory = await mkdtemp(join(root, '.tmp/real-revocation-'))
const databasePath = join(directory, 'memory.sqlite')
await copyFile(join(run, 'approved-shared-learn.sqlite'), databasePath)
const spec = await resolveConfig({ projectId: 'A', dataRoot: directory, databasePath, textSearch: { expandQuery: false } })
let memory = await SqliteMemory.open(spec)
let retriever = new TextMemoryRetriever(memory, spec.textSearch)
const query = { projectId: 'B', text: 'pearl857', levels: ['L3'] }
const proof = { source: run, copiedDatabase: databasePath, modelRequests: 0, trustedApprovalAdapter: 'Fixed experiment fixture', passed: false }
try {
  const before = await retriever.retrieve(query)
  assert.ok(before.hits.some(hit => hit.shared && hit.ref.id === learned.approvedRef.id))
  const now = Date.now()
  await memory.knowledge.revokeShare({ operationId: randomUUID(), projectId: 'A', ref: learned.approvedRef, action: 'revoke',
    userId: 'fixed-experiment-user', receiptId: randomUUID(), occurredAt: now, expiresAt: now + 60000 }, () => true, now)
  assert.deepEqual((await retriever.revalidate('B', before)).hits, [])
  assert.deepEqual((await retriever.retrieve(query)).hits, [])
  proof.before = before.hits.map(hit => hit.ref)
  proof.afterRevocation = []
  await retriever.close()
  await memory.close()
  memory = await SqliteMemory.open(spec)
  retriever = new TextMemoryRetriever(memory, spec.textSearch)
  assert.deepEqual((await retriever.retrieve(query)).hits, [])
  assert.ok((await memory.knowledge.listCandidates('A', 'L3', '', 100)).some(item => item.id === learned.approvedRef.id))
  proof.afterRestart = []
  proof.ownerRetainsKnowledge = true
  proof.passed = true
} finally { await retriever.close(); await memory.close() }
await writeFile(join(run, 'revocation-storage-proof.json'), JSON.stringify(proof, null, 2) + '\n')
console.log(JSON.stringify(proof))
