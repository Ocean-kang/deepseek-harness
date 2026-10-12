/** Source-overlay resolution and built memory entry activation through the supported dsh Web launcher. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { fixture } from './helpers.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const memory = fileURLToPath(new URL('../', import.meta.url))

for (const patch of ['cordis.patch.yml', 'profiles/panel.patch.yml']) {
  it(`activates the memory panel with the real ${patch} Web overlay`, async () => {
    const item = await fixture()
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    try {
      for (const name of ['home', 'cache', 'tmp', 'agents']) await mkdir(join(item.root, name))
      const output = join(item.root, 'confined.patch.yml')
      await writeFile(output, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(item.root, 'documents'))}\n`)
      const deadline = AbortSignal.timeout(20000)
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
      exited = once(child, 'exit')
      let log = ''
      child.stdout?.on('data', data => { log += String(data) })
      child.stderr?.on('data', data => { log += String(data) })
      const [code, signal] = await exited as [number | null, NodeJS.Signals | null]
      expect(deadline.aborted).toBe(false)
      expect(signal, log.replace(/\?token=[^\s]+/gu, '')).toBeNull()
      expect(code, log.replace(/\?token=[^\s]+/gu, '')).toBe(0)
      expect(log).toContain('MEMORY_PROFILE_STARTUP_PASSED')
      expect(log).not.toContain('did not activate')
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill()
      if (exited !== undefined) {
        try { await exited } catch (error) {
          // The awaited exit already reports a spawn or deadline failure to the case.
        }
      }
      await item.close()
    }
  })
}
