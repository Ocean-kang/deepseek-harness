/** Vitest 4 test-only entry; configFile:false avoids Vite's ancestor-directory config bundle. */
import { startVitest } from 'vitest/node'
import config from '../vitest.config.ts'

process.env.VITEST_SKIP_INSTALL_CHECKS = '1'
const vitest = await startVitest('test', process.argv.slice(2), {
  config: false,
  watch: false,
  root: config.root,
}, { ...config, configFile: false, server: { watch: null } })
if (vitest === undefined) process.exitCode = 1
else await vitest.close()
