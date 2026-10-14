/** Start an isolated keyless acceptance server only through the supported dsh Web profile. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const memory = fileURLToPath(new URL('../', import.meta.url))
const repo = resolve(memory, '..')
const parent = join(memory, '.artifacts')
const args = process.argv.slice(2)
let reuse
let suppliedPatch
let captureDisabled = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--reuse-run' && reuse === undefined) reuse = args[++index]
  else if (args[index] === '--patch' && suppliedPatch === undefined) suppliedPatch = args[++index]
  else if (args[index] === '--capture-disabled' && !captureDisabled) captureDisabled = true
  else throw new Error('Use workspace-web-smoke.mjs [--reuse-run absolute-path] [--patch absolute-path] [--capture-disabled]')
}
if (args.at(-1) === '--reuse-run' || args.at(-1) === '--patch') throw new Error('A path is required after the option')
if (realpathSync(parent) !== resolve(parent)) throw new Error('Refusing redirected acceptance directory')
const run = reuse === undefined ? mkdtempSync(join(parent, 'workspace-web-')) : resolve(reuse)
if (reuse !== undefined && (!isAbsolute(reuse) || !run.startsWith(resolve(parent) + sep) || realpathSync(run) !== run)) throw new Error('Acceptance run must remain inside memory/.artifacts/')
const patch = suppliedPatch === undefined ? undefined : resolve(suppliedPatch)
if (patch !== undefined && (!isAbsolute(suppliedPatch) || !patch.startsWith(resolve(memory) + sep) || realpathSync(patch) !== patch)) throw new Error('Acceptance patch must remain inside memory/')
for (const path of ['home', 'agents', 'tmp', 'cache', 'project-a', 'project-b', 'frames']) {
  const target = join(run, path)
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target)) throw new Error('Refusing redirected acceptance output')
  mkdirSync(target, { recursive: true })
}
const overlay = join(run, 'workspace.patch.yml')
writeFileSync(overlay, '- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(join(run, 'documents')) + '\n- id: memory-l0\n  disabled: ' + captureDisabled + '\n  config:\n    tracePageMaxBytes: 16\n    browser:\n      pageSize: 2\n')
const env = { ...process.env, DSH_HOME: join(run, 'home'), DSH_AGENTS_HOME: join(run, 'agents'),
  TMP: join(run, 'tmp'), TEMP: join(run, 'tmp'), TMPDIR: join(run, 'tmp'),
  XDG_CACHE_HOME: join(run, 'cache'), XDG_CONFIG_HOME: join(run, 'home'), XDG_DATA_HOME: join(run, 'home'), XDG_STATE_HOME: join(run, 'home'),
  npm_config_cache: join(run, 'cache'), npm_config_store_dir: join(memory, '.cache', 'pnpm-store'),
  PNPM_HOME: join(run, 'cache', 'pnpm'), COREPACK_HOME: join(run, 'cache', 'corepack'),
  NODE_COMPILE_CACHE: join(run, 'cache'), DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: join(memory, 'tsconfig.host.json') }
const version = JSON.parse(readFileSync(join(memory, 'package.json'), 'utf8')).version
const archive = join(parent, 'packages', `deepseek-ai-dsh-memory-l0-${version}.tgz`)
if (!existsSync(archive) || realpathSync(archive) !== archive) throw new Error('Build the current portable archive before Web acceptance')
const archiveBytes = readFileSync(archive)
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
const installedArchive = join(run, `memory-${archiveSha256}.tgz`)
writeFileSync(installedArchive, archiveBytes)
const installer = spawnSync(process.execPath, ['--import', 'tsx/esm', join(repo, 'apps/cli/src/bin.ts'),
  'plugin', '--profile', 'web', 'add', installedArchive, '--ignore-scripts', '--store-dir', join(memory, '.cache', 'pnpm-store')], {
  cwd: join(run, 'project-a'), env, encoding: 'utf8', windowsHide: true,
})
writeFileSync(join(run, 'install.log'), `${installer.stdout ?? ''}${installer.stderr ?? ''}`)
if (installer.error || installer.status !== 0) throw new Error(`Portable install failed; inspect ${join(run, 'install.log')}`, { cause: installer.error })
const log = []
const child = spawn(process.execPath, ['--import', 'tsx/esm', join(repo, 'apps/cli/src/bin.ts'), 'web',
  '--patch', join(repo, 'apps/web/tests/pin-browse-picker.overlay.yml'),
  '--patch', join(memory, 'profiles/chat-view.patch.yml'),
  '--patch', join(memory, 'tests/fixtures/compatibility.patch.yml'), '--patch', overlay,
  ...patch === undefined ? [] : ['--patch', patch], '--no-open', '--port', '0'], {
  cwd: join(run, 'project-a'),
  env,
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const state = { run, pid: child.pid, url: null, keyless: true, archive, archiveSha256, installedArchive, captureDisabled, tracePageMaxBytes: 16, browserPageSize: 2 }
writeFileSync(join(parent, 'workspace-web-current.json'), JSON.stringify(state))
writeFileSync(join(run, 'server-state.json'), JSON.stringify(state))
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
    writeFileSync(join(run, 'server-state.json'), JSON.stringify(state))
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
