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

Memory 0.1.10 面向 DSH 0.2.1-alpha.1 的 Web profile，DSH peer 声明会拒绝其他运行版本。下载构建包并通过 DSH 安装，无需编译源码或修改 DSH 代码。

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.10.tgz
dsh --profile web
```

从 DSH 0.2.0-rc.2 上的 memory 0.1.8 升级时，停止 DSH，备份[记忆目录](#data-and-configuration)，将 DSH 更新到 0.2.1-alpha.1，再在相同 DSH home 中执行上述安装命令并重启。Memory 的 SQLite schema 和插件拥有的 Session 字段保持不变，无需 `allow-version` 豁免。使用源码 overlay 时，重新构建 `memory/lib`，以相同 patch 参数重启。Memory 0.1.8 仍用于 DSH 0.2.0-rc.2；不要在该运行时使用 memory 0.1.10。

在对话侧栏打开记忆。L1 展示任务目标、问题、结果和解决方案，trace 与来源默认折叠；L2 按场景组织可读知识卡；L3 区分工程知识和交互偏好。摘要随提炼生成。选择有效 L2/L3 供一轮使用；待用区和输入框展示正文及预算。自动召回默认关闭，开启后只搜索 L3。学习和召回保持独立。来源被替代或失效时暂停派生召回，精确历史仍可读。参见[分层记忆升级](layered-upgrade.zh.md)。

重启后重新打开已采集的对话，可以浏览记忆、查看已接纳正文并保存下一轮选择。即使 Session 尚未加载，面板也增量读取 SQLite 中已捕获的 L0 前缀。这些操作不会启动 Agent、追加恢复标记或重复读取原 Session 日志。

<a id="data-and-configuration"></a>
## 数据与配置

独立包通过已有 DSH 模型路由和凭据启用采集、后台学习及下一轮注入。新 `l1-v3` / `knowledge-v4` 任务在每个预算内提炼响应中生成可读字段与描述；大来源可能需要分组和合并。`supported` 仍是语义层面的模型判断；程序核验执行和可信确认具有独立证据状态。候选、任务检查点、来源引用和重启恢复继续持久化。SQLite schema 5 及已有代次完整保留；[升级指南](layered-upgrade.zh.md)说明新增可选 JSON 字段和提示词版本。

默认 `storageMode: workspace` 将项目 L0–L3 记录、历史版本、学习任务及待选记忆全部保存在 `<工作区>/memory_<工作区UUID>/memory.sqlite`。UUID 使用 DSH 已注册的 Workspace ID。同一工作区的对话共用该数据库。没有匹配 Workspace 的对话使用 `$DSH_HOME/memory/workspace-memory.sqlite`；未设置 `DSH_HOME` 时使用 `~/.dsh/memory/workspace-memory.sqlite`。备份前停止所有使用数据库的 DSH 进程，再复制完整目录，包括 SQLite 辅助文件。

首次使用将启用时间保存在全局记忆目录的 `workspace-storage.json` 中。只有创建时间不早于该时间的对话才采集及召回记忆。重新打开旧对话不会导入历史；请新建对话。新建分支不提炼继承的轮次。重启会恢复项目内的学习任务，无需打开来源对话。旧集中数据库保持原样，不导入其记忆。

需要调整时，在 profile patch 中覆盖 `memory-l0` 条目。显式设置 `storageMode: central` 使用先前的单数据库行为，`dataRoot` 为绝对数据目录，`databasePath` 相对于该目录。工作区模式下，`dataRoot` 保存启用时间和无项目对话数据，`databasePath` 不决定项目数据库的位置。`autoLearning` 控制后台调用，`injection` 控制注入，`browser` 控制分页和正文预算。独立入口补齐未指定的值。工作区模式以 `workspace.id` 标识项目，无项目对话使用 `projectId`；`projectByPath` 仅用于集中模式。

工作区模式禁用 `/memory-share` 和跨项目召回。工作区目录失效或不可写、记忆路径被重定向、数据库打开失败时明确报错，保留原始 Session 日志供重试，不将项目数据转存全局目录。路径检查拒绝已有链接，但不能阻止其他进程并发替换目录。


Web 服务默认启用面板，`panel: false` 可关闭。BM25 默认 trigram，短中文词使用子串匹配。独立入口的查询扩展仍可选：未命中时，通过一次已记录的 L1 模型调用建议词项，再执行一次搜索。显式 `textSearch` 对象默认关闭扩展。面板在所选层级浏览，支持场景及知识/偏好筛选。可选 `embedding` 启用 BM25＋向量＋RRF，要求 `endpoint`、`model`、`dimensions`、`apiKeyEnv`；`hybrid` 控制排名和结果预算。单独 BM25 不需要 embedding 凭据。

<a id="known-limitations"></a>
## 已知限制

此包是面向所声明 DSH 版本的独立插件，安装无需修改 DSH 源码。验收依据和录制 Session 预期输出保留在插件源码目录内。已用无密钥合成模型夹具在 Windows 验证安装、升级、重启、学习以及手选与自动注入。真实模型学习另有单条样例验证，两者都不证明一般记忆质量。其他操作系统及未测试的 DSH 或 SDK 版本尚未验证。只采集插件启用期间加载的 Session。不提供 L4、同步、保留策略或批量历史导入。
