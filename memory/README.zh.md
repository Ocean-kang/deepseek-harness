---
description: "配置 L0 事件副本与持久化 L1 任务发现，并检查提炼和恢复限制。"
kind: "package-reference"
---

# L0 与 L1 记忆

[English](README.md) | 中文

## 摘要

将完整的已记录 Session 事件保存在项目所属的 SQLite 中，并可选地从已结束的 turn 区间发现 L1 提炼任务。调用方可以读取具体记忆版本，检查待处理或失败的操作。L1 存储、提炼和重试组件已有目录内测试；自动模型提炼仍需接通 Session 请求日志。执行证据与未完成验收见[任务清单](Tasks.md)。

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
| `projectId` | 必填 | 稳定项目标识；patch 读取 `DSH_MEMORY_PROJECT`。 |
| `databasePath` | 必填 | `memory/` 内的 SQLite 文件；示例使用 `data/l0.sqlite`。 |
| `queueCapacity` | 1024 | 全部 Session 实时事件缓冲数量上限。 |
| `batchSize` | 128 | 每次采集事务的事件数量上限。 |
| `pageSize` | 128 | 每次来源恢复读取的事件数量上限，同时受批次大小限制。 |
| `busyTimeoutMs` | 5000 | SQLite 锁等待时间；零表示不等待。 |
| `journalMode` | `wal` | 可选 `wal`、`delete`、`truncate` 或 `persist`；同步模式为 FULL。 |
| `l1` | 不配置 | 可选提炼配置；目前只启用持久化任务发现。 |

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

配置 `l1` 后，插件报告 `memory/integration`，保留待处理任务，不发起模型请求。[扫描测试配置](tests/fixtures/l1-scan.patch.yml) 通过受支持的 profile 验证这一有限组合，不启用自动总结。通过 `ctx.memory.listTasks(project, after, limit)` 和 `getTask(project, operation)` 检查操作，通过 `getMemory(project, ref)` 读取具体版本。`rerunTask(project, operation, mode)` 使用 `retry` 重排失败或延迟任务，使用 `reextract` 按当前配置创建新操作。重新排队不会绕过缺少的 Session 日志接入。

`ctx.memory.appendRaw` 接收项目标识、来源 header、继承前缀长度和有序连续事件批次，允许与已存前缀重叠。JSON 值相同视为重复；项目、来源元数据或事件内容冲突会拒绝整个事务。空批次绑定来源元数据并返回当前前缀。写入只有在提交后才返回成功；提交后观察到的取消不撤销结果。

`ctx.memory.readRaw` 接收项目、Session ID、半开区间、页大小及可选的下一位置游标。结果包含事件值、下一页游标、已提交前缀和整个请求区间内的缺失范围。空游标表示没有更多已存分页，不表示请求区间完整。不存在的 Session 和其他项目的 Session 均不可见。数据损坏会报错，不会转为成功的空页。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>存储、恢复与生命周期</summary>

[SQLite Provider](src/sqlite.ts) 使用独立数据库标识和 schema 版本 2，通过事务升级 schema 1，不重写 L0 事件。事件主键为 `(session_id, seq)`。Session 元数据和下一个未提交位置与事件行在同一事务中更新。未知较新版本及其他数据库标识被拒绝。

[L1 存储](src/l1-store.ts) 扫描已提交的 L0 分页，将任务创建与扫描游标、未闭合 turn 状态一起提交。它跳过完全继承的 turn，保留在 fork 继承前缀之后结束的 turn。任务键包含项目、Session 区间、层级及已保存的提炼设置。配置变化影响新发现的 turn；显式重新提炼为已有逻辑记忆创建新操作。候选检查点先于记忆版本与任务完成状态的原子提交。操作查询用于处理提交结果不确定的情况，预期版本检查拒绝并发覆盖。历史版本仍可读取，并标记为已替代。

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

已加载插件不增加模型工具或注入记忆，目前也不发起提炼请求。独立测试的提炼器[提示词](src/l1-extractor.ts) 将事件文本视为不可信证据，区分实际执行与引用资料，并要求带来源的 JSON 总结。它保留不确定性，不将 turn 正常结束直接视为任务成功。L0 检查点失败可能导致调用方的持久化检查点失败；L1 扫描失败保留其游标并报告诊断，不撤销已经提交的 L0。

## Known Limitations and Deferred Work

- 仅接管插件启用期间载入的 Session，不扫描全部磁盘历史。
- 原日志丢失时无法恢复尚未复制的事件；已经复制的事件仍可读取。
- 队列容量按事件数计算，不按字节计算。单个大事件和恢复分页仍可能占用较多内存；必要时减小批次和分页大小。
- 来源服务级刷新可能报告其他 Session writer 的失败；恢复将该检查点失败视为错误。
- SQLite 调用是同步的，可能阻塞至配置的锁超时；更大的工作负载可能需要独立设计的 Worker Provider。
- 数据库持续增长；没有保留期限、附件备份、L2/L3、检索或索引。提炼器先将完整 turn 载入内存再划分请求；字节预算约束请求，不约束进程内存峰值。
- 自动 L1 提炼受阻于辅助 Session 事件登记，以及位于 `memory/` 外的必要持久化声明和录制会话证据。不会仅将请求记录在 SQLite，也不会伪装为普通用户 turn。真实 Provider 验证还需要凭据。
- 来源 Provider 替换需要另行执行 profile 生命周期测试；目录内测试不能替代必需的录制会话快照。
