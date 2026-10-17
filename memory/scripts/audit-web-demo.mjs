/** Read the real demo's committed Session and recall switch without exposing server credentials. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const memory = fileURLToPath(new URL('../', import.meta.url))
const state = JSON.parse(await readFile(join(memory, '.artifacts/workspace-web-current.json'), 'utf8'))
const replyOnly = process.argv.includes('--reply-only')
if (state.keyless || !resolve(state.run).startsWith(resolve(memory, '.artifacts') + sep)) throw new Error('Only the real isolated memory run can be audited')
const sessions = join(state.run, 'home/sessions')
const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('session.v4.jsonl.zstd'))
const restart = process.argv.includes('--restart')
const prior = restart ? JSON.parse(await readFile(join(state.run, 'real-demo-proof.json'), 'utf8')) : undefined
if (!restart) assert.equal(paths.length, 1)
const sourcePath = prior?.sessionFile ?? paths[0]
assert.ok(paths.includes(sourcePath))
const compressed = await readFile(join(sessions, sourcePath))
const frames = []
for (let offset = 0; offset < compressed.length;) {
  const frame = zstdDecompressSync(compressed.subarray(offset), { info: true })
  assert.ok(frame.engine.bytesWritten > 0)
  offset += frame.engine.bytesWritten
  frames.push(frame.buffer)
}
const lines = Buffer.concat(frames).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
const events = lines.filter(line => typeof line.type === 'string')
const calls = events.filter(event => event.type === 'tool/call')
const results = events.filter(event => event.type === 'tool/result')
assert.equal(calls.length, replyOnly ? 0 : 1)
assert.equal(results.length, replyOnly ? 0 : 1)
if (!replyOnly) {
  assert.equal(calls[0].data.name, 'memory_search')
  assert.equal(results[0].data.message.isError ?? false, false)
  assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: '[]' }])
  assert.ok(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('MEMORY_SEARCH_DEMO_DONE')))
} else {
  assert.ok(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('FINAL_MEMORY_PACKAGE_OK')))
}
const steps = events.filter(event => event.type === 'step/start')
assert.equal(steps.length, replyOnly ? 1 : 2)
const databases = (await readdir(join(state.run, 'documents'), { recursive: true })).filter(path => path.endsWith('memory.sqlite'))
assert.equal(databases.length, 1)
const db = new DatabaseSync(join(state.run, 'documents', databases[0]), { readOnly: true })
let preference
try { preference = db.prepare('SELECT automatic FROM memory_selections').all() } finally { db.close() }
assert.deepEqual(preference.map(row => row.automatic), [0])
const cacheFiles = (await readdir(join(state.run, 'home/storages/session_projcache/sessions'))).filter(path => path.endsWith('.json'))
const cacheFile = `${basename(dirname(sourcePath))}.json`
assert.ok(cacheFiles.includes(cacheFile))
const cache = JSON.parse(await readFile(join(state.run, 'home/storages/session_projcache/sessions', cacheFile), 'utf8'))
const route = cache.record.rows.modelSelection.val.lastUsed
for (const path of ['frames/00.png', 'frames/after-refresh.png', ...replyOnly ? [] : ['frames/02.png']]) assert.equal((await stat(join(state.run, path))).isFile(), true)
const overlay = state.patch === null || state.patch === undefined ? '' : await readFile(state.patch, 'utf8')
const report = { realModel: true, browserFallback: 'Repository Playwright, fresh headless Chrome context; CUA exposes no browser',
  archiveSha256: state.archiveSha256, packageVersion: '0.1.14', profile: 'web', provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort,
  sessionFile: sourcePath, sessionCwd: cache.record.identity.cwd, toolCalls: calls.map(event => ({ name: event.data.name, arguments: JSON.parse(event.data.arguments) })),
  toolResult: [], steps: steps.length, loggedResultBeforeSecondStep: replyOnly ? null : events.indexOf(results[0]) < events.indexOf(steps[1]),
  automaticDefaultScreenshot: 'frames/00.png', savedAutomatic: false,
  afterReloadScreenshot: 'frames/after-refresh.png', mediaLimitation: 'ffmpeg and ffprobe unavailable, including Playwright ffmpeg; no GIF or video encoded',
  autoLearning: false, titleLLMDisabled: /^- id: session-title-llm\r?\n  disabled: true$/mu.test(overlay),
  qualityClaim: replyOnly ? 'Installed package startup and ordinary real reply; no memory-search model call or learned-memory benefit measured' : 'Empty-library live tool and switch acceptance only; no learned-memory benefit measured' }
await writeFile(join(state.run, process.argv.includes('--restart') ? 'real-demo-restart-proof.json' : 'real-demo-proof.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
