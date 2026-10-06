# Memory 0.1.9 与 DSH 0.2.1-alpha.1 兼容性验收

本记录覆盖 2026-10-06 Windows 上 memory 0.1.9 的版本准入、源码类型、构建包、正式 Web profile 和重启验证。模型为明确标注的 `memory-smoke/keyless` 合成适配器；没有执行真实 Provider 质量评估或跨平台检查。安装及升级步骤见[随包说明](../distribution/README.zh.md)。

## 原因与适配范围

Memory 0.1.8 的 11 项 DSH peer 均精确声明 `0.2.0-rc.2`，当前运行时为 `0.2.1-alpha.1`，正式准入函数因此禁用 `memory-l0`。旧兼容性测试也要求运行时为 `0.2.0-rc.2`，在当前检出中复现失败。Memory 0.1.9 的 11 项 peer 精确声明 `0.2.1-alpha.1`；[兼容性测试](../tests/compatibility.spec.ts)接纳当前运行时，并拒绝旧版、相邻预览版和正式版。没有使用版本豁免或修改 DSH 源码。插件实现、SQLite schema 和插件拥有的 Session 字段没有变化。

## 已执行检查

以下命令从 `memory/` 执行，先加载 [environment.ps1](../scripts/environment.ps1)。tsx 在沙箱中因 `uv_os_get_passwd / ENOMEM` 无法启动；相同的测试、文档、安装和 profile 命令在宿主运行通过。输出、缓存、安装 profile 和临时文件均位于 `memory/`。

| 命令或操作 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs` | 24 个文件通过、4 个文件条件跳过；294 项通过、4 项条件跳过。 |
| `node ../node_modules/typescript/lib/tsc.js -p tsconfig.host.json --noEmit` | Host 类型检查通过。 |
| `node ../node_modules/typescript/lib/tsc.js -p tsconfig.client.json --noEmit` | Client 类型检查通过。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable 和 Client 构建通过。 |
| `npm run pack:portable` | 生成含 12 个文件的 0.1.9 安装包。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing` | 目录内链接、双语结构、行数和配对记录通过。 |
| 正式 `dsh plugin --profile web add` | 安装本地 0.1.9 tarball，关闭安装脚本和自动安装 peer；profile 自动加入 memory bundle。 |
| 正式 `dsh web` 的 installed-delivery 夹具 | `run` 与重启后的 `verify` 均正常退出，未出现版本禁用诊断。 |
| 原 Web overlay 的实际浏览器检查 | 新对话完成，记忆标签页可用，L2 卡片可读，项目累计生成 3 条记忆。 |
| `git diff --check` | 无空白错误。 |

## 安装包与运行证据

安装包为 [deepseek-ai-dsh-memory-l0-0.1.9.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.9.tgz)，SHA-256 为 `07de22462368bb1fc2fddb95afbd29b3af19c9bc748c38ee6d2233df86656f74`。[安装文件核对](../.artifacts/dsh-021-memory-019/installed-files.json)确认安装后的版本、11 项 peer 及 11 个构建、配置和说明文件均匹配。隔离安装 profile 位于 `.artifacts/dsh-021-memory-019/home/profiles/web`，未改动用户正在使用的 home 或 profile。

[正式 profile 夹具](../tests/fixtures/installed-delivery.mjs)直接使用安装包提供的 memory 服务，不叠加源码或本地 lib 入口。[运行报告](../.artifacts/dsh-021-memory-019/delivery.json)验证 L1–L3 提炼、完整原文分组、描述生成、手选单次消费、两轮自动召回，以及模型输入与持久化召回消息一致。[重启报告](../.artifacts/dsh-021-memory-019/delivery.json.verified-trigram.json)确认三条精确版本、原日志前缀和自动召回偏好保留，重启新增模型请求与召回均为零。此重启检查使用新建的 0.1.9 数据；未对用户已有的数据库执行操作。

源码 overlay 通过 `workspace-web-smoke.mjs` 在独立 home 启动，使用与用户相同的 memory 与 chat-view patch，并加载合成模型和目录选择夹具。[浏览器截图](../.artifacts/dsh-021-memory-019/browser-memory.png)记录当前 DSH 版本、完成的对话和可用的记忆面板。此结果不代表真实模型的一般提炼质量，也不声明其他 DSH 或 SDK 版本兼容性。
