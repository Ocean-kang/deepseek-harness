/** Compose the shipped Web layers with the actual memory overlays through app-boot. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

function read(path: string) {
  return loadOverlayPatches('memory-test', fileURLToPath(new URL(path, import.meta.url)))
}

const official = [read('../../packages/bundle/base/cordis.patch.yml'), read('../../packages/bundle/web-app/cordis.patch.yml')]
const baseline = composeEntries(official).find(entry => entry.id === 'connection')

for (const path of ['../cordis.patch.yml', '../profiles/panel.patch.yml']) {
  it(`preserves the official Connection startup dependency with ${path}`, () => {
    const warnings: string[] = []
    const entries = composeEntries([...official, read(path)], warning => warnings.push(warning))
    expect(warnings).toEqual([])
    expect(baseline).toBeDefined()
    expect(baseline?.inject).toEqual(['webStartup'])
    expect(entries.find(entry => entry.id === 'connection')).toEqual(baseline)
    expect(entries.filter(entry => entry.id === 'memory-l0')).toHaveLength(1)
    expect(entries.some(entry => entry.inject?.includes('webRuntime'))).toBe(false)
  })
}
