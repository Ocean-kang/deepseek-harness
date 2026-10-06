/** Exercise the same manifest admission used by profile loading and plugin installation. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'

const manifest = z.object({ name: z.string(), version: z.string(), peerDependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
const runtime = '0.2.1-alpha.1'
const peers = Object.fromEntries(Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')))

it('admits the memory package on the supported DSH runtime without an exemption', () => {
  expect(getDshRuntimeVersion()).toBe(runtime)
  expect(Object.keys(peers)).toHaveLength(12)
  expect(Object.values(peers).every(version => version === runtime)).toBe(true)
  expect(evaluatePluginCompatibility(manifest)).toBeUndefined()
})

it.each(['0.1.7-rc.2', '0.2.0-rc.2', '0.2.0-rc.3', '0.2.1-alpha.2', '0.2.1'])('rejects unsupported DSH %s without an exemption', runtime => {
  expect(evaluatePluginCompatibility(manifest, {}, runtime)).toMatchObject({
    name: manifest.name, version: manifest.version, runtimeVersion: runtime, exempted: false,
    peers,
  })
})
