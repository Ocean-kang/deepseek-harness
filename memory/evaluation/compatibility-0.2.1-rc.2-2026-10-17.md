# Memory 0.1.15 与 DSH 0.2.1-rc.2 兼容性检查

本记录覆盖 Windows、Node 24.21.0 上独立 memory 插件的版本准入、源码回归、构建、隔离安装和 Web 面板打开。全部修改与验收输出位于 `memory/`，未修改日常 DSH home 或记忆数据库。安装及升级步骤见[随包说明](../distribution/README.zh.md)。

## 适配范围

Memory 0.1.15 的 14 项 DSH peer 精确声明 `0.2.1-rc.2`，无需 `allow-version` 豁免。原 0.1.14 声明 `0.2.1-alpha.2`，在当前运行时会被 profile 兼容性检查禁用。回归检查拒绝旧 alpha、相邻 rc 和未验证的正式版。

测试使用当前兼容性结果的 `requirements` 字段、JSONL 持久化插件的命名导出及 Connection 的 `browserPeer` 参数。启动测试同时加载 `profiles/chat-view.patch.yml`，覆盖用户的两份 patch 组合，并检查 memory 未被禁用。插件业务源码、SQLite schema 7 及插件拥有的 Session 字段没有变动。

## 已执行检查

以下命令从仓库根目录加载 `. ./memory/scripts/environment.ps1 -ProjectId 'compatibility-rc2'` 后在 `memory/` 执行。沙箱禁止文件硬链接和目录联接，并阻止隔离安装下载 pnpm；受影响命令依据实际错误在宿主重跑。

| 命令 | 结果 |
|---|---|
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable、存储 worker 和 Client 构建通过。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit` | 构建后检查通过，包含 Host 源码与测试。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit` | 构建后 Client 检查通过。 |
| `node --import tsx/esm scripts/test.mjs tests/compatibility.spec.ts tests/config.spec.ts tests/portable.spec.ts tests/profile-patches.spec.ts tests/plugin.spec.ts tests/injector.spec.ts tests/pipeline.spec.ts tests/panel-host.spec.ts tests/profile-copy.spec.ts tests/workspace.spec.ts tests/workspace-storage.spec.ts` | 宿主运行 94 项通过，1 项实际来源日志核对因未设置验收环境变量跳过。沙箱首轮有文件链接及本地 HTTP 检索失败。 |
| `node --import tsx/esm scripts/link-development-deps.mjs --runtime` | 现有运行依赖链接核对通过。 |
| `node --import tsx/esm scripts/test.mjs tests/profile-startup.spec.ts` | 宿主运行 2 项通过；默认及 panel overlay 均实际激活记忆服务、召回注入和面板 API，并完成进程退出及临时目录清理。 |
| `npm run pack:portable` | 生成 0.1.15 独立安装包。 |
| `node --import tsx/esm scripts/workspace-web-smoke.mjs` | 宿主运行成功，通过正式 `dsh plugin --profile web add` 安装 0.1.15，并启动隔离 Web profile；没有版本豁免或插件禁用警告。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing --evaluation compatibility-0.2.1-rc.2-2026-10-17.md` | 14 份文档链接及 6 对双语结构、物理行数和配对记录检查通过。文档脚本使用当前 `markdownLinkCache` 导出。 |
| `node ../node_modules/oxlint/bin/oxlint --config ../.oxlintrc.staged.json tests/compatibility.spec.ts tests/config.spec.ts tests/injector.spec.ts tests/panel-host.spec.ts tests/pipeline.spec.ts tests/plugin.spec.ts tests/portable.spec.ts tests/profile-copy.spec.ts tests/profile-startup.spec.ts tests/workspace-storage.spec.ts tests/workspace.spec.ts tests/fixtures/profile-startup.mjs scripts/check-docs.mjs` | 正常退出，无诊断。 |
| `git diff --check` | 通过。 |

## 浏览器验证

在隔离安装的实际 Web 页面中打开右侧栏“记忆”，面板显示“记忆资产”、当前项目、L0–L3 分类、搜索、导入与存储维护及下一轮待用区域，没有加载失败。截图见[记忆面板](../.artifacts/workspace-web-hn1eFh/frames/compatibility-rc2-panel.png)。安装与启动日志位于同一隔离运行目录。

## 限制

Web 验收使用空库和无密钥合成模型配置，本次未发送真实 Provider 请求，未重复完整学习、记忆选择后重启或长期质量实验。现有可靠性和质量记录保留其原版本范围；本次结果不扩展为未验证的 DSH、SDK 或跨平台兼容承诺。仓库级构建与文档生成未执行，独立插件规则要求所有写入限于 `memory/`。
