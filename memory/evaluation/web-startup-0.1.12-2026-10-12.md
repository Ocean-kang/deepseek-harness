# Memory 0.1.12 与 DSH 0.2.1-alpha.2 Web 验收

本记录覆盖 Windows、Node 24.21.0 上独立插件的源码检查、两份实际 YAML 补丁启动、构建包安装、Web 交互、模型输入与 Session 日志，以及持久化重启。安装及验收使用隔离的 DSH home 和无密钥合成模型。升级步骤见[随包说明](../distribution/README.zh.md)。

## 修复与审查范围

删除 [cordis.patch.yml](../cordis.patch.yml) 和 [panel.patch.yml](../profiles/panel.patch.yml) 的 `connection` 覆盖。两份补丁保留官方 `inject: [webStartup]`；`web-runtime` 是插件 ID，不提供 `webRuntime` 服务。依赖 Connection 的上传、目录选择和会话控制通过同一条官方启动链激活。

实际启动还发现面板原来的 `connection.rpc.handle('/memory', ...)` 在 Connection Provider 上读取未声明的 `webServer`，导致面板子插件失败和 HTTP 405。面板改用 Connection 支持的共享 Fetch 注册，Client 同步调用 `/api`、method `memory/panel`；请求仍由官方认证及请求体预算约束。注册、取消、在途请求等待和缓存清理由插件生命周期持有。

审查追踪了 DSH 的 profile 解析与补丁组合、Cordis 服务注入、Connection RPC/Fetch/HTTP 桥接、Session 捕获与日志读取，以及 memory 的入口、工作区存储、L0 采集、L1–L3 学习、来源检查、选择消费、召回注入和面板订阅。修复不需要修改 DSH 源码；SQLite schema 和插件拥有的 Session 字段保持不变。没有把这次集成检查声明为整个 DSH 仓库所有功能的完整审计。

## 已执行检查

命令从 `memory/` 执行，并加载 `scripts/environment.ps1 -ProjectId memory-compatibility`。沙箱会阻止 Node 路径解析、本地监听和隔离 profile 安装；相应命令依据实际错误在宿主重试。Corepack、pnpm store、home、缓存和输出均使用插件目录中的路径。

| 检查 | 结果 |
|---|---|
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit` 和 Client 对应命令 | 均通过；更新测试回调的显式类型以适配当前 Vitest。 |
| `node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers 1 --reporter=json --outputFile=.artifacts/compatibility-tests-0.1.12.json` | 31 个文件，317 项通过、4 项跳过、0 项失败。 |
| 实际补丁的负向检查 | 临时恢复错误 Connection 覆盖时，补丁组合测试失败；恢复修复后通过。 |
| `profile-startup.spec.ts` | 通过正式 `dsh web` 启动两份 YAML 补丁；共享 API 可用，拒绝错误媒体类型、非法 JSON、非法 RPC envelope 和错误 method。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable 和 Client 构建通过。 |
| `npm run pack:portable` | 生成 0.1.12 包，14 个文件。 |
| `dsh plugin --profile web add <archive> --ignore-scripts --config.auto-install-peers=false --store-dir ./home/pnpm/store` | 隔离 Web profile 安装成功；没有版本豁免。 |
| `.tmp/verify-installed-0112.mjs` | 12 项 DSH peer 均为 `0.2.1-alpha.2`，13 个随包配置、构建及说明文件与当前源文件完全一致。 |
| 正式 `dsh web` 加载 `installed-delivery.patch.yml`，分别使用 `run`、`verify` 模式 | 学习、手动及自动召回、模型输入与 Session 日志、持久化重启均通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config ../.oxlintrc.staged.json src/panel-host.ts src/client/index.tsx tests vitest.config.ts` | 正常退出，无诊断。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing` | 双语结构、物理行数及配对记录通过；全目录链接检查仍有旧验收记录引用的本地归档缺失。 |

首轮完整测试以两个 worker 运行时，一项 Workspace 召回超时；单独复跑 10 项均通过。最终单 worker 的完整运行全部通过；没有降低断言或跳过该用例。修复了未等待的文件快照断言，独立测试配置限制并发并设置 30 秒 test/hook 预算。完整结果见[测试报告](../.artifacts/compatibility-tests-0.1.12.json)。

## 已安装包与浏览器证据

[安装包](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.12.tgz) SHA-256 为 `4c03cd870f7d7f5d2413a1e8abcfaebc437a41334631607e16033d1e274dee47`。[文件核对](../.artifacts/dsh-022-memory-0112/installed-files.json)、[运行证据](../.artifacts/dsh-022-memory-0112/delivery.json)与[重启证据](../.artifacts/dsh-022-memory-0112/delivery.json.verified-trigram.json)由插件目录持有。

已安装包从 100,565 字节原始 L0 证据生成 L1、L2 和 L3，最大单事件 60,074 字节；每次知识请求保持在 65,536 字节预算内，并通过分组检查和合并保存完整来源。手选只消费一次，下一轮无重复注入；自动召回连续两轮生效。实际模型请求中的记忆消息与持久化 `memory-recall` 事件一致。重启保留三个已核对版本、日志及自动开关，新增模型请求和召回均为零。

浏览器使用真实 Web profile、内置目录选择覆盖及合成模型。重启后打开先前会话，记忆标签页正常加载 L2 卡片；手选后显示 1 条、600/8192 字节，页面刷新保留选择。发送下一轮后待用数归零，面板和会话展示实际使用记忆。重复学习产生一个零调用的 `TARGET_CHANGED` 旧任务，表示已有目标版本变化后的安全阻止；当前新版本仍有效。浏览器静态壳显示旧构建标签，Host 实际使用当前检出的 DSH 0.2.1-alpha.2 源码。

## 限制

本次没有使用真实 Provider 或 embedding 凭据，合成模型不能证明一般记忆质量；跨平台矩阵和仓库级覆盖率未执行。旧验收文档引用的缺失本地材料仍影响全目录链接检查，本次修改文档单独核对。全部最终改动、新增文件和安装材料位于 `memory/`，未替换用户日常 profile 或修改其数据库。
