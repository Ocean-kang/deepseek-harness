# Task4 评估与验收记录

## 摘要

目录内实现提供明确选择的 FTS5/BM25 文本检索、真实 embeddings HTTP 适配器、schema 4 向量存储、受项目权限约束的检索，以及未在生产注册的 Injector。当前用户目标以独立后台整理和无需 embedding 的文本检索为本阶段范围，正式集成验收另行保留。真实单案例已跑通自动 L1/L2/L3 并命中文本结果；受控 adapter 和本地 HTTP 测试不证明真实语义质量或一般效果。Task4 完整集成保持未完成，默认 profile 不自动注入。

## 需求覆盖

| 需求 | 实现与证据 | 验收限制 |
|---|---|---|
| 明确文本模式 | [文本检索](../src/text-retrieval.ts)、[真实 FTS5 测试](../tests/text-retrieval.spec.ts)：BM25 排序、授权语料、更新、撤回、预算、取消、重开及中文 trigram；真实单案例已命中生成的 L3 | 属于当前独立阶段，不能识别同义词；每次查询重建有界内存语料，不报告语义效果 |
| 有序有效向量、配置与取消 | [适配器](../src/embedding.ts)、[协议测试](../tests/embedding.spec.ts)：乱序、缺项、重复索引、模型/维度不符、零向量、非有限数值、退避及真实 HTTP 超时 | 未配置真实 embedding endpoint、模型、维度和密钥 |
| 持久化、迁移和重建 | [向量存储](../src/vector-store.ts)、[检索测试](../tests/retrieval.spec.ts)：迁移回滚、写入回滚、重开、失败恢复及空间隔离 | 旧空间不自动清理 |
| 权限、排序和预算 | [Retriever](../src/retrieval.ts)：先筛选、稳定排序、完整条目预算、扫描上限、共享撤回、失效及并发版本变化 | 相似度阈值尚未按真实模型校准 |
| 正常日志与主任务降级 | [Injector 测试](../tests/injector.spec.ts)：真实 Agent、JSONL、请求正文一致、同 turn 多步骤、监听器重载、取消、索引失败及卸载 | 生产持久化声明、仓库录制快照和 SDK 证据未集成 |
| 历史参考不冒充新证据 | [L1 测试](../tests/l1-extractor.spec.ts) 检查来源与提炼指令，并保留受控结果的不确定性 | 不代表真实模型一定遵守指令 |
| 插件组合与产物 | [插件测试](../tests/plugin.spec.ts) 通过动态端口调用真实 fetch；构建 profile 返回 OK，L0 副本与原日志一致 | profile smoke 未开启自动提炼或注入 |
| 独立真实提炼 | [真实学习记录核验](../tests/learning-live.spec.ts) 重开单条明确约束的真实模型运行，验证 L1 保留未验证状态，L2/L3 内容与来源，以及完整请求和结果流 | 使用已有 deepseek-official/deepseek-flash，L1/L2/L3 各调用一次；不证明一般提炼质量，没有 embedding 或完整效果对照 |
| 效果与容量 | 下述合成容量实测及[固定任务集](task4-cases.json) | 完整对照实验受前置集成和 embedding 配置限制 |

## 容量实测

2026-09-27，Windows、Node v24.21.0，真实 SQLite，128 维确定性合成向量。每档预热一次后测量 20 次；扫描和检索分别计时。数据包含指定数量的 L2 候选及一个来源 L1；检索限定 L2。embedding 为进程内受控 adapter，不包含网络延迟。数据库大小按 SQLite 页数计算，包含来源、索引和元数据；堆增长为运行期间采样最大值与起始值之差，不是精确峰值或每条向量占用。

| L2 候选 | 扫描 p50 / p95（ms） | 检索 p50 / p95（ms） | 数据库字节 | 采样堆增长字节 |
|---|---|---|---|---|
| 100 | 5.57 / 9.07 | 6.29 / 11.15 | 307200 | 11999840 |
| 1000 | 60.54 / 64.81 | 61.32 / 66.48 | 1880064 | 36814880 |
| 10000 | 556.56 / 614.16 | 577.56 / 624.14 | 17555456 | 132071424 |

执行命令为加载目录内环境后设置 `DSH_MEMORY_BENCHMARK=1`，运行 `node scripts/test.mjs retrieval-capacity`。原始输出保存在忽略的 `memory/.artifacts/task4-capacity.json`，测试代码负责生成记录并验证实际扫描数。此测量不承诺其他维度、文本长度、平台或模型的性能；默认扫描上限为 10000，超过时明确失败。扩大上限前需要重新评估同步 SQLite 和向量数组的内存占用。

## 语义与任务效果

[真实 embedding 检查](../tests/embedding-live.spec.ts) 仅在 `DSH_MEMORY_LIVE_EMBEDDING=1` 时执行，并要求 `DSH_MEMORY_EMBEDDING_ENDPOINT`、`DSH_MEMORY_EMBEDDING_MODEL`、`DSH_MEMORY_EMBEDDING_DIMENSIONS`、`DSH_MEMORY_EMBEDDING_API_KEY`。它比较同义问题与无关文本的相似度，不替代 Retriever 及完整任务对照。本次未配置这些值，因此未执行真实语义验证，也未报告收益比例。

完整实验使用任务集中的七个场景，每组重复三次并交替执行顺序。两组使用相同学习材料、模型、提示版本、工具与任务预算；在新的提问 Session 中，对照组不读取跨 Session 记忆，实验组启用记忆。每次记录任务正确性、相关参考是否进入请求、完成率、步骤、输入输出 Token、提炼与 embedding 用量、检索延迟和成本。失败、中止及无结果均保留在分母中。未返回的用量和缺少单价的成本标为未知，不能记为零。模型和 embedding 配置在实际运行前固定并写入记录，不将当前合成测试视为已运行实验。

## 外部阻塞

仅允许写入 `memory/`。生产 `memory-recall` 来源需要更新 `docs/persistence-schema.json`、持久化目录与 `docs/persistence-changes/` 的变更记录；相关编译与读取程序必须纳入该来源声明。必需的跨 Session 命中、失败降级、批准及撤回回放归属 `snapshots/session/`。目录内已提供可信用户共享命令和带可忽略辅助 Session 事件的独立提炼流水线；独立组合可验证新 Session 请求含刚生成的记忆。正式 profile 集成仍需核对 TypeScript SDK 和 Python SDK 的对应预期。目录内 JSONL 组合测试不能替代这些正式验收证据；真实 embedding 和完整效果对照另需实际提供方配置。

完整命令记录与未执行项见 [Tasks.md](../Tasks.md#task-4实现记忆检索与注入)。
