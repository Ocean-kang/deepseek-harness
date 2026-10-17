---
description: "安装独立 DSH 记忆插件，为普通对话浏览或选择记忆。"
kind: "package-bundle"
---

# 独立记忆插件

[English](README.md) | 中文

## 摘要

浏览 L0–L3，选择 L2/L3 用于一轮对话，或开启 BM25 自动检索。后台学习复用 DSH 已配置的模型和凭据，无需 embedding 密钥。

## 目录

- [安装与使用](#install-and-use)
- [数据与配置](#data-and-configuration)
- [已知限制](#known-limitations)

<a id="install-and-use"></a>
## 安装与使用

Memory 0.1.15 面向 DSH 0.2.1-rc.2 的 Web profile，DSH peer 声明会拒绝其他运行版本。下载构建包并通过 DSH 安装，无需编译源码或修改 DSH 代码。

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.15.tgz
dsh --profile web
```

升级时停止 DSH，备份[记忆目录](#data-and-configuration)，包括 SQLite sidecar 文件。在相同 DSH home 中安装 0.1.15 并重启。数据库迁移到 schema 7；回滚需要备份。自定义调用方必须等待异步记忆操作并使用 trace 分页，遵循[可靠性升级指南](reliability-upgrade.md)。使用旧版 DSH（包括 0.2.1-alpha.2）的安装需先将 DSH 更新到 0.2.1-rc.2，无需 `allow-version` 豁免。源码 overlay 重新构建 `memory/lib`，以原有 patch 参数重启。从 memory 0.1.8 升级还需遵循[分层记忆指南](layered-upgrade.md)。

面板使用官方 Web `connection` 依赖和 `POST /api/memory/panel`。安装 0.1.15 后刷新已打开的浏览器标签页，使 Client 与 Host 使用相同 API。删除本地包含 `webRuntime` 的 `connection` 覆盖；它是插件 ID，不是服务。确认记忆标签页可以加载，且下一轮选择在刷新后保留。调用旧 `/memory/panel` 路由的自定义 Client 使用共享 API，RPC method 为 `memory/panel`。

在对话侧栏打开记忆。L1 展示任务目标、问题、结果和解决方案，trace 与来源默认折叠；L2 按场景组织可读知识卡；L3 区分工程知识和交互偏好。摘要随提炼生成。选择有效 L2/L3 供一轮使用；待用区和输入框展示正文及预算。新对话默认自动召回 L1–L3，已有显式开关保持原值。模型可通过只读 `memory_search` 补查。学习和召回保持独立。来源被替代或失效时暂停派生召回，精确历史仍可读。参见[分层记忆升级](layered-upgrade.md)。

重启后重新打开已采集的对话，可以浏览记忆、查看已接纳正文并保存下一轮选择。即使 Session 尚未加载，面板也增量读取 SQLite 中已捕获的 L0 前缀。这些操作不会启动 Agent、追加恢复标记或重复读取原 Session 日志。

在已绑定 Workspace 中打开历史导入，按创建时间筛选 Session，预览分页并选择要复制的来源。导入遵循 `autoLearning`：开启学习可能调用已配置模型，关闭学习只复制 L0。进度在重启后保留，重复导入去重，取消保留已提交数据和已排队学习。展开 L1 trace 可分页读取其完整 JSON 文本。清理预览展示已过期的完整 Session 和受保护数据；手动清理保留仍被引用的证据。自动清理需要配置 `retention.maxAgeDays`。需要将可复用数据库页归还文件系统时，使用显式压缩。

<a id="data-and-configuration"></a>
## 数据与配置

独立包通过已有 DSH 模型路由和凭据启用采集、后台学习及下一轮注入。新 `l1-v4` / `knowledge-v6` 任务在每个预算内提炼响应中生成可读字段与描述；大来源可能需要分组和合并。`supported` 仍是语义层面的模型判断；程序核验执行和可信确认具有独立证据状态。schema 7 保留已有记忆代次、导入进度、清理排除记录及 trace 分页，新增成功证据审计和持久增量索引。知识提炼排除完整 trace，并验证精确 L0 证据。

默认 `storageMode: workspace` 将项目 L0–L3 记录、历史版本、学习任务及待选记忆全部保存在 `<工作区>/memory_<工作区UUID>/memory.sqlite`。UUID 使用 DSH 已注册的 Workspace ID。同一工作区的对话共用该数据库。没有匹配 Workspace 的对话使用 `$DSH_HOME/memory/workspace-memory.sqlite`；未设置 `DSH_HOME` 时使用 `~/.dsh/memory/workspace-memory.sqlite`。备份前停止所有使用数据库的 DSH 进程，再复制完整目录，包括 SQLite 辅助文件。

首次使用将启用时间保存在全局记忆目录的 `workspace-storage.json` 中。自动采集接纳创建时间不早于该时间的对话。显式历史导入单独接纳所选旧 Session，不修改启用时间。已清理 Session 带有排除记录，防止自动恢复重新采集；显式导入可再次接纳。新建分支不提炼继承的轮次。重启会恢复项目内的学习任务，无需打开来源对话。旧集中数据库保持原样，不导入其记忆。

需要调整时，在 profile patch 中覆盖 `memory-l0` 条目。显式设置 `storageMode: central` 使用先前的单数据库行为，`dataRoot` 为绝对数据目录，`databasePath` 相对于该目录。工作区模式下，`dataRoot` 保存启用时间和无项目对话数据，`databasePath` 不决定项目数据库的位置。`autoLearning` 控制后台调用，`injection` 控制注入，`browser` 控制分页和正文预算。独立入口补齐未指定的值。工作区模式以 `workspace.id` 标识项目，无项目对话使用 `projectId`；`projectByPath` 仅用于集中模式。

SQLite 操作和持久增量 FTS 运行于有界存储 worker 池，`storageWorkers` 默认 4。`queueMaxBytes` 默认 8 MiB，`pageMaxBytes` 默认 256 KiB，`tracePageMaxBytes` 默认 64 KiB。数量限制仍生效；单个超大事件单独处理，采集缓存溢出时从来源日志恢复。`storageQueueCapacity` 默认 128 个请求，`storageQueueMaxBytes` 默认 8 MiB。未配置 `retention.maxAgeDays` 时自动清理关闭；已配置的 `retention.intervalMs` 默认 86400000。期限按最后事件时间计算，并保护当前知识、待用选择、未完成任务、活动 Session、授权版本及其完整证据和提炼请求日志。

工作区模式禁用 `/memory-share` 和跨项目召回。工作区目录失效或不可写、记忆路径被重定向、数据库打开失败时明确报错，保留原始 Session 日志供重试，不将项目数据转存全局目录。路径检查拒绝已有链接，但不能阻止其他进程并发替换目录。


Web 服务默认启用面板，`panel: false` 可关闭。BM25 默认 trigram，短中文词使用子串匹配。查询扩展默认关闭，显式开启 `textSearch.expandQuery` 后：未命中时，通过一次已记录的 L1 模型调用建议词项，再执行一次搜索。显式 `textSearch` 对象默认关闭扩展。面板在所选层级浏览，支持场景及知识/偏好筛选。可选 `embedding` 启用 BM25＋向量＋RRF，要求 `endpoint`、`model`、`dimensions`、`apiKeyEnv`；`hybrid` 控制排名和结果预算。单独 BM25 不需要 embedding 凭据。

<a id="known-limitations"></a>
## 已知限制

此独立包无需修改 DSH 源码。验收依据和录制 Session 预期输出保留在插件源码目录内；合成夹具及单条真实模型样例不证明一般记忆质量。其他操作系统及未测试的 DSH 或 SDK 版本尚未验证。自动采集跟随已加载 Session，显式历史导入读取当前 Workspace 的持久化来源。JSONL 冷读及单个超大事件仍可能超过插件分页预算。受保护证据可超过所配置期限，因此保留期限不构成固定磁盘容量上限。L0 保留附件和 spill 引用，不复制二进制文件。不提供 L4 或同步。
