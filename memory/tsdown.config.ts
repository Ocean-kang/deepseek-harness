/** Build only this out-of-tree plugin; runtime peers stay owned by dsh. */
import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

export default defineConfig([{
  entry: ['src/index.ts', 'src/portable.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  tsconfig: 'tsconfig.build.json',
  dts: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
}, {
  entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', tsconfig: 'tsconfig.build.json',
  dts: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives'], alwaysBundle: ['zod'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'memory-panel-css',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      return `\0memory-css:${resolve(dirname(importer), source)}.js`
    },
    async load(id) {
      if (!id.startsWith('\0memory-css:')) return null
      const path = id.slice('\0memory-css:'.length, -3)
      this.addWatchFile(path)
      const result = transform({ filename: path, code: await readFile(path), cssModules: { pattern: '[hash]_[local]' } })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, entry]) => [key, entry.name]))
      return `export default ${JSON.stringify(classes)}; export const cssText = ${JSON.stringify(result.code.toString())};`
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-memory-l0",factory:(require)=>{',
    intro: 'var module = {exports:{}}; var exports = module.exports;',
    footer: 'return module.exports;}});',
  },
}])
