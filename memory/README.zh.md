---
description: "配置目录内的 L0 Session 事件副本、持久化检查点和恢复限制。"
kind: "package-reference"
---

# L0 记忆

[English](README.md) | 中文

## 摘要

L0 记忆将完整的已记录 Session 事件保存在独立、归属项目的 SQLite 数据库中。调用方可以按顺序读取事件范围并识别缺失尾部。恢复依赖原 Session 日志；附件和 spill 文件保留为引用。执行证据和未完成的验证记录在 [Task 1](Tasks.md#task-1实现-l0-原始记忆) 下。

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

`ctx.memory.appendRaw` 接收项目标识、来源 header、继承前缀长度和有序连续事件批次，允许与已存前缀重叠。JSON 值相同视为重复；项目、来源元数据或事件内容冲突会拒绝整个事务。空批次绑定来源元数据并返回当前前缀。写入只有在提交后才返回成功；提交后观察到的取消不撤销结果。

`ctx.memory.readRaw` 接收项目、Session ID、半开区间、页大小及可选的下一位置游标。结果包含事件值、下一页游标、已提交前缀和整个请求区间内的缺失范围。空游标表示没有更多已存分页，不表示请求区间完整。不存在的 Session 和其他项目的 Session 均不可见。数据损坏会报错，不会转为成功的空页。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>存储、恢复与生命周期</summary>

[SQLite Provider](src/sqlite.ts) 使用独立数据库标识和 schema 版本 1。事件主键为 `(session_id, seq)`。Session 元数据和下一个未提交位置与事件行在同一事务中更新。空库以事务初始化；其他数据库标识及不支持的版本被拒绝。目前没有旧记忆 schema 的迁移。

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

本插件不增加模型工具、提示词或注入记忆。它复制已记录事件及其附件引用，不进行语义总结。记忆检查点失败可能导致调用方的持久化检查点失败。

## Known Limitations and Deferred Work

- 仅接管插件启用期间载入的 Session，不扫描全部磁盘历史。
- 原日志丢失时无法恢复尚未复制的事件；已经复制的事件仍可读取。
- 队列容量按事件数计算，不按字节计算。单个大事件和恢复分页仍可能占用较多内存；必要时减小批次和分页大小。
- 来源服务级刷新可能报告其他 Session writer 的失败；恢复将该检查点失败视为错误。
- SQLite 调用是同步的，可能阻塞至配置的锁超时；更大的工作负载可能需要独立设计的 Worker Provider。
- 数据库持续增长；没有保留期限、附件备份、语义总结或索引。
- 来源 Provider 替换需要另行执行 profile 生命周期测试；目录内测试不能替代必需的录制会话快照。
