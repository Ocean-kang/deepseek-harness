---
description: "配置 L0 事件副本与持久化 L1 任务发现，并检查提炼和恢复限制。"
kind: "package-reference"
---

# 分层记忆

[English](README.md) | 中文

## 摘要

将完整的已记录 Session 事件保存在项目所属的 SQLite 中，并检查具体记忆版本及任务状态。开启 `autoLearning` 后，采集插件使用已加载的 DSH 模型服务，通过持久化辅助 Session 请求执行后台 L1/L2/L3 学习。明确选择的文本检索无需 embedding；向量检索作为可选替代模式。正式生产注入属于独立集成阶段。执行证据与未完成验收见[任务清单](Tasks.md)。

## 目录

- [使用插件](#use-this-plugin)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-plugin"></a>
## 使用插件

[源码 patch](profiles/headless.patch.yml) 在受支持的 headless profile 中加载插件，并使 runner 依赖已就绪的 `memory` 服务。[构建产物 patch](profiles/headless-built.patch.yml) 选择本地构建结果。这些 patch 不安装依赖。必须使用版本匹配、已经准备好的 DSH 检出；本目录的写入限制不允许执行根目录安装或构建。在 `memory/` 内运行 `node scripts/link-profile.mjs`，将插件目录注册给 profile 解析器。链接及其目标均位于 `memory/` 内，不会替换已有的其他条目。

使用明确、稳定的项目标识点入 [PowerShell 环境配置](scripts/environment.ps1)。它检查输出目录是否为链接，将 Harness home、缓存、临时路径和工作目录设在 `memory/` 内，并禁用遥测。它不启动应用；环境修改保留在当前 PowerShell 会话中。

```powershell
. .\memory\scripts\environment.ps1 -ProjectId 'my-project'
```

以下源码 profile 命令从 `memory/` 工作目录使用仓库已有的 `dsh` bin 和 ESM hook。它需要现有依赖及其运行产物，并要求在启动前检查输出路径。缺少模型凭据会导致任务失败，已经记录的事件仍会被复制；这不代表成功调用了模型。

```powershell
node --import tsx/esm ../apps/cli/src/bin.ts --profile headless --patch ./profiles/headless.patch.yml 'Reply with OK without using tools.'
```

配置在打开 SQLite 前解析。数据库相对路径以 `memory/` 为基准，不以调用目录为基准。数据库及其附属文件路径中存在链接时拒绝打开。目录必须由当前用户控制；路径检查不能阻止其他进程在检查和打开之间替换目录。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `projectId` | 必填 | 备用项目标识；patch 读取 `DSH_MEMORY_PROJECT`。 |
| `databasePath` | 必填 | `memory/` 内的 SQLite 文件；示例使用 `data/l0.sqlite`。 |
| `queueCapacity` | 1024 | 全部 Session 实时事件缓冲数量上限。 |
| `batchSize` | 128 | 每次采集事务的事件数量上限。 |
| `pageSize` | 128 | 每次来源恢复读取的事件数量上限，同时受批次大小限制。 |
| `learningConcurrency` | 2 | 独立流水线同时执行的项目处理数量上限。 |
| `learningQueueCapacity` | 128 | 等待项目顺序或并发容量的已接纳处理数量上限。 |
| `autoLearning` | false | 开启后台学习；要求 L1/knowledge 配置，并在插件条目的 inject 列表声明 `llm`。 |
| `textSearch` | 未配置 | 明确选择 BM25 文本检索，与 `embedding` 互斥。 |
| `busyTimeoutMs` | 5000 | SQLite 锁等待时间；零表示不等待。 |
| `journalMode` | `wal` | 可选 `wal`、`delete`、`truncate` 或 `persist`；同步模式为 FULL。 |
| `l1` | 不配置 | 可选提炼配置；启用任务发现，并为 `autoLearning` 提供 L1 设置。 |
| `knowledge` | 不配置 | 可选 L2/L3 模型与评分设置；由 `autoLearning` 控制模型派发。 |

自动采集保留 Session 已存储的项目归属。对于新 Session，插件通过可选的 Workspace 注册表解析 `SessionHeader.cwd`，使用 `workspace.id`。缺少注册表、cwd、目录或匹配的 Workspace 时使用 `projectId`；其他查询失败会拒绝采集，可在显式刷新时重试。归属在首次 L0 提交时固定，包括备用项目归属。创建、删除或重命名 Workspace 不迁移已有记忆。

Web profile patch 可以从启动工作目录设置必填的备用 `projectId`（从本目录启动时为 `memory`）。对于 cwd 匹配已注册 Workspace 的 Session，该备用值不决定 Memory 项目。验证 Web 归属时，在两个已注册的 Workspace 中分别创建新 Session，刷新 Session，然后将各自已存 header 的 `cwd` 与 Workspace 路径比较，并将 SQLite 中的 `sessions.project` 与对应 Workspace 的稳定 id 比较。两个项目 id 必须不同；已有 Session 即使 cwd 现在匹配 Workspace，仍保留先前存储的项目。

可选的 `l1` 对象要求明确填写 `provider` 和 `model`。其余字段统一解析后随任务保存：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInputBytes` | 65536 | 每次请求中系统文本及 JSON 输入的 UTF-8 字节预算。 |
| `maxOutputTokens` | 2048 | Provider 输出 token 上限。 |
| `timeoutMs` | 60000 | 一次辅助调用的记录及流式请求超时。 |
| `maxCalls` | 32 | 一个操作跨重试共享的持久化调用预算。 |
| `maxAttempts` | 3 | 停止自动重试前的总尝试次数。 |
| `retryBaseMs` | 1000 | 指数退避的初始延迟。 |
| `retryMaxMs` | 30000 | 最大重试延迟，不得小于 `retryBaseMs`。 |

配置 `l1` 且关闭 `autoLearning` 时，插件报告 `memory/integration`，保留待处理任务。[扫描测试配置](tests/fixtures/l1-scan.patch.yml) 验证这一仅采集组合。通过 [automatic.patch.yml](profiles/automatic.patch.yml) 开启后台学习；它从 `agentDefaultModel` 解析两类提炼模型，并使用已有模型适配器的凭据。L0 提交合并项目唤醒通知；采集刷新不等待模型调用。采集后，`ctx.memory.flushLearning(project, signal)` 等待当前到期工作；失败仍保留在任务状态中。通过 `ctx.memory.listTasks(project, after, limit)` 和 `getTask(project, operation)` 检查操作，通过 `getMemory(project, ref)` 读取具体版本。`rerunTask(project, operation, mode)` 使用 `retry` 重排失败或延迟任务，使用 `reextract` 按当前配置创建新操作。卸载先取消模型工作，再释放 SQLite；最终采集的来源可在重启后恢复。

`ctx.memory.appendRaw` 接收项目标识、来源 header、继承前缀长度和有序连续事件批次，允许与已存前缀重叠。JSON 值相同视为重复；项目、来源元数据或事件内容冲突会拒绝整个事务。空批次绑定来源元数据并返回当前前缀。写入只有在提交后才返回成功；提交后观察到的取消不撤销结果。

`ctx.memory.readRaw` 接收项目、Session ID、半开区间、页大小及可选的下一位置游标。结果包含事件值、下一页游标、已提交前缀和整个请求区间内的缺失范围。空游标表示没有更多已存分页，不表示请求区间完整。不存在的 Session 和其他项目的 Session 均不可见。数据损坏会报错，不会转为成功的空页。

<a id="understand-the-implementation"></a>
## 理解实现

### 长期知识

配置 `knowledge` 后，插件为每个当前 L1 版本排队一个 L2 任务，并为每个有支持证据的当前 L2 版本排队一个 L3 任务。启动时补排已有版本，本进程提交新版本后继续排队。同一任务幂等；其他进程的提交在重启后发现。开启 `autoLearning` 后，可恢复流水线在后台执行这些任务。

先通过 `resolveKnowledgeConfig` 解析明确的 provider/model 设置，再调用 `ctx.memory.consolidate(project, level, sourceRefs, spec)` 持久化 L2 或 L3 任务；排队不发起模型调用。通过 `getKnowledgeTask` / `listKnowledgeTasks` 检查任务，使用 `retryKnowledgeTask` 重排失败任务。`listCandidates(project, level, after, limit)` 返回有支持证据的当前记录，`invalidateMemory(project, ref, reason, operation)` 使所属项目的当前 L2/L3 失效。精确 `getMemory` 读取保留所属项目的历史；共享结果是带 `shared: true`、标题和正文的独立投影，不包含来源或生成元数据。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `scoreMin` / `scoreMax` | 0 / 5 | 整数闭区间，最大值不超过 100。 |
| `l2Threshold` / `l3Threshold` | 3 / 4 | 评分区间内按顺序排列的阈值。 |
| `promptVersion` | `knowledge-v2` | 随任务保存的固定实现版本；已有 v1 任务保留原提示词。 |

知识沿用上表的 L1 模型预算默认值。默认评分中，临时信息为 0–1，局部经验为 2，可复用方法为 3，稳定约束为 4，明确决策为 5。重要性不证明真实性：证据另分为 supported、unverified 和 conflict。低分不删除来源；冲突即使低于阈值也保留，避免旧事实继续进入候选。L3 只接受有支持证据的稳定类别。模型输入包含原始证据链；同一事件引用的重复摘要不能提供额外的成功证据。

[知识存储](src/knowledge-store.ts) 持久化具体来源版本、设置、已准备候选、尝试及调用次数和退避时间。同项目租约在不同连接间串行化聚合。版本冲突重新读取当前知识并丢弃过时候选，存储重试保留候选。`KnowledgeWorker.run` 显式执行一次到期尝试。持有持久化辅助请求记录器的调用方可通过 `watch(project, report)` 启用定时重试，排队后须调用 `notify()`；释放请求 Session 前须等待 `retire(project)` 完成。显式重试重置尝试次数，但保留操作整个生命周期的调用预算；模型设置变化创建不同操作。完整输入超预算时明确失败，不截断。必须先关闭全部 worker，再关闭 Provider。

[知识提炼器](src/knowledge-extractor.ts) 使用真实 LLM 服务，要求先等待 Session 请求记录器完成。开启 `autoLearning` 后，采集插件安装辅助 Session 记录器及 worker。独立开发也可使用下述流水线；受控 adapter 不证明真实 Provider 的质量。

组合交互式命令注册表后，`/memory-share show <id>@<revision>` 展示当前有支持证据的 L3 版本、撤回限制及五分钟有效的令牌。用户须在同一 Session 执行 `/memory-share approve <token>`；`/memory-share revoke <id>@<revision>` 停止后续共享。处理器先等待 Session 持久化，再以已记录的用户命令作为一次性回执提交指定版本的批准或撤回。未组合交互命令注册表时这些命令不可用。已加载记忆服务不向模型暴露批准方法或工具。替代、失效和撤回在同一事务中删除授权；跨项目读取只暴露获批投影。撤回无法清除其他 Session 已记录的内容或此前读取产生的派生内容。

### 独立开发

[MemoryPipeline](src/pipeline.ts) 组合现有 LLM、Session 和 SQLite 库，无需注册 DSH Agent 插件。调用方提供已配置的 LLM 服务、解析后的 L1/knowledge 设置、已打开的记忆数据库及完整来源事件批次。`learn(batch)` 提交 L0，并处理当前到期的 L1 → L2 → L3 任务。`flush(project, signal?)` 也可在数据库重开后恢复已存来源，无需持有实时来源 Session。`watch(project)` 执行启动恢复，并调度未来重试和后续记忆提交；新增 L0 输入仍通过 `learn` 或 `flush` 进入。`retire(project)` 停止后台调度，并等待该项目已排队的处理完成。未启用 watch 时，在已保存的退避结束后再次 flush 执行重试。须检查 L1 和知识任务状态：返回 L0 结果不代表所有模型任务成功。

```ts
import { MemoryPipeline, SqliteMemory, resolveConfig } from './src/index.ts'

const spec = await resolveConfig({
  projectId: 'my-project', databasePath: 'data/development.sqlite',
  l1: { provider: 'configured-provider', model: 'configured-model' },
  knowledge: { provider: 'configured-provider', model: 'configured-model' },
})
const memory = await SqliteMemory.open(spec)
const pipeline = new MemoryPipeline(memory, spec, llm, report)
try {
  await pipeline.learn(sourceBatch)
} finally {
  await pipeline.close()
  await memory.close()
}
```

`llm`、不抛异常的 `report` 回调及项目所属 `sourceBatch` 由调用方提供；此片段说明库的用法，不是应用启动器。可选的调用方所属 `MemoryRetriever` 使用同一数据库，启用 `pipeline.retrieve`。先关闭流水线，再关闭检索器和数据库。通过学习批次的 `signal` 取消单次学习，或关闭流水线取消全部学习；已提交来源和未完成任务仍可恢复。

[MemoryRequestJournal](src/request-journal.ts) 在派发前提交准确的 provider/model、提示、输入和输出预算，并在准备候选前保存返回的紧凑流。每次尝试在 L0 中拥有独立辅助 Session，包含 `memory/extraction-request` 和 `memory/extraction-result` 事件。事件信封带 `ignorable: true`，其他 Harness 读取方保留记录，但不派生普通 Agent 历史。不会创建虚假的 turn，也不改变原始来源 Session。缺少结束记录表示结果未知，不代表成功。这些事件使用现有 L0 表，数据库 schema 保持版本 4。`listSessions(project, after, limit)` 提供按所属项目过滤的元数据分页，`readRaw` 读取实际事件。

独立路径已有学习、查询与重启测试，L1 和 L2 定时重试、并发项目执行、请求和结果事务失败、取消、所属项目隔离测试，以及测试所属的预期输出文件。自动 overlay 接通采集到模型派发；生产注入、持久化登记、SDK 快照和一般真实模型效果仍属于未完成工作。

每个项目内部按序处理，项目之间共用配置的并发上限。学习队列满时，L0 采集后抛出 `backpressure`；之后调用 `flush` 可以恢复已保留的来源。已监听项目在容量释放后恢复。取消等待项目顺序或并发容量的处理会在模型调用及任务租约之前移除它，释放其队列容量，并保留后续处理的项目顺序。

按需运行真实 Provider 学习 smoke 时，先构建本包并链接本地 profile，再从 `memory/` 执行 `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/learning-live.patch.yml 'Validate automatic memory learning and text retrieval.'`。这个测试专用 overlay 用[学习夹具](tests/fixtures/learning-live.mjs)替代 headless runner，加载自动学习及文本检索，复用已选择的模型和凭据。YAML 显式限制尝试、调用次数、输出和超时。每次运行在独立的 `data/automatic-live-<uuid>.sqlite` 数据库中处理一条合成的长期约束，输出数据库路径和来源 Session，并请求启动器退出。它不安装生产注入，也不调用 embedding。`passed: true` 要求本次运行产生 L1、L2 和 L3 结果，并有文本检索命中；失败运行仍保留记录，不证明一般质量或检索效果。

设置 `DSH_MEMORY_VERIFY_LEARNING=1`，将 `DSH_MEMORY_VERIFY_LEARNING_SOURCE` 设为本次输出的准确 `sourceSession`，将 `DSH_MEMORY_VERIFY_LEARNING_DB` 设为该次运行的 memory 相对数据库路径，再执行 `node scripts/test.mjs learning-live`。此检查重开数据库，不再调用模型，验证保守的 L1 内容、明确约束、准确来源链及请求和结果记录。缺少运行标识或数据库路径时明确失败。

### 文本检索

设置 `textSearch: {}` 即可使用 SQLite FTS5/BM25，无需 embedding 模型、密钥或网络请求。结果标明 `method: 'bm25'`；条目带正值 BM25 `score` 和 `similarity: null`。向量结果标明 `method: 'vector'`。必须明确选择一种模式；任一模式的失败不会触发另一种模式。先移除私有记忆，再构建评分语料；返回及接纳前复查当前版本与批准。每次查询从 SQLite 记录构建并关闭有上限的内存语料，数据库 schema 保持版本 4。

文本默认值为 `tokenizer: unicode61`、`limit: 5`、`maxBytes: 8192`、`maxCandidates: 10000`、`pageSize: 128`、`timeoutMs: 5000`、`maxQueryBytes: 8192` 和 `maxTerms: 64`。超过查询或候选上限直接拒绝，不截断。查询将字母及数字连续串作为字面 OR 词项，用户文本不能注入 FTS 操作符。`unicode61` 匹配完整词；可选 `trigram` 匹配至少三个 Unicode 字符的子串，包括中文。两种分词器均不识别同义词，也不保证相关性。在分页间及同步 SQLite 排序后检查时限，不能中断单条原生语句。`getIndexStatus` 报告当前候选容量；`rebuildIndex` 没有需要重建的持久文本索引。

<a id="semantic-retrieval"></a>
### 语义检索

配置 `embedding` 后为当前记忆建立索引，并启用 `ctx.memory.retrieve`、`getIndexStatus` 和 `rebuildIndex`。未配置时，检索方法以 `config` 拒绝。必须显式提供完整 embeddings `endpoint`、与响应一致的 `model`、正整数 `dimensions` 和 `apiKeyEnv`。加载时指定环境变量必须含非空密钥。文本发送至该 endpoint，密钥不保存到 SQLite。此提供方独立于对话模型。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sendDimensions` | false | 是否发送可选的 dimensions 字段；始终校验响应维度。 |
| `batchSize` / `concurrency` | 16 / 1 | 索引批次大小与并行请求上限。 |
| `timeoutMs` / `maxAttempts` | 15000 / 3 | 单次 HTTP 超时及暂时性失败的总尝试次数。 |
| `retryBaseMs` / `retryMaxMs` | 500 / 5000 | 指数退避延迟范围。 |
| `retrievalTimeoutMs` | 5000 | 包含 HTTP 重试与扫描的查询时限。 |
| `limit` / `maxBytes` | 5 / 8192 | 结果数量及包含包装和引用的 UTF-8 字节预算。 |
| `threshold` | 0.65 | 最低余弦相似度，需按模型校准。 |
| `pageSize` / `maxCandidates` | 128 / 10000 | 候选分页大小与查询扫描上限。 |

`retrieve({ projectId, text, levels?, limit?, maxBytes?, signal? })` 返回 `hits`、最终渲染的 `text`、`scanned` 和 `elapsedMs`。结果包含固定版本、项目 ID、共享标记和相似度。省略层级时选择 L1/L2/L3。候选为当前有依据的知识和最新 L1；其他项目私有记忆在评分前排除。按相似度降序、Memory ID 升序排序。整条超过剩余字节预算时跳过，继续选择后续较小条目。空文本、无候选和无命中返回空结果；索引不完整则明确拒绝。

加载和本地记忆提交后触发索引。启动时补齐缺失向量，不重复已完成批次。endpoint、模型、维度或文本格式变化时选择独立空间。`getIndexStatus(project)` 检查项目完整性并报告扫描截断。缺少向量时查询以 `index-not-ready` 拒绝，候选过多以 `budget` 拒绝。索引失败产生诊断并保留状态；`rebuildIndex()` 等待 worker 后重建当前空间，调用方随后检查状态。其他连接不通知当前进程；重新加载或重建可以补齐其缺失向量。旧向量仍保留，不安装关键词回退。

独立 [Injector](src/injector.ts) 不由插件注册。测试组合委托 `agent/pre-step`，每 turn 检索已接受的用户文本一次，复查可见性，并让循环以 `user/message` 记录确切参考正文。恢复依据已提交日志，数据库变化不修改旧记录。参考不构成指令，也不唤醒 turn。最终可见性检查后已接受的内容无法撤回。生产启用需要目录外持久化声明、SDK 证据和录制会话场景。参见[评估记录](evaluation/task4.md)。

<details>
<summary>存储、恢复与生命周期</summary>

[SQLite Provider](src/sqlite.ts) 使用独立数据库标识和 schema 版本 4，通过事务升级 schema 1、2 或 3，不重写 L0 事件和 L1 版本。事件主键为 `(session_id, seq)`。Session 元数据和下一个未提交位置与事件行在同一事务中更新。未知较新版本及其他数据库标识被拒绝。

[L1 存储](src/l1-store.ts) 扫描已提交的 L0 分页，将任务创建与扫描游标、未闭合 turn 状态一起提交。启动时扫描所有已存储项目，包括未载入的 Session；采集和直接追加成功后扫描实际写入的项目。它跳过完全继承的 turn，保留在 fork 继承前缀之后结束的 turn。任务键包含项目、Session 区间、层级及已保存的提炼设置。配置变化影响新发现的 turn；显式重新提炼为已有逻辑记忆创建新操作。候选检查点先于记忆版本与任务完成状态的原子提交。操作查询用于处理提交结果不确定的情况，预期版本检查拒绝并发覆盖。历史版本仍可读取，并标记为已替代。

[提炼器](src/l1-extractor.ts) 要求先等待来源 Session 完整记录辅助请求，再调用现有 LLM 服务。目前没有生产日志记录器；单元测试使用记录器夹具、真实 LLM 服务及进程内 adapter。每个非空结果引用输入事件，并保留程序填写的 turn 结束原因。过长事件按 Unicode 码点边界分段提炼，再在请求和调用预算内合并。不能缩小的合并明确失败。非法 JSON、外来来源、不完整输出，以及把非正常结束的 turn 写成成功方案的结果均被拒绝。

[任务处理器](src/l1-worker.ts) 为后续负责日志记录的组合提供串行 `flush`、定时 `watch`、可等待的 `retire` 和支持取消的 `close`。它读取完整 L0 分页、保存校验后的候选并重试暂时性故障；候选已经持久化时不重复模型调用。调用计数先于 Provider I/O 提交，因此计数提交后发生崩溃，即使没有保存响应也可能消耗预算。显式重试保留操作及其调用计数；重新提炼获得新预算，并检查当前记忆版本。每次领取具有持续 `timeoutMs * maxCalls + retryMaxMs` 的持久化租约；重启后的 worker 等待租约过期，再领取崩溃进程遗留的任务。正常取消立即释放租约。数据库必须在全部 worker 结束后关闭。

[采集器](src/collector.ts) 通过[插件入口](src/index.ts) 安装。单一写入链对采集、显式检查点和清理排序。实时采集在延迟写入前分离完整事件。恢复通过 Session 持久化接口分批读取，不使用已弃用的同步历史读取方法。队列溢出保留所需目标位置并报告背压。写入失败后暂停该 Session 的自动处理，直到显式刷新或重新加载触发重试；没有周期重试定时器。

内存队列不持久化。SQLite 保存提交位置，原 Session 日志负责重启后的缺失事件。`session/flush` 等待捕获的目标范围，并在必要时补采。监听器调用持久化服务自己的刷新接口，不递归派发 Session 检查点。卸载移除监听、等待已接收工作、尝试最终补采，并在恢复失败时仍关闭 SQLite。诊断不包含事件正文，只报告失败类别和 Session 标识。

`node scripts/check-local.mjs` 无需外部依赖且不写文件，可检查 TypeScript 语法与配置，但不检查类型。本地 TypeScript 配置对插件和测试启用严格检查，同时引用 vendor 项目自己的编译配置及已有声明。测试入口直接导入配置，并关闭 Vite 的配置文件加载器，避免在祖先目录生成配置 bundle；缓存及覆盖率路径位于本目录内。完成环境配置后使用以下命令；构建输出为 `lib/index.mjs`，不会构建 peer 依赖。

```powershell
node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/test.mjs
node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native
node scripts/link-profile.mjs
node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml 'Reply with OK without using tools.'
```

设置 `DSH_MEMORY_VERIFY_COPY=1` 可启用可选的 `profile-copy` 测试，通过真实 JSONL 解码器比较 SQLite 和原日志。`DSH_MEMORY_VERIFY_DB` 指定 memory 相对路径的数据库，默认为 `data/l0.sqlite`。应紧接相应 profile 运行后执行比较；之后若活动被采集到其他数据库，原日志可能继续增长。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [Task 1 及验证记录](Tasks.md#task-1实现-l0-原始记忆)
- [分层记忆设计](PROJECT.md)
- [Session 持久化服务](../packages/session/session-persistence/README.zh.md)
- [DSH profile 组合](../packages/boot/app-boot/README.zh.md)

## Model Experience

已加载插件不增加模型工具或注入记忆。开启 `autoLearning` 后，辅助模型调用使用已有提供方及凭据，完整请求和返回流均写入日志。提炼器[提示词](src/l1-extractor.ts) 将事件文本视为不可信证据，区分实际执行与引用资料，并要求带来源的 JSON 总结。它保留不确定性，不将 turn 正常结束直接视为任务成功。L0 检查点失败可能导致调用方的持久化检查点失败；L1 扫描失败保留其游标并报告诊断，不撤销已经提交的 L0。

## Known Limitations and Deferred Work

- 仅接管插件启用期间载入的 Session，不扫描全部磁盘历史。
- 原日志丢失时无法恢复尚未复制的事件；已经复制的事件仍可读取。
- 队列容量按事件数计算，不按字节计算。单个大事件和恢复分页仍可能占用较多内存；必要时减小批次和分页大小。
- 来源服务级刷新可能报告其他 Session writer 的失败；恢复将该检查点失败视为错误。
- SQLite 调用是同步的，可能阻塞至配置的锁超时；更大的工作负载可能需要独立设计的 Worker Provider。
- 数据库持续增长；没有保留期限或附件备份。提炼器先将完整 turn 载入内存再划分请求；字节预算约束请求，不约束进程内存峰值。
- `autoLearning` 开启后台提炼，默认关闭。正式 DSH 集成仍需持久化审查和录制会话证据；真实模型使用 DSH 已配置的凭据。
- 来源 Provider 替换需要另行执行 profile 生命周期测试；目录内测试不能替代必需的录制会话快照。
