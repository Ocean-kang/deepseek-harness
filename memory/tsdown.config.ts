/** Build only this out-of-tree plugin; runtime peers stay owned by dsh. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
