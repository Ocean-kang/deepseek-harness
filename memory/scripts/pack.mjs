/** Pack only the declared distribution files; cache and archive stay inside memory/. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const destination = join(root, '.artifacts', 'packages')
for (const directory of [root, dirname(destination), destination]) {
  if (existsSync(directory) && realpathSync(directory) !== directory) throw new Error(`Refusing redirected package directory: ${directory}`)
}
mkdirSync(destination, { recursive: true })
const stage = mkdtempSync(join(destination, 'stage-'))
try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of ['cordis.patch.yml', 'persistence-source.json']) copyFileSync(join(root, name), join(stage, name))
  for (const name of ['README.md', 'README.zh.md', 'trigram-upgrade.md', 'trigram-upgrade.zh.md']) copyFileSync(join(root, 'distribution', name), join(stage, name))
  const seen = new Set()
  function copyArtifact(name) {
    const path = resolve(root, name)
    if (!path.startsWith(join(root, 'lib') + sep)) throw new Error('Build imports escape lib/')
    if (seen.has(path)) return
    seen.add(path)
    const target = join(stage, relative(root, path))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(path, target)
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) copyArtifact(relative(root, resolve(dirname(path), match[1])))
  }
  for (const name of ['lib/index.mjs', 'lib/portable.mjs', 'lib/client.js']) copyArtifact(name)
  const cli = process.env['npm_execpath'] ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(cli)) throw new Error('Run pack:portable through npm so its CLI path is available')
  const result = spawnSync(process.execPath, [cli, 'pack', '--ignore-scripts', '--pack-destination', destination], {
    cwd: stage, stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(root, '.cache', 'npm') },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  const path = resolve(stage)
  if (dirname(path) !== destination || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || realpathSync(destination) !== destination) {
    throw new Error(`Refusing redirected package staging directory: ${path}`)
  }
  rmSync(path, { recursive: true })
}
