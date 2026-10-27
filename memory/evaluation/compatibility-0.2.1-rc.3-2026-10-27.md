# Memory 0.1.16 与 DSH 0.2.1-rc.3 适配检查

本记录覆盖 Windows、Node 24.21.0 上独立 memory 插件的版本声明、启动命令及面板缓存所有权修复。所有修改、构建和验收输出均位于 `memory/`。用户明确要求保留 DSH 根目录环境问题，未执行根目录安装或构建。本次结果不构成完整运行兼容性验收；安装与升级步骤见[随包说明](../distribution/README.zh.md)。

## 适配范围

Memory 0.1.16 的 14 项 DSH peer 精确声明 `0.2.1-rc.3`，版本准入无需 `allow-version` 豁免。兼容性测试拒绝旧 alpha、rc.2、相邻 rc 及未验证的正式版。Agent 测试显式加载新版原生工具执行器；直接工具调用使用批量输入、JSON 参数及逐调用结果。

README 的两种语言均使用 `node --import tsx/esm scripts/link-profile.mjs`，避免 Node 默认类型擦除间接加载含构造器参数属性的源码；学习验收命令同样显式加载 tsx。实际执行已成功创建 memory 所属 profile 的本地链接；沙箱首先返回目录联接 `EPERM`，相同命令在宿主重跑成功。

面板每次注册创建自己的闭包缓存，保留增量读取、并发串行化和容量限制；卸载停止路由、取消并等待请求结束后清空缓存。回归新增同一 memory 服务上的独立缓存检查，并通过受控 Promise 检查卸载等待及重新注册后的前缀重建。本次没有证实原实现存在内存泄漏或跨项目串数据。SQLite schema 7 与插件拥有的持久化字段未变。

## 已执行检查

命令在 `memory/` 内执行，预先加载 `. ./scripts/environment.ps1 -ProjectId 'compatibility-rc3'`，将临时文件、缓存和 DSH home 限制在本目录。

| 命令 | 结果 |
|---|---|
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable、存储 worker 和 Client 构建通过。 |
| `node --import tsx/esm scripts/link-development-deps.mjs --runtime` | 现有运行依赖链接核对通过；未安装依赖。 |
| `node --import tsx/esm scripts/link-profile.mjs` | 宿主执行通过。 |
| `node --import tsx/esm scripts/test.mjs tests/compatibility.spec.ts tests/profile-patches.spec.ts` | 13 项通过，覆盖 rc.3 版本准入、旧版拒绝及两种 Web patch 的 Connection 依赖。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit` | 受 DSH 环境阻塞；插件内旧工具接口的类型错误已消除，剩余 4 项错误均来自目录外。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit` | 最新插件构建后通过。 |
| `node --import tsx/esm scripts/test.mjs tests/compatibility.spec.ts tests/panel-host.spec.ts tests/injector.spec.ts tests/plugin.spec.ts tests/portable.spec.ts tests/workspace-storage.spec.ts` | 修复前基线：版本断言失败，另外 5 个测试文件因缺少 `@js-temporal/polyfill` 无法收集；不计为通过。 |
| `node scripts/pack.mjs` | 生成 `memory/.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.16.tgz`。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing --evaluation compatibility-0.2.1-rc.3-2026-10-27.md` | 14 份文档链接及 6 对双语结构、物理行数和配对记录检查通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config ../.oxlintrc.staged.json src/panel-host.ts tests/panel-host.spec.ts tests/compatibility.spec.ts tests/injector.spec.ts tests/pipeline.spec.ts tests/workspace-storage.spec.ts` | 正常退出，无诊断。 |
| `git diff --check` | 通过。 |

## 环境阻塞与未验证范围

当前 DSH 的 `packages/util/time` 缺少 `@js-temporal/polyfill` 依赖链接，源码测试无法导入时间模块。Host 类型检查还发现 Cordis 声明产物缺少源码已使用的 `Fiber.resolveConfig`、`rawConfig` 和 `effectiveConfig`，分别影响 `packages/boot/config-editor`、`packages/boot/hmr` 和 `packages/settings/settings`。这些问题需要在目录外补齐依赖及重新构建 DSH；本次按用户要求保留。

面板缓存回归、原生执行器集成、模型可见输出、持久化与重启、独立安装及实际 Web 交互尚未重新验收。未运行真实 Provider、仓库级构建或平台矩阵，不扩展历史验收记录的适用范围。环境准备完成后，先重新构建 DSH，再执行本次受阻的 Host 检查、相关源码测试和 `tests/profile-startup.spec.ts`，随后通过独立安装及 Web 流程确认记忆标签页、学习与下一轮召回。
