/** Memory tab in DSH's existing right sidebar, over its existing authenticated connection. */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { FileTypeIcon, GuideArtworkFiles } from '@deepseek-ai/dsh-client-ui-primitives'
import { panelResponse } from '../panel-protocol.ts'
import { MemoryPanel } from './MemoryPanel.tsx'
import type { PanelCall } from './MemoryPanel.tsx'
import { PendingMemory } from './PendingMemory.tsx'
import { createPanelStateObserver } from './state-observer.ts'
import { en, zh } from './locales.ts'
import { cssText } from './MemoryPanel.module.css'

/** Browser services used by the memory tab. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']
const ID = '@deepseek-ai/dsh-memory-l0'
/** @param ctx - browser root context.
 * @returns effect-owned registrations for the dictionaries, tab and keyed body.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = cssText
    document.head.append(style)
    return () => { style.remove() }
  }, 'memory.panel.styles')
  const t = ctx.locale.bind('memoryPanel')
  const transport: PanelCall = async (request, signal) => {
    const result = await connection.rpc.call('/memory', 'panel', request, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.error.code)
    const response = panelResponse.parse(result.value)
    if (response.action !== request.action) throw new Error('protocol')
    return response
  }
  const { call, watch, refresh, dispose } = createPanelStateObserver(transport,
    (error) => { ctx.logger.error('Memory state subscriber failed', error) })
  ctx.effect(() => dispose, 'memory.panel.state')
  ctx.effect(() => ctx.locale.register('memoryPanel', { zh, en }), 'memory.panel.locale')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: 'memory', priority: 'extension',
    title: () => t('title'), guide: [{ id: 'memory', order: 15, title: () => t('title'), description: () => t('description'), icon: GuideArtworkFiles }],
  }), 'memory.panel.tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, locale: 'memoryPanel', inject: () => ({ call, watch, refresh }) }, MemoryPanel,
  )), 'memory.panel.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: ID }, ({ useTabInfo }) => <><FileTypeIcon kind="folder" size={16} />{useTabInfo().tab.title}</>,
  )), 'memory.panel.title')
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: ID, order: 10, locale: 'memoryPanel', inject: () => ({ watch }) }, PendingMemory,
  )), 'memory.composer.pending')
}
