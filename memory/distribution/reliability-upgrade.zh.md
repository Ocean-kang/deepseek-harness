---
kind: upgrade-guide
description: "升级记忆召回默认值、执行证据与持久文本索引。"
---

# 记忆可靠性升级

[English](reliability-upgrade.md) | 中文

## 变更

0.1.14 将 SQLite schema 6 升级至 7。执行证据要求所有显式成功字段一致：`success: true, exitCode: 1` 和 `success: false, exitCode: 0` 均不能建立执行成功证据。历史成功 L1 版本在原始工具记录通过 policy-2 审计前处于隔离状态。无效或缺失证据还会暂停派生召回与提炼；原始事件、摘要、版本及独立确认回执保持可用。

新对话自动召回 L1–L3。已保存的显式对话开关保持原值。`recall.automatic` 与 `recall.levels` 配置默认行为。安装 bundle 提供只读 `memory_search` 工具；直挂通过 `searchTool: true` 开启，并要求 tools 服务。查询扩展默认关闭，bundle 同样关闭；`textSearch.expandQuery: true` 显式开启额外模型调用。

新任务使用 `l1-v4` 和 `knowledge-v6`，保留显式用户声明而不宣称执行成功。已有任务保留已记录的提示词及预算。用户的规则声明可以支持约束；成功方法仍要求核验工具证据。通过任务 API 重新提炼旧空结果，才能应用新提示词。

文本检索使用按请求项目隔离的持久 FTS 语料。`textSearch.maxCandidates` 限制单次查询处理的匹配候选数，不再限制整个知识库条数。查询最高排名结果可以在超过该限制的知识库中成功；候选处理预算耗尽时明确报错。`indexTimeoutMs` 默认 60000，独立于在线查询超时，限制可恢复的索引同步。`browser.stateCacheSessions` 同时限制保留的过滤语料数；被淘汰的语料在再次请求时重建。`scanned` 统计已处理的匹配数。BM25 分数仅适合在本次语料内比较。

工作区存储最多使用 `storageWorkers` 个 worker，默认 4，同一数据库操作保持顺序。知识提炼先选择最多 `knowledge.maxExisting` 条既有候选，再读取完整内容，默认 64；`knowledge.maxSearchTerms` 默认 64。必需目标及直接来源关联候选不得静默遗漏。

## 迁移

1. 停止 DSH，备份每个记忆目录及 SQLite sidecar 文件。通过受支持的 profile 安装新版并重启。旧二进制无法打开 schema 7；回滚需要完整备份。
2. 设置 `recall: { automatic: false }`，可让没有保存偏好的对话继续显式开启召回，或通过 `recall.levels` 缩小召回层级。已保存的显式偏好优先。
3. 仅在需要额外模型调用时开启 `textSearch.expandQuery`，并配置 L1 模型及 LLM 服务。不提供 tools 服务的直挂组合保持 `searchTool: false`。
4. 等待初始证据审计及文本索引完成。中断的审计从已保存的结论继续；索引同步保留已完成分页。通过 `l1.executionAudit(project, ref)` 检查隔离版本。来源日志缺失时恢复证据；无效成功声明通过既有任务 API 显式重新提炼。
5. 更新解释 `scanned`、索引容量或 `maxCandidates` 的调用方。恢复日常使用前，确认当前版本检索、显式召回开关、共享撤销及重启恢复。容量测量及样本内质量结果以验收报告为准。
