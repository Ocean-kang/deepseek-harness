/** Dependency-free syntax/configuration checks; this does not replace TypeScript or Vitest. */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
let count = 0
for (const directory of ['src', 'tests']) {
  for (const file of await readdir(join(root, directory))) {
    if (!file.endsWith('.ts')) continue
    stripTypeScriptTypes(await readFile(join(root, directory, file), 'utf8'), { mode: 'transform' })
    count++
  }
}
for (const file of ['vitest.config.ts', 'tsdown.config.ts']) {
  stripTypeScriptTypes(await readFile(join(root, file), 'utf8'), { mode: 'transform' })
  count++
}
const spec = await resolveConfig({ projectId: 'test', databasePath: 'data/test.sqlite' })
assert.equal(spec.queueCapacity, 1024)
assert.equal(spec.pageSize, 128)
assert.equal(spec.journalMode, 'wal')
for (const queueCapacity of [0, -1, 0.5, Infinity]) {
  await assert.rejects(resolveConfig({ projectId: 'test', databasePath: 'data/test.sqlite', queueCapacity }), { code: 'config' })
}
await assert.rejects(resolveConfig({ projectId: 'test', databasePath: '../escape.sqlite' }), { code: 'config' })
await assert.rejects(resolveConfig({ projectId: ' ', databasePath: 'data/test.sqlite' }), { code: 'config' })
console.log(`Parsed ${count} TypeScript files; configuration defaults and six invalid inputs passed. No files written. Type checking and integration tests remain separate.`)
