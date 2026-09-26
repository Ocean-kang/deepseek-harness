/** Scoped read-only link and bilingual-structure checks using the repository's validators. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorCache, findViolations } from '../../scripts/verify-md-links.ts'
import {
  isTranslationScopeFile, parseTranslationMarkdown,
  translationStructureDiff, translationStructureSignature,
} from '../../scripts/translation-pairing.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const files = ['memory/README.md', 'memory/README.zh.md', 'memory/PROJECT.md', 'memory/Tasks.md']
const anchors = anchorCache()
const errors = files.flatMap(file => findViolations(resolve(root, file), anchors, root))
function signature(sourcePath, counterpart) {
  const markdown = readFileSync(resolve(root, sourcePath), 'utf8')
  return translationStructureSignature(parseTranslationMarkdown(markdown), counterpart, {
    repoRoot: root, sourcePath, isTranslationPairSource: isTranslationScopeFile, markdown,
  })
}
errors.push(...translationStructureDiff(signature(files[0], 'README.zh.md'), signature(files[1], 'README.md')))
if (errors.length > 0) {
  console.error(errors)
  process.exitCode = 1
} else {
  console.log('Four documents: links and README bilingual structure passed. This does not replace doc-sync or the required pairing record.')
}
