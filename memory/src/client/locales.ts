/** Typed memory-panel copy for both supported locales. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Chinese dictionary owns the key set. */
export const zh = {
  title: '记忆', description: '浏览 L0–L3，选择下一轮使用的记忆', search: '搜索记忆',
  excluded: '此对话创建于工作区记忆启用之前。请新建对话使用项目记忆。',
  empty: '暂无匹配记忆', retry: '刷新记忆', more: '加载更多', detail: '查看正文与来源',
  select: '选择记忆', apply: '加入下一轮', cancel: '清空待用记忆',
  selectRow: '选择记忆：{title}', applySelection: '将所选加入下一轮',
  selectionHelp: '勾选记忆前的选择框，再将所选加入下一轮；也可单条加入',
  readOnly: 'L0、L1 供查看和追溯来源；L2、L3 可选择加入下一轮',
  automatic: '自动检索记忆', selected: '已选择 {count} 条', pending: '待注入 {count} 条 · {bytes}/{maxBytes} 字节',
  unavailable: '当前配置仅保存待选记忆；普通对话注入尚未启用。',
  limit: '单轮最多 {limit} 条', stale: '待选记忆已更新或失效，请重新选择',
  failed: '无法读取或保存记忆，请重试', budget: '所选记忆超出数量或正文预算，请减少选择',
  source: '来源', history: '历史版本', shared: '已获批共享', project: '当前项目：{project}',
  older: '加载更早版本',
  used: '最近实际使用的记忆', turn: '第 {turn} 轮',
  active: '有效', superseded: '已替代', invalidated: '已失效', close: '关闭详情',
  L0: '对话与执行记录', L1: '主题、动作与结果', L2: '项目经验与约束', L3: '稳定原则与决策',
  conversation: '对话', execution: '执行', record: '记录', topic: '主题', actions: '动作', result: '结果', solution: '解决方法',
  experience: '经验与约束', principle: '原则与决策',
  extractionRequest: '记忆提炼请求', returned: '模型已返回（是否生成以提炼状态为准）', cancelled: '提炼调用已取消', threw: '提炼调用失败', recalled: '已送入模型的记忆正文',
  success: '成功', failure: '失败', incomplete: '未完成', unknown: '结果未知', noActions: '未记录动作',
  searchScope: '搜索查看：当前项目的 {level}（含获批共享记忆），按字面子串匹配',
  searchHelp: '搜索查看不会启用模型自动召回；自动召回按对话设置持续生效',
  searchMatches: '当前页 {count} 条 · 匹配“{query}”', rawMatch: '匹配原始记录中的文字',
  textHelp: '自动召回使用字面子串检索，支持短词；未命中时可由模型扩展查询，不等同于向量语义检索',
  pendingTitle: '下一轮待用', pendingHelp: '发送前请检查此区域。手选记忆送入模型上下文后只使用一次',
  usedHelp: '以下内容已实际送入模型上下文；不表示模型在回答中引用了每一条', remove: '移出待用',
  learning: '正在提炼 · {count} 个项目任务', learned: '项目累计已生成 {count} 条记忆',
  learningFailed: '提炼失败 · {count} 个项目任务', learningDisabled: '后台提炼未启用',
  needsReview: '待重新核实', reviewHelp: '来源已替代、失效或未获支持，已暂停召回；新来源可用后后台重新提炼',
  importance: '重要性 {score}（{min}–{max}）', evidence: '证据状态', rationale: '生成理由', generation: '生成模型',
  supported: '模型判断有来源支持', unverified: '未经核实', conflict: '证据冲突', trustHelp: '重要性评分不代表真实性或概率',
  evidenceHelp: '证据状态来自模型判断与引用校验；可从来源追溯核对原文',
  category: '类别', temporary: '临时信息', local: '局部经验', method: '可复用方法', constraint: '稳定约束', decision: '明确决策',
  raw: '原始 JSON', currentSources: '来源版本仍有效',
  unicodeHelp: '自动召回使用完整词匹配（unicode61）；中文局部词可能漏匹配，不支持语义检索',
  vectorHelp: '自动召回使用向量相似度检索；搜索查看仍按字面子串匹配', disabledHelp: '当前配置未启用模型记忆召回',
  applyRow: '加入下一轮：{title}', recallHelp: '记忆使用说明', sharedPrivacy: '共享记忆仅展示获批正文，私有来源、评分与生成信息不公开',
  beforeSend: '下一轮待用 {count} 条记忆 · {bytes}/{maxBytes} 字节', lastUsed: '第 {turn} 轮已送入模型上下文 {count} 条记忆',
} as const
/** Dictionary key union. */
export type MemoryPanelKey = keyof typeof zh
/** English dictionary has exactly the same keys. */
export const en: Record<MemoryPanelKey, string> = {
  title: 'Memory', description: 'Browse L0–L3 and choose memory for the next turn', search: 'Search memory',
  excluded: 'This conversation predates workspace memory. Start a new conversation to use project memory.',
  empty: 'No matching memory', retry: 'Reload', more: 'Load more', detail: 'View text and sources',
  select: 'Use next turn', apply: 'Save next-turn selection', cancel: 'Cancel pending selection',
  selectRow: 'Select memory: {title}', applySelection: 'Use selected next turn',
  selectionHelp: 'Check memory at the start of each row, then add the selection to the next turn. You can also add one row directly.',
  readOnly: 'L0 and L1 are available for reading and source tracing. Select L2 and L3 for the next turn.',
  automatic: 'Retrieve memory automatically', selected: '{count} selected', pending: '{count} pending · {bytes}/{maxBytes} bytes',
  unavailable: 'This configuration saves pending selections; conversation injection is not enabled yet.',
  limit: 'At most {limit} per turn', stale: 'Pending memory changed or became unavailable. Select it again.',
  failed: 'Could not read or save memory. Try again.', budget: 'Selection exceeds the count or text budget. Select fewer records.',
  source: 'Sources', history: 'Version history', shared: 'Approved sharing', project: 'Current project: {project}',
  older: 'Load older versions',
  used: 'Recently used memory', turn: 'Turn {turn}',
  active: 'Active', superseded: 'Superseded', invalidated: 'Invalidated', close: 'Close detail',
  L0: 'Conversation and execution', L1: 'Topics, actions and outcomes', L2: 'Project experience and constraints', L3: 'Stable principles and decisions',
  conversation: 'Conversation', execution: 'Execution', record: 'Record', topic: 'Topic', actions: 'Actions', result: 'Result', solution: 'Solution',
  experience: 'Experience and constraints', principle: 'Principles and decisions',
  extractionRequest: 'Memory extraction request', returned: 'Model returned (generation is tracked separately)', cancelled: 'Extraction call cancelled', threw: 'Extraction call failed', recalled: 'Memory text sent to the model',
  success: 'Succeeded', failure: 'Failed', incomplete: 'Incomplete', unknown: 'Unknown outcome', noActions: 'No actions recorded',
  searchScope: 'Search to view: {level} in this project (including approved shared memory), using literal substrings',
  searchHelp: 'Viewing search results does not enable model recall. Automatic recall persists per conversation.',
  searchMatches: '{count} on this page · matches “{query}”', rawMatch: 'Matches text in the raw record',
  textHelp: 'Automatic recall matches literal substrings, including short terms. A model may expand queries with no matches; this is not vector semantic search.',
  pendingTitle: 'Ready for the next turn', pendingHelp: 'Review this area before sending. Manual memory is used once after entering model context.',
  usedHelp: 'This content entered model context; the model may not cite every record in its answer.', remove: 'Remove from pending',
  learning: 'Extracting · {count} project tasks', learned: '{count} memory versions generated in this project',
  learningFailed: 'Extraction failed · {count} project tasks', learningDisabled: 'Background extraction is disabled',
  needsReview: 'Needs rechecking', reviewHelp: 'A source was replaced, retired or unsupported. Recall is paused; background extraction resumes when new sources are available.',
  importance: 'Importance {score} ({min}–{max})', evidence: 'Evidence status', rationale: 'Generation rationale', generation: 'Generation model',
  supported: 'Model judges sources supportive', unverified: 'Unverified', conflict: 'Conflicting evidence', trustHelp: 'Importance is not factual confidence or probability.',
  evidenceHelp: 'Evidence status combines model judgment and reference validation. Follow the sources to check the original text.',
  category: 'Category', temporary: 'Temporary information', local: 'Local experience', method: 'Reusable method', constraint: 'Stable constraint', decision: 'Explicit decision',
  raw: 'Raw JSON', currentSources: 'Source versions remain current',
  unicodeHelp: 'Automatic recall uses whole-word matching (unicode61); Chinese fragments may be missed. Semantic search is unavailable.',
  vectorHelp: 'Automatic recall uses vector similarity; viewing search results still uses literal substrings.', disabledHelp: 'Model memory recall is not configured.',
  applyRow: 'Use next turn: {title}', recallHelp: 'How memory is used', sharedPrivacy: 'Shared memory exposes approved text only; private sources, scores and generation metadata are withheld.',
  beforeSend: '{count} memories ready for the next turn · {bytes}/{maxBytes} bytes', lastUsed: '{count} memories entered model context in turn {turn}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory browsing, selection and recall state. */
    memoryPanel: MemoryPanelKey
  }
}
