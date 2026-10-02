/** Start an isolated keyless acceptance server only through the supported dsh Web profile. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const memory = fileURLToPath(new URL('../', import.meta.url))
const repo = resolve(memory, '..')
const parent = join(memory, '.artifacts')
const run = mkdtempSync(join(parent, 'workspace-web-'))
for (const path of ['home', 'agents', 'tmp', 'cache', 'project-a', 'project-b', 'frames']) mkdirSync(join(run, path))
const overlay = join(run, 'workspace.patch.yml')
writeFileSync(overlay, '- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(join(run, 'documents')) + '\n')
const log = []
const child = spawn(process.execPath, ['--import', 'tsx/esm', join(repo, 'apps/cli/src/bin.ts'), 'web',
  '--patch', join(repo, 'apps/web/tests/pin-browse-picker.overlay.yml'),
  '--patch', join(memory, 'cordis.patch.yml'), '--patch', join(memory, 'profiles/chat-view.patch.yml'),
  '--patch', join(memory, 'tests/fixtures/compatibility.patch.yml'), '--patch', overlay, '--no-open', '--port', '0'], {
  cwd: join(run, 'project-a'),
  env: { ...process.env, DSH_HOME: join(run, 'home'), DSH_AGENTS_HOME: join(run, 'agents'),
    TMP: join(run, 'tmp'), TEMP: join(run, 'tmp'), TMPDIR: join(run, 'tmp'),
    XDG_CACHE_HOME: join(run, 'cache'), NODE_COMPILE_CACHE: join(run, 'cache'), DSH_TELEMETRY_DISABLED: '1',
    TSX_TSCONFIG_PATH: join(memory, 'tsconfig.host.json') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const state = { run, pid: child.pid, url: null, keyless: true }
writeFileSync(join(parent, 'workspace-web-current.json'), JSON.stringify(state))
let ready = false
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  const text = data.toString()
  log.push(text)
  writeFileSync(join(run, 'server.log'), log.join(''))
  const url = /dsh web: (http:\/\/[^\s]+)/u.exec(log.join(''))?.[1]
  if (url !== undefined && !ready) {
    ready = true
    state.url = url
    writeFileSync(join(parent, 'workspace-web-current.json'), JSON.stringify(state))
    console.log(JSON.stringify({ ready: true, run, pid: child.pid, origin: new URL(url).origin }))
  }
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => {
  console.log(JSON.stringify({ exited: true, code, signal }))
  if (!ready) console.error(log.join(''))
  process.exitCode = code ?? 1
})
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
