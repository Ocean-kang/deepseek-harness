/** Register this local package as a profile link without installing or copying dependencies. */
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MEMORY_ROOT, memoryPath } from '../src/config.ts'

const parent = await memoryPath('home/profiles/headless/node_modules/@deepseek-ai')
await mkdir(parent, { recursive: true })
await memoryPath(parent)
const link = join(parent, 'dsh-memory-l0')
let existing
try {
  existing = await lstat(link)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (existing) {
  if (!existing.isSymbolicLink() || resolve(await realpath(link)) !== resolve(MEMORY_ROOT)) {
    throw new Error('Refusing to replace an existing profile package entry')
  }
} else {
  await memoryPath(link)
  await symlink(resolve(MEMORY_ROOT), link, process.platform === 'win32' ? 'junction' : 'dir')
}
console.log('Local memory package linked in the memory-owned headless profile; no dependencies installed.')
