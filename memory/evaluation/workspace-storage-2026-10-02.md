# 工作区记忆验收范围

本记录说明 memory 0.1.5 在 DSH 0.2.0-rc.2 上的目录内验收范围。当前配置、存储路径、失败语义和容量限制见 [README](../README.zh.md)，安装方式见[随包说明](../distribution/README.zh.md)。

## 验证依据

[工作区测试](../tests/workspace-storage.spec.ts)覆盖项目物理隔离、同项目复用、旧库保留、旧对话排除、重启恢复、版本与选择恢复、手选及自动召回、并发初始化、目录联接拒绝、分支继承排除和并发启用时间持久化。权限失败重试通过数据库打开错误注入验证，不修改 Windows ACL。[兼容性测试](../tests/compatibility.spec.ts)使用正式准入函数接纳目标 DSH 版本并拒绝未验证版本。

[目录内召回快照](../tests/expected/workspace-recall.json)记录手选及自动召回进入模型请求、异项目无召回和共享命令拒绝。[profile-copy 检查](../tests/profile-copy.spec.ts)通过生产 JSONL 解码器逐事件比较 L0 副本；[真实学习检查](../tests/learning-live.spec.ts)验证一条明确约束的 L1–L3 内容、来源链和辅助请求结算。这些检查不将合成结果或单条真实样例解释为一般记忆质量。

2026-10-03 的精简与清理后执行以下检查。测试使用目录内隔离数据；最终交付清除这些临时记忆。

| 检查 | 本轮结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs` | 22 个文件、196 项通过；真实 embedding、真实学习记录、profile-copy 和容量测量这 4 项显式启用的检查跳过。 |
| Host、Client 的 `tsc --noEmit` 与源码、测试 oxlint | 通过。 |
| tsdown 构建及 `npm run pack:portable` | Host、Client 和独立入口通过；安装包包含工作区动态模块。 |
| README 配对与局部文档检查 | 通过，不替代仓库级 doc-sync。 |

当前安装包解压到临时目录，通过受支持的 `dsh --profile headless` 和[固定模型夹具](../tests/fixtures/portable-web.mjs)验证集中模式及工作区模式的全局库。两个模式各完成 L1、L2、L3 提炼并命中 BM25；随后独立只读打开数据库，确认三层记录均已提交。工作区动态构建模块参与此检查，项目物理隔离由工作区测试覆盖。该无密钥检查不验证真实模型质量。

仓库级 `doc-sync` 包含会写入 `website/.generated/` 的构建，完整 lint 包含目录外依赖构建，因此遵守目录限制不运行这两项；本轮执行范围内 lint、两组 README 配对、6 份文档链接及双语结构检查。

## 数据与开发残留清理

删除过时的 `PROJECT.md`、`Tasks.md`、`evaluation/task4.md`、`evaluation/runtime-2026-10-02.md`、`evaluation/compatibility-0.2.0-rc.2.md` 和 `scripts/check-chat.mjs`，保留有效约定、当前验收依据及固定实验输入。首次清理移除 9,189 个旧运行文件，约 269 MiB，包括插件和 Memorix 数据库、SQLite 辅助文件、压缩会话、投影缓存、spill、截图、一次性诊断文件及旧打包暂存。

有效配置、凭据、工作区登记、依赖链接及固定测试输入保留。主配置与凭据、两个固定期望输出共 13 个文件的 SHA-256 在清理前后相同。测试和构建产物检查产生的临时数据库、会话、缓存及验证专用链接在交付前删除；只保留当前构建与新安装包。清理不访问目录外的项目数据库。

## Web 与质量验证

[Web 启动脚本](../scripts/workspace-web-smoke.mjs)通过受支持的 `dsh web` profile 和固定无密钥模型启动独立验收环境。已有 Windows 浏览器验收覆盖 L0–L3 浏览、历史版本、手选注入、BM25 自动召回、提交后消费选择、重启保留及两个工作区的数据库隔离。隔离依据数据库归属和记录身份，不能仅比较夹具生成的相同标题。

[固定手工实验输入](task4-cases.json)保留相同学习材料、模型和预算下的记忆开关对照协议；该实验尚未执行。真实 embedding 语义检查和容量测量由各自的显式开关启用；容量使用合成向量，不证明语义质量。

## 未验收范围

目录内 JSONL 组合检查及快照不替代正式持久化登记、`snapshots/session/` 录制回放或 TypeScript、Python SDK 投影。正式升级指南、仓库级 doc-sync、跨平台矩阵、一般真实模型质量和 Web 流程 GIF 尚未验收。SQLite schema 和既有 Session 字段格式保留，工作区模式不迁移或导入旧集中库。
