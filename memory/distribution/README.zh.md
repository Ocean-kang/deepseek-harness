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
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.8.tgz
dsh --profile web
```

打开对话后，在右侧栏选择记忆。新 L1–L3 卡片展示单独生成的一句话描述，详情保留完整内容、来源、评分、证据及折叠 JSON。勾选每条可用 L2/L3 卡片行首的选择框，再将所选记录加入下一轮。待用区及输入框展示保存的正文、数量和预算；召回提交后消费选择。自动召回默认关闭，开关独立持久化。两条路径均检查版本、祖先、权限及默认 5 条、8192 个渲染字节的预算。共享轮询保留搜索及阅读位置。发送后查看已提交的上下文记录。过期来源暂停召回，并由可用来源触发核查；历史仍可读。

重启后重新打开已采集的对话，可以浏览记忆、查看已接纳正文并保存下一轮选择。即使 Session 尚未加载，面板也增量读取 SQLite 中已捕获的 L0 前缀。这些操作不会启动 Agent、追加恢复标记或重复读取原 Session 日志。

<a id="data-and-configuration"></a>
## 数据与配置

随包配置直接开启采集、后台学习和下一轮注入，加载时读取 DSH 默认模型路径。新 L1–L3 记忆先提炼，再为每条最终记忆调用一次展示描述模型步骤，两者共用任务预算。新 L2/L3 提炼包含祖先引用的 L0 原文证据；`supported` 仍是模型判断及引用校验。旧版本仍可读。有预算的输入选择及来源分组避免仅因知识累积而失败；单条来源或原始事件无法容纳时仍明确报错。

默认 `storageMode: workspace` 将项目 L0–L3 记录、历史版本、学习任务及待选记忆全部保存在 `<工作区>/memory_<工作区UUID>/memory.sqlite`。UUID 使用 DSH 已注册的 Workspace ID。同一工作区的对话共用该数据库。没有匹配 Workspace 的对话使用 `$DSH_HOME/memory/workspace-memory.sqlite`；未设置 `DSH_HOME` 时使用 `~/.dsh/memory/workspace-memory.sqlite`。备份前停止所有使用数据库的 DSH 进程，再复制完整目录，包括 SQLite 辅助文件。

首次使用将启用时间保存在全局记忆目录的 `workspace-storage.json` 中。只有创建时间不早于该时间的对话才采集及召回记忆。重新打开旧对话不会导入历史；请新建对话。新建分支不提炼继承的轮次。重启会恢复项目内的学习任务，无需打开来源对话。旧集中数据库保持原样，不导入其记忆。

需要调整时，在 profile patch 中覆盖 `memory-l0` 条目。显式设置 `storageMode: central` 使用先前的单数据库行为，`dataRoot` 为绝对数据目录，`databasePath` 相对于该目录。工作区模式下，`dataRoot` 保存启用时间和无项目对话数据，`databasePath` 不决定项目数据库的位置。`autoLearning` 控制后台调用，`injection` 控制注入，`browser` 控制分页和正文预算。独立入口补齐未指定的值。工作区模式以 `workspace.id` 标识项目，无项目对话使用 `projectId`；`projectByPath` 仅用于集中模式。

工作区模式禁用 `/memory-share` 和跨项目召回。工作区目录失效或不可写、记忆路径被重定向、数据库打开失败时明确报错，保留原始 Session 日志供重试，不将项目数据转存全局目录。路径检查拒绝已有链接，但不能阻止其他进程并发替换目录。


Web 服务可用时启用面板；`panel: false` 关闭 RPC。bundle 使用 BM25 与 `trigram`：中文展开为三字 OR 词项，一字或两字词项使用字面子串匹配。独立入口默认开启 `textSearch.expandQuery`：文本无命中且有可用记录时，通过已有 L1 模型进行一次带日志的查询改写，再检索一次。模型只提供搜索词，不提供记忆事实；错误明确显示。设置 `expandQuery: false` 可只用文本召回，`expansionTimeoutMs` 调整默认 15000 ms 时限。显式 `textSearch` 对象保留直挂默认值，包括关闭扩展。参见[升级说明](./trigram-upgrade.zh.md)。面板搜索仍按单层进行字面浏览。`embedding` 选择向量检索，要求 `endpoint`、`model`、`dimensions` 和 `apiKeyEnv`；同时选择两种检索模式会被拒绝。

<a id="known-limitations"></a>
## 已知限制

此包是面向所声明 DSH 版本的独立插件，安装无需修改 DSH 源码。验收依据和录制 Session 预期输出保留在插件源码目录内。已用无密钥合成模型夹具在 Windows 验证安装、升级、重启、学习以及手选与自动注入。真实模型学习另有单条样例验证，两者都不证明一般记忆质量。其他操作系统及未测试的 DSH 或 SDK 版本尚未验证。只采集插件启用期间加载的 Session。不提供 L4、同步、保留策略或批量历史导入。
