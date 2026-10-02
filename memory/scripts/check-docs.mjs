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
const pairs = [['memory/README.md', 'memory/README.zh.md'], ['memory/distribution/README.md', 'memory/distribution/README.zh.md']]
const files = [...pairs.flat(), 'memory/AGENTS.md', 'memory/evaluation/workspace-storage-2026-10-02.md']
const anchors = anchorCache()
const errors = files.flatMap(file => findViolations(resolve(root, file), anchors, root))
function signature(sourcePath, counterpart) {
  const markdown = readFileSync(resolve(root, sourcePath), 'utf8')
  return translationStructureSignature(parseTranslationMarkdown(markdown), counterpart, {
    repoRoot: root, sourcePath, isTranslationPairSource: isTranslationScopeFile, markdown,
  })
}
for (const [english, chinese] of pairs) {
  errors.push(...translationStructureDiff(signature(english, 'README.zh.md'), signature(chinese, 'README.md')))
}
if (errors.length > 0) {
  console.error(errors)
  process.exitCode = 1
} else {
  console.log(`${files.length} documents: links and two README bilingual structures passed. This does not replace doc-sync or the required pairing records.`)
}
