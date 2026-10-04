# 批量学习与侧栏验收

本记录对应独立 memory 0.1.7，运行环境为 DSH 0.2.0-rc.2 Web profile。源码、测试、缓存、安装 profile 和验收材料均位于 `memory/`。安装方法见[随包说明](../distribution/README.zh.md)。

## 行为与回归证据

| 问题 | 实现与验证 |
|---|---|
| 同批知识任务耗尽冲突重试 | [知识 Worker](../tests/knowledge-worker.spec.ts)通过真实 LLM 服务顺序执行同批 4 条独立 L2、L3 任务；各层只调用模型 4 次，4 条全部 `done`，每条 `attempts=1`。取得项目租约时刷新未准备的输入；已准备结果保持其原输入，提交期间发生真实更新仍拒绝发布。 |
| Workspace 注册表晚就绪漏恢复 | [工作区存储](../tests/workspace-storage.spec.ts)阻塞真实注册表的持久化列表读取，在 memory 激活后释放注册表；已有项目数据库无需重新加载即可恢复并生成 L1–L3。注册表依赖子插件的安装和卸载由 Cordis 管理。 |
| 卸载取消耗尽尝试次数 | Worker 检查 `maxAttempts=1`，在模型调用前或调用计费后卸载，取消均回退尝试次数并允许恢复；已经计费的模型调用保留。 |
| 失效手选阻止关闭自动召回 | [Browser](../tests/browser.spec.ts)、[Host](../tests/panel-host.spec.ts)与 [Client](../tests/panel.client.spec.tsx)检查独立偏好请求。关闭开关保留手选及消费收据，不依赖手选版本有效性；未保存勾选也保留。 |
| 集中存储的其他项目更新打断 BM25 | [文本检索](../tests/text-retrieval.spec.ts)在检索让出执行期间提交另一项目私有记忆，当前查询正常返回；本项目候选变化、共享授权新增或撤销仍产生冲突。变化时重新比较查询可见的候选全集，不修改持久化格式。 |
| arXiv 风格蓝色侧栏 | [面板样式](../src/client/MemoryPanel.module.css)使用 DeepSeek 蓝色刊头、衬线标题、编号条目、细分隔线与下划线层级导航。实际 Web 页面检查搜索、正文与来源、加入待用、自动召回开关、明暗主题和窄侧栏。 |

[批量 Session 预期](../tests/expected/knowledge-batch.json)由 [Pipeline 测试](../tests/pipeline.spec.ts)通过真实管线及请求日志生成；L2 与 L3 的模型输入依次包含 0、1、2、3 条已有知识，8 条任务全部首次完成。正式持久化的辅助 Session 请求与实际模型请求逐项核对。

## 已执行检查

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs tests/knowledge-worker.spec.ts tests/knowledge-store.spec.ts tests/workspace-storage.spec.ts tests/text-retrieval.spec.ts tests/browser.spec.ts tests/panel-host.spec.ts tests/panel.client.spec.tsx tests/pipeline.spec.ts tests/portable.spec.ts tests/injector.spec.ts` | 10 个相关文件、119 项通过。 |
| `pnpm exec tsc -p tsconfig.host.json --noEmit` 与 `pnpm exec tsc -p tsconfig.client.json --noEmit` | Host 与 Client 类型检查通过。 |
| `pnpm exec tsdown --config tsdown.config.ts --config-loader native` | 独立 Host、portable 入口与 Client 构建通过。 |
| `npm run pack:portable` | 0.1.7 tarball 生成，包含 12 个文件；保留 0.1.6 历史包。 |
| 正式 `dsh plugin --profile web add` | 新隔离 profile 安装成功；版本为 0.1.7，5 个构建文件与 4 份说明逐字节一致。 |
| 正式 `dsh web` 的 installed-delivery 夹具 | 学习、单次手选消费、两轮自动召回和模型可见 Session 日志通过；随后重启保留历史与偏好，无额外模型请求。 |
| Client 适用 oxlint | `MemoryPanel.tsx`、`client/index.tsx` 零诊断；Host 与测试文件完整检查仍报告既有诊断，不表示全仓库 lint 通过。 |
| 最后的用例调整 | 4 个文件、52 项通过；Host 类型检查通过，批量 Session 文件快照已等待完成。 |
| `node --import tsx/esm scripts/check-docs.mjs` | 本目录文档链接与双语结构、物理行数和配对记录通过。 |
| `git diff --check` | 无空白错误。 |

检查通过 [environment.ps1](../scripts/environment.ps1)限制 home、缓存和临时路径；安装关闭生命周期脚本，pnpm store 位于本目录。没有修改根工作区依赖或创建提交、PR。模型为明确标注的 keyless 合成适配器，没有执行外部真实 API 质量评价。

## 包与运行材料

安装包为 [memory 0.1.7](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.7.tgz)，SHA-256 为 `21d7ca64ba5c63a6dbccde26446ed4ddeb403b3c1a64eb7f5fd77407ae8cc098`。实际安装 profile 位于 `.artifacts/batch-installed-home/profiles/web`；[运行记录](../.artifacts/batch-installed-delivery.json)与[重启记录](../.artifacts/batch-installed-delivery.json.verified-trigram.json)保留合成模型标识和完整日志位置。

浏览器通过支持的 Web profile、内置目录选择器 overlay 和隔离 Chrome 运行，使用当前构建；正式安装包另经上述 profile 夹具验证。截图包括[浅色列表](../.artifacts/workspace-web-brpIRZ/panel-light.png)、[正文与待用操作](../.artifacts/workspace-web-brpIRZ/panel-interaction.png)、[深色](../.artifacts/workspace-web-brpIRZ/panel-dark.png)和[窄侧栏](../.artifacts/workspace-web-brpIRZ/panel-narrow.png)。[界面检查记录](../.artifacts/workspace-web-brpIRZ/panel-acceptance.json)确认侧栏宽度和内容宽度均为 343px、自动召回关闭，深色背景使用主题色。验收服务退出后，截图、数据库和日志仍在本目录。
