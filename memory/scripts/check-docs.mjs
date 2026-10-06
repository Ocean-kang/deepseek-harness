/** Check independent plugin documents; --write-pairing records the reviewed local bilingual pairs. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorCache, findViolations } from '../../scripts/verify-md-links.ts'
import {
  isTranslationScopeFile, parseTranslationMarkdown, parseTranslationPairingManifest, translationPairSourcePredicate,
  translationStructureDiff, translationStructureSignature,
} from '../../scripts/translation-pairing.ts'
import {
  computeTranslationPairingRecord, parseTranslationPairingRecord, renderTranslationPairingRecord,
  translationPairingRecordDiff, translationPairPaths,
} from '../../scripts/translation-pairing-record.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pairSources = ['memory/README.md', 'memory/distribution/README.md', 'memory/distribution/trigram-upgrade.md']
const pairs = pairSources.map(translationPairPaths)
const files = [...pairs.flatMap(({ source, zh }) => [source, zh]), 'memory/AGENTS.md',
  'memory/evaluation/workspace-storage-2026-10-02.md', 'memory/evaluation/memory-cards-2026-10-03.md',
  'memory/evaluation/batch-sidebar-2026-10-04.md', 'memory/evaluation/knowledge-growth-2026-10-04.md',
  'memory/evaluation/panel-recall-2026-10-04.md', 'memory/evaluation/delivery-0.1.8-2026-10-04.md',
  'memory/evaluation/browser-live-2026-10-04.md', 'memory/evaluation/compatibility-0.2.1-alpha.1-2026-10-06.md']
const args = process.argv.slice(2)
if (args.length > 1 || args.some(arg => arg !== '--write-pairing')) throw new Error('Use check-docs.mjs [--write-pairing]')
const context = { repoRoot: root, isTranslationPairSource: path => pairSources.includes(path) || isTranslationScopeFile(path) }
const recordContext = { repoRoot: root, isTranslationPairSource: translationPairSourcePredicate(
  parseTranslationPairingManifest(readFileSync(resolve(root, 'scripts/translation-pairing.manifest.json'), 'utf8')),
) }
const anchors = anchorCache()
const errors = []
function signature(sourcePath, counterpart, markdown) {
  return translationStructureSignature(parseTranslationMarkdown(markdown), counterpart, {
    ...context, sourcePath, markdown,
  })
}
for (const paths of pairs) {
  const en = readFileSync(resolve(root, paths.source), 'utf8').replaceAll('\r\n', '\n')
  const zh = readFileSync(resolve(root, paths.zh), 'utf8').replaceAll('\r\n', '\n')
  errors.push(...translationStructureDiff(signature(paths.source, basename(paths.zh), en), signature(paths.zh, basename(paths.source), zh)))
  if (en.split('\n').length !== zh.split('\n').length) errors.push(`${paths.source}: bilingual physical line counts differ`)
  const repositoryPair = isTranslationScopeFile(paths.source)
  const current = computeTranslationPairingRecord(paths, en, zh, repositoryPair ? recordContext : context)
  const canonical = renderTranslationPairingRecord(paths, current)
  const record = repositoryPair ? canonical : canonical.replace(
    `#   pnpm run verify-translation-pairing --write ${paths.source}`,
    '#   node --import tsx/esm scripts/check-docs.mjs --write-pairing',
  )
  const meta = resolve(root, paths.meta)
  if (args.includes('--write-pairing')) {
    const memoryRoot = realpathSync(resolve(root, 'memory'))
    const parent = realpathSync(dirname(meta))
    if (parent !== memoryRoot && !parent.startsWith(memoryRoot + sep)) throw new Error(`Pairing record escapes memory/: ${meta}`)
    if (existsSync(meta) && lstatSync(meta).isSymbolicLink()) throw new Error(`Refusing linked pairing record: ${meta}`)
    writeFileSync(meta, record)
  }
  const confirmed = existsSync(meta) ? parseTranslationPairingRecord(readFileSync(meta, 'utf8').replaceAll('\r\n', '\n')) : undefined
  if (confirmed === undefined) errors.push(`${paths.meta}: pairing record is missing or malformed`)
  else errors.push(...translationPairingRecordDiff(confirmed, current).map(error => `${paths.meta}: ${error}`))
}
for (const file of files) {
  if (!existsSync(resolve(root, file))) errors.push(`${file}: document is missing`)
  else errors.push(...findViolations(resolve(root, file), anchors, root))
}
if (errors.length > 0) {
  console.error(errors)
  process.exitCode = 1
} else {
  console.log(`Independent plugin documentation: ${files.length} documents checked; links and ${pairs.length} bilingual structures, line counts and pairing records passed.`)
}
