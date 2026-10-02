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

此 bundle 面向 DSH 0.2.0-rc.2 的 Web profile，DSH peer 声明会拒绝其他运行版本。下载构建包并通过 DSH 安装，无需编译源码或修改 DSH 代码。

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.5.tgz
dsh --profile web
```

打开对话，在右侧边栏选择“记忆”。浏览 L0–L3，查看具体正文、来源和历史版本。选择 L2/L3 并保存下一轮选择，参考正文提交到 Session 日志后消费该选择。每个对话默认关闭自动注入；打开开关并保存后使用 BM25。两条路径共用版本及权限检查、去重，以及默认五条和 8192 字节完整正文预算。一轮结束后重新读取面板，即可检查实际使用的记忆。

<a id="data-and-configuration"></a>
## 数据与配置

随包配置直接开启采集、后台学习和单轮注入，无需自定义 patch。插件加载时读取 DSH 默认模型。后台学习使用 DSH 已有凭据调用模型，自动检索本身不调用 embedding。

默认 `storageMode: workspace` 将项目 L0–L3 记录、历史版本、学习任务及待选记忆全部保存在 `<工作区>/memory_<工作区UUID>/memory.sqlite`。UUID 使用 DSH 已注册的 Workspace ID。同一工作区的对话共用该数据库。没有匹配 Workspace 的对话使用 `$DSH_HOME/memory/workspace-memory.sqlite`；未设置 `DSH_HOME` 时使用 `~/.dsh/memory/workspace-memory.sqlite`。备份前停止所有使用数据库的 DSH 进程，再复制完整目录，包括 SQLite 辅助文件。

首次使用将启用时间保存在全局记忆目录的 `workspace-storage.json` 中。只有创建时间不早于该时间的对话才采集及召回记忆。重新打开旧对话不会导入历史；请新建对话。新建分支不提炼继承的轮次。重启会恢复项目内的学习任务，无需打开来源对话。旧集中数据库保持原样，不导入其记忆。

需要调整时，在 profile patch 中覆盖 `memory-l0` 条目。显式设置 `storageMode: central` 使用先前的单数据库行为，`dataRoot` 为绝对数据目录，`databasePath` 相对于该目录。工作区模式下，`dataRoot` 保存启用时间和无项目对话数据，`databasePath` 不决定项目数据库的位置。`autoLearning` 控制后台调用，`injection` 控制注入，`browser` 控制分页和正文预算。独立入口补齐未指定的值。工作区模式以 `workspace.id` 标识项目，无项目对话使用 `projectId`；`projectByPath` 仅用于集中模式。

工作区模式禁用 `/memory-share` 和跨项目召回。工作区目录失效或不可写、记忆路径被重定向、数据库打开失败时明确报错，保留原始 Session 日志供重试，不将项目数据转存全局目录。路径检查拒绝已有链接，但不能阻止其他进程并发替换目录。


Web 服务可用时默认开启面板；`panel: false` 关闭其 RPC 注册。默认检索模式为 BM25。配置 `embedding` 会选择向量检索，不再补入 BM25；同时配置 `embedding` 和 `textSearch` 会被拒绝。向量检索须明确配置 `endpoint`、`model`、`dimensions` 和 `apiKeyEnv`，由指定的环境变量提供凭据。

<a id="known-limitations"></a>
## 已知限制

已用无密钥合成模型夹具在 Windows 验证安装、升级、重启、学习以及手选与自动注入。真实模型学习另有单条样例验证，两者都不证明一般记忆质量。其他操作系统和两套 SDK 投影尚未验证。只采集插件启用期间加载的 Session。不提供 L4、同步、保留策略或批量历史导入。
