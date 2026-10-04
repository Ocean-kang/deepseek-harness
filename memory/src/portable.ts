/** Installable bundle entry: reuse the active DSH model and attach the panel when Web services exist. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply as installMemory } from './index.ts'
import type { Config as MemoryConfig } from './config.ts'
import { installPanelHost } from './panel-host.ts'

/** Durable storage and learning overrides; omitted routes use the current DSH default at load. */
export type Config = Partial<MemoryConfig>
/** Required services supplied by base-backed DSH profiles. */
export const inject = ['sessions', 'sessionPersistence', 'llm', 'agentDefaultModel']
/** @param ctx - owning profile context.
 * @param config - optional per-device overrides.
 * @returns readiness after capture, recall and background learning initialization.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const route = ctx.agentDefaultModel.currentSelection()
  await installMemory(ctx, {
    dataRoot: resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'memory'),
    databasePath: 'memory.sqlite', projectId: 'unassigned', projectByPath: true,
    storageMode: 'workspace',
    autoLearning: true, injection: true,
    ...(config.embedding === undefined ? { textSearch: { tokenizer: 'trigram' as const, expandQuery: true } } : {}),
    l1: { provider: route.provider, model: route.model, maxOutputTokens: 4096 },
    knowledge: { provider: route.provider, model: route.model, maxOutputTokens: 4096 },
    ...config, panel: false,
  })
  if (config.panel !== false) ctx.inject(['memory', 'connection', 'webServer'], panel => {
    panel.effect(() => installPanelHost(panel), 'memory.portable-panel')
  })
}
