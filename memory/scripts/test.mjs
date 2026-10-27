/** Vitest 4 test-only entry; configFile:false avoids Vite's ancestor-directory config bundle. */
import { parseCLI, startVitest } from 'vitest/node'
import config from '../vitest.config.ts'

process.env.VITEST_SKIP_INSTALL_CHECKS = '1'
const { filter, options } = parseCLI(['vitest', 'run', ...process.argv.slice(2)])
const vitest = await startVitest('test', filter, {
  ...options,
  config: false,
  watch: false,
  root: config.root,
}, { ...config, configFile: false, server: { watch: null } })
if (vitest === undefined) process.exitCode = 1
else await vitest.close()
