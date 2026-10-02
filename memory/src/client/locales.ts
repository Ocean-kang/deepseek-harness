/** Typed memory-panel copy for both supported locales. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Chinese dictionary owns the key set. */
export const zh = {
  title: '记忆', description: '浏览 L0–L3，选择下一轮使用的记忆', search: '搜索记忆',
  excluded: '此对话创建于工作区记忆启用之前。请新建对话使用项目记忆。',
  empty: '暂无匹配记忆', retry: '重新读取', more: '加载更多', detail: '查看正文与来源',
  select: '用于下一轮', apply: '保存下一轮选择', cancel: '取消待注入选择',
  automatic: '自动检索记忆', selected: '已选择 {count} 条', pending: '待注入 {count} 条 · {bytes}/{maxBytes} 字节',
  unavailable: '当前配置仅保存待选记忆；普通对话注入尚未启用。',
  limit: '单轮最多 {limit} 条', stale: '待选记忆已更新或失效，请重新选择',
  failed: '无法读取或保存记忆，请重试', budget: '所选记忆超出数量或正文预算，请减少选择',
  source: '来源', history: '历史版本', shared: '已获批共享', project: '当前项目：{project}',
  older: '加载更早版本',
  used: '最近实际使用的记忆', turn: '第 {turn} 轮',
  active: '有效', superseded: '已替代', invalidated: '已失效', close: '关闭详情',
} as const
/** Dictionary key union. */
export type MemoryPanelKey = keyof typeof zh
/** English dictionary has exactly the same keys. */
export const en: Record<MemoryPanelKey, string> = {
  title: 'Memory', description: 'Browse L0–L3 and choose memory for the next turn', search: 'Search memory',
  excluded: 'This conversation predates workspace memory. Start a new conversation to use project memory.',
  empty: 'No matching memory', retry: 'Reload', more: 'Load more', detail: 'View text and sources',
  select: 'Use next turn', apply: 'Save next-turn selection', cancel: 'Cancel pending selection',
  automatic: 'Retrieve memory automatically', selected: '{count} selected', pending: '{count} pending · {bytes}/{maxBytes} bytes',
  unavailable: 'This configuration saves pending selections; conversation injection is not enabled yet.',
  limit: 'At most {limit} per turn', stale: 'Pending memory changed or became unavailable. Select it again.',
  failed: 'Could not read or save memory. Try again.', budget: 'Selection exceeds the count or text budget. Select fewer records.',
  source: 'Sources', history: 'Version history', shared: 'Approved sharing', project: 'Current project: {project}',
  older: 'Load older versions',
  used: 'Recently used memory', turn: 'Turn {turn}',
  active: 'Active', superseded: 'Superseded', invalidated: 'Invalidated', close: 'Close detail',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory browsing, selection and recall state. */
    memoryPanel: MemoryPanelKey
  }
}
