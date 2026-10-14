/** Source-overlay resolution and built memory entry activation through the supported dsh Web launcher. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { fixture } from './helpers.ts'
import { memoryPath } from '../src/config.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const memory = fileURLToPath(new URL('../', import.meta.url))
// A fresh Windows tsx cache took 181 seconds to load this full Web profile before its ready URL.
// The child deadline bounds that readiness wait; the case also owns shutdown and directory cleanup.
const startupTimeoutMs = 240000
const caseTimeoutMs = 300000

for (const patch of ['cordis.patch.yml', 'profiles/panel.patch.yml']) {
  it(`activates the memory panel with the real ${patch} Web overlay`, { timeout: caseTimeoutMs }, async () => {
    const item = await fixture()
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let log = ''
    let spawnError: Error | undefined
    let activationFailed = false
    const started = Date.now()
    try {
      for (const name of ['home', 'cache', 'tmp', 'agents']) await mkdir(join(item.root, name))
      const output = join(item.root, 'confined.patch.yml')
      await writeFile(output, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(item.root, 'documents'))}\n`)
      const deadline = AbortSignal.timeout(startupTimeoutMs)
      child = spawn(process.execPath, ['--import', 'tsx/esm', join(repo, 'apps/cli/src/bin.ts'), 'web',
        '--patch', join(repo, 'apps/web/tests/pin-browse-picker.overlay.yml'),
        '--patch', join(memory, patch), '--patch', join(memory, 'tests/fixtures/compatibility.patch.yml'),
        '--patch', output, '--patch', join(memory, 'tests/fixtures/profile-startup.patch.yml'), '--no-open', '--port', '0'], {
        cwd: item.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: deadline,
        env: { ...process.env, DSH_HOME: join(item.root, 'home'), DSH_MEMORY_PROJECT: 'startup-test',
          DSH_AGENTS_HOME: join(item.root, 'agents'), TMP: join(item.root, 'tmp'), TEMP: join(item.root, 'tmp'), TMPDIR: join(item.root, 'tmp'),
          XDG_CACHE_HOME: join(item.root, 'cache'), NODE_COMPILE_CACHE: join(item.root, 'cache'),
          TSX_TSCONFIG_PATH: join(memory, 'tsconfig.host.json'), DSH_TELEMETRY_DISABLED: '1' },
      })
      exited = new Promise(resolve => child!.once('close', (code, signal) => { resolve([code, signal]) }))
      child.on('error', error => { spawnError = error })
      const observe = (data: Buffer): void => {
        log += String(data)
        if (log.includes('did not activate') && log.includes('dsh web:')) { activationFailed = true; child?.kill() }
      }
      child.stdout?.on('data', observe)
      child.stderr?.on('data', observe)
      const [code, signal] = await exited as [number | null, NodeJS.Signals | null]
      expect(deadline.aborted).toBe(false)
      expect(activationFailed, log.replace(/\?token=[^\s]+/gu, '')).toBe(false)
      expect(spawnError, log.replace(/\?token=[^\s]+/gu, '')).toBeUndefined()
      expect(signal, log.replace(/\?token=[^\s]+/gu, '')).toBeNull()
      expect(code, log.replace(/\?token=[^\s]+/gu, '')).toBe(0)
      expect(log).toContain('MEMORY_PROFILE_STARTUP_PASSED')
      expect(log).not.toContain('did not activate')
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill()
      if (exited !== undefined) {
        await exited
      }
      try {
        const diagnostics = await memoryPath('.artifacts/profile-startup')
        await mkdir(diagnostics, { recursive: true })
        await writeFile(join(diagnostics, `${basename(item.root)}.json`), JSON.stringify({ patch, elapsedMs: Date.now() - started,
          code: child?.exitCode, signal: child?.signalCode, error: spawnError?.message,
          log: log.replace(/\?token=[^\s]+/gu, '') }, null, 2))
      } finally { await item.close() }
    }
  })
}
