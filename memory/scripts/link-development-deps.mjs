/** Read existing workspace dependencies through memory-local links; never install or write through them. */
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MEMORY_ROOT, memoryPath } from '../src/config.ts'

for (const [name, source] of [
  ['zod', '../packages/typert/registry/node_modules/zod'],
  ['react', '../packages/client/ui-sidebar-files/node_modules/react'],
  ['react-dom', '../packages/client/ui-sidebar-files/node_modules/react-dom'],
  ['@types/react', '../packages/client/ui-sidebar-files/node_modules/@types/react'],
  ['@types/react-dom', '../packages/client/ui-renderer/node_modules/@types/react-dom'],
  ['@testing-library/react', '../packages/client/ui-sidebar-files/node_modules/@testing-library/react'],
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
    await symlink(installed, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
