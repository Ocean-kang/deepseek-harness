/** Source-mode memory tests with all caches and coverage confined to memory/. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../vitest.shared.ts'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '.cache/vite',
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    execArgv: vitestExecArgv,
    coverage: { reportsDirectory: '.artifacts/coverage', include: ['src/**/*.ts'] },
  },
})
