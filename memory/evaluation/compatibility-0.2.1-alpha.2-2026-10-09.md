# Memory 0.1.11 与 DSH 0.2.1-alpha.2 兼容性检查

本记录覆盖 Windows、Node 24.21.0 上独立 memory 插件的版本准入、源码回归、构建与隔离安装。完整 Web profile 启动和实际浏览器验收被当前 DSH 检出的依赖缺失阻止，尚未完成；本记录不声明完整交付验收通过。升级步骤见[随包说明](../distribution/README.zh.md)。

## 适配范围

Memory 0.1.11 的 12 项 DSH peer 精确声明 `0.2.1-alpha.2`。兼容性检查接纳当前运行时，拒绝 `0.2.1-alpha.1`、相邻未验证预览版和正式版；没有版本豁免。插件实现、SQLite schema、已有任务和插件拥有的 Session 字段保持不变。旧版功能验收记录保留其原版本范围。

## 已执行检查

命令从 `memory/` 执行，并先加载 `scripts/environment.ps1 -ProjectId 'compatibility-022'`。沙箱中的路径检查发生 EPERM；受影响测试和安装使用相同命令在宿主重试，输出均限定在 `memory/`。初始 5 秒测试预算出现超时；临时运行器使用 30 秒 test/hook 预算和两个 worker。仍超时的 Workspace 召回及未启动的 Client worker分别单独复跑，没有改变断言或插件逻辑。

| 检查 | 结果 |
|---|---|
| `node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit` | 通过。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit` | 未通过：外部 DSH `webserver` 缺少 `ipaddr.js`，`working-directory` 缺少 `zod`；宿主重试确认相同缺失。 |
| `.tmp/compatibility-tests.mjs` 选择 compatibility、plugin、pipeline、portable、panel-host、injector、workspace-storage、request-journal | 70 项通过；Workspace 召回 1 项超时。 |
| 同一临时运行器单独选择 Workspace 召回用例 | 1 项通过，9 项因名称筛选跳过。 |
| `node --import tsx/esm scripts/test.mjs tests/panel.client.spec.tsx` | 25 项通过；首次合并运行的 Client worker未能及时启动。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable 和 Client 构建通过。 |
| `npm run pack:portable` | 生成含 14 个文件的 0.1.11 安装包。 |
| 正式 `dsh plugin --profile web add` | 隔离 profile 安装成功，自动启用 memory bundle；安装脚本和自动 peer 安装关闭。 |
| `.tmp/verify-installed.mjs` | 已安装版本、12 项 peer 和 13 个构建、配置及说明文件核对通过。 |
| `node scripts/workspace-web-smoke.mjs` | 宿主启动失败：DSH 自身 6 个插件导入失败，3 个必需插件未激活；实际 Web 交互和 profile 重启验收未执行。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing` | 双语结构、行数及配对记录更新；全目录链接检查因旧验收记录引用的本地归档缺失而未通过。 |
| `.tmp/check-compatibility-docs.mjs` | 本次修改的 5 份文档链接通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config ../.oxlintrc.staged.json tests/compatibility.spec.ts` | 正常退出，无诊断。 |
| `git diff --check` 与最终变更清单 | 无空白错误；所有改动及新增文件均在 `memory/`。 |

最终分批回归共 9 个文件、96 项通过，涵盖持久化、重启、L1–L3 学习、手选与自动召回及模型日志。它们使用无密钥合成模型，不代表真实 Provider 质量，也不能替代尚未完成的正式 Web profile 验收。

## 安装材料与限制

安装包为 [deepseek-ai-dsh-memory-l0-0.1.11.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.11.tgz)，SHA-256 为 `652a7b8e504b20b1301628b627bb6b5159a39acfc802f209269f4bb3f2dd629b`。[安装核对报告](../.artifacts/dsh-022-memory-0111/installed-files.json)与隔离 profile 位于 `.artifacts/dsh-022-memory-0111/`。没有安装到用户正在使用的 profile，也没有修改已有数据库。

完整启动的诊断保留在 `.artifacts/workspace-web-y7RDQa/home/logs/`。补齐 DSH 根目录依赖需要突破 [memory 目录写入限制](../AGENTS.md#文件操作范围)，已请求用户授权，尚未执行。真实模型、实际浏览器、正式 profile 重启、跨平台矩阵和仓库级 doc-sync 均未完成。
