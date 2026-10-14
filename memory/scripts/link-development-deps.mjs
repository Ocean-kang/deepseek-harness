/** Read existing workspace dependencies through memory-local links; never install or write through them. */
import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { MEMORY_ROOT, memoryPath } from '../src/config.ts'

const repo = resolve(MEMORY_ROOT, '..')
const manifest = JSON.parse(await readFile(resolve(MEMORY_ROOT, 'package.json'), 'utf8'))
const configuration = ts.readConfigFile(resolve(repo, 'tsconfig.base.json'), ts.sys.readFile)
if (configuration.error) throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'))
const aliases = configuration.config.compilerOptions.paths
const peers = await Promise.all(Object.keys(manifest.peerDependencies).map(async name => {
  const source = aliases[name]?.[0]
  if (typeof source !== 'string') throw new Error(`No existing workspace peer for ${name}`)
  const marker = source.replaceAll('\\', '/').lastIndexOf('/src')
  if (marker < 0) throw new Error(`No package directory in the source alias for ${name}`)
  const directory = resolve(repo, source.slice(0, marker))
  const peer = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  if (peer.name !== name) throw new Error(`Workspace peer name differs for ${name}`)
  return [name, directory]
}))
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--runtime')) throw new Error('Use link-development-deps.mjs [--runtime]')

for (const [name, source] of [
  ['zod', '../packages/typert/registry/node_modules/zod'],
  ...args[0] === '--runtime' ? [] : [
  ['react', '../packages/client/ui-sidebar-files/node_modules/react'],
  ['react-dom', '../packages/client/ui-sidebar-files/node_modules/react-dom'],
  ['@types/react', '../packages/client/ui-sidebar-files/node_modules/@types/react'],
  ['@types/react-dom', '../packages/client/ui-renderer/node_modules/@types/react-dom'],
  ['@testing-library/react', '../packages/client/ui-sidebar-files/node_modules/@testing-library/react'],
  ],
  ...peers,
]) {
  const target = resolve(MEMORY_ROOT, 'node_modules', name)
  const ownedParent = await memoryPath(dirname(target))
  await mkdir(ownedParent, { recursive: true })
  const installed = await realpath(resolve(MEMORY_ROOT, source))
  let existing
  try { existing = await lstat(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing) {
    if (!existing.isSymbolicLink() || await realpath(target) !== installed) throw new Error(`Refusing to replace ${name}`)
  } else {
    await memoryPath(target)
    try { await symlink(installed, target, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      if (error.code !== 'EEXIST' || !(await lstat(target)).isSymbolicLink() || await realpath(target) !== installed) throw error
    }
  }
}
