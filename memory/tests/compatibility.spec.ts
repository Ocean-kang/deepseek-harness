/** Exercise the same manifest admission used by profile loading and plugin installation. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'

const manifest = z.object({ name: z.string(), version: z.string(), peerDependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))

it('admits the memory package on the supported DSH runtime without an exemption', () => {
  expect(getDshRuntimeVersion()).toBe('0.2.0-rc.2')
  expect(evaluatePluginCompatibility(manifest)).toBeUndefined()
  expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toBe('0.2.0-rc.2')
})

it.each(['0.1.7-rc.2', '0.2.0-rc.3'])('rejects unverified DSH %s without an exemption', runtime => {
  expect(evaluatePluginCompatibility(manifest, {}, runtime)).toMatchObject({
    name: manifest.name, version: manifest.version, runtimeVersion: runtime, exempted: false,
    peers: { '@deepseek-ai/dsh-agent-default-model': '0.2.0-rc.2' },
  })
})
