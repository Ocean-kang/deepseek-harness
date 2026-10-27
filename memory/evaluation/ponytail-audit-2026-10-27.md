# Memory Ponytail 审查与清理

本轮检查 `memory/` 的源码、测试及预期输出、脚本、profile、构建和编译配置、包声明、持久化声明及文档。判断依据是当前功能、真实调用链、公开接口和持久化恢复义务；删除范围仅为失效材料与可保持行为的冗余。继承本轮此前未提交的 rc.3 适配，全部改动仍位于 `memory/`。

## 精简结果

| 删除或简化 | 保留的能力与依据 |
|---|---|
| L1 投影 backfill 和旧 trace 读取的纯转发包装。 | 调用相同的静态 backfill 和旧 trace 分页实现；schema 1–7 迁移及原始数据保留。 |
| Workspace 路径值副本改为绑定项目集合。 | 原 Map 只读取 `has(project)`；实际工作区路径仍传给数据库初始化。 |
| 清理流程重复的祖先依赖遍历。 | 复用同函数的 `dependsOnRemoved`，保留有效祖先、删除退役后代及 tombstone。 |
| 旧知识提炼中对相同输入的再次准备和重复预算检查。 | 分组已经以相同必要记录检查预算；旧提示词、目标复核和合并仍保留。 |
| `memory_search` 的重复层级枚举校验和逐项复制。 | `defineTool` 在业务执行前验证枚举；未知字段、权限、业务预算及来源二次复核仍保留。 |
| 两份 Playwright 命令驱动合并到 [web-acceptance.mjs](../scripts/web-acceptance.mjs)。 | 保留合成和真实模型运行、全部操作、工具展开、截图、录屏、开关断言及固定来源的重启核对；删除重复的 `recall-web-browser.mjs`。 |
| 删除绑定 0.1.14 固定演示的 `audit-web-demo.mjs`。 | 当前安装及模型日志核对由 installed-delivery 夹具持有；原始演示证据文件保留。 |
| 删除两份无入站引用的 alpha.1/alpha.2 兼容性报告。 | 目标版本的兼容性测试、rc.2 完整运行基线及 rc.3 适配记录保留；持久化和质量实验历史保留。 |
| 清理 226 个旧探针、临时提交脚本、未引用日志和生成文件，以及 136 个目录联接入口，释放 4,125,616 字节。 | 所有路径限定 `.tmp/`；先 unlink 联接，再删除已确认只有编译产物的副本。目标依赖、用户数据库和有效验收材料保留；[清单](../.artifacts/ponytail-cleanup-2026-10-27.json)记录路径与 SHA-256。 |

未发现可在保留全部功能的前提下删除的完整生产模块。中央与工作区存储、独立 Worker 调度、文本／向量／混合检索、查询扩展、共享审批、历史导入、保留清理、来源复核及面板各类状态均有独立职责。旧任务提示词、展示生成和旧 trace 读取仍服务持久化数据，不能因名称旧而删除。持久化字段、schema 及模型可见输出未变。

审查还修复两个开发流程的失效调用：测试入口复用 Vitest `parseCLI`，使 `-t` 不再被当成文件名；真实学习夹具的两次 `listTasks` 和一次 `byOperation` 补齐异步等待。保留测试体，只纠正文本检索测试中“没有持久索引”的过时标题。

六份历史报告原先存在 40 个缺失本地材料链接；现在标明材料缺失并保留原路径及历史结果。没有重建、伪造或将这些材料计入当前验证。

## 验证与限制

命令均在 `memory/` 执行，先加载 `scripts/environment.ps1 -ProjectId 'ponytail-audit'`（存储 smoke 使用 `ponytail-storage-audit`），将缓存、临时文件和输出限制在本目录。

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs tests/trace-streaming.spec.ts tests/workspace-storage.spec.ts tests/sqlite.spec.ts` | sqlite 与 trace-streaming 共 17 项通过；Workspace 文件被根目录缺少 `@js-temporal/polyfill` 阻止收集。 |
| `node --import tsx/esm scripts/test.mjs tests/knowledge-worker.spec.ts -t 'records obsolete targets\|pauses .*80 required\|reconciles repeated merge targets\|fails an oversized mandatory\|rejects oversized required related'` | 修改参数解析前实际运行完整 knowledge-worker 与 legacy-knowledge-tasks 两文件，46 项通过；不当作名称筛选证据。 |
| `node --import tsx/esm scripts/test.mjs tests/maintenance.spec.ts tests/quality-runner.spec.ts tests/compatibility.spec.ts tests/profile-patches.spec.ts tests/text-retrieval.spec.ts` | 5 文件、70 项通过。 |
| `node --import tsx/esm scripts/test.mjs tests/compatibility.spec.ts -t 'admits'` | 新参数解析仅运行 1 项，10 项按名称跳过。 |
| `node --import tsx/esm --input-type=module`，stdin 真实 SQLite 清理 smoke | 过期 L1→退役 L2→退役 L3 删除，有效另一支祖先保留，过期 Session 的 tombstone 保存。 |
| `node --import tsx/esm scripts/test.mjs tests/injector.spec.ts` | 根目录缺少 `@js-temporal/polyfill`，执行 0 项。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable、worker 与 Client 构建通过。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit` | 最新构建后通过。Host 同命令使用 `tsconfig.host.json`，仍仅报告 4 项目录外依赖／声明错误。 |
| `node ../node_modules/oxlint/bin/oxlint --config ../.oxlintrc.staged.json src tests` 及修改脚本的 `node --check` | 通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config .tmp/memory-lint.json scripts/test.mjs scripts/web-acceptance.mjs tests/fixtures/learning-live.mjs` | JavaScript 基础检查通过；仓库 staged 配置排除 `.mjs`，不将其“没有匹配文件”的结果计为脚本 lint 通过。 |
| `node --import tsx/esm --input-type=module`，stdin 静态 DOM 浏览器驱动 smoke | 宿主 Chrome 在两种协议模式各执行 14 条命令，截图、开关断言、输入／勾选／键盘事件及退出核对通过；沙箱首轮网络被阻止。仅验证驱动协议，未调用模型、未启动 DSH、未测试视频；[报告](../.artifacts/ponytail-browser-driver-2026-10-27.json)。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing` | 全目录 29 份文档链接及 6 对双语结构、物理行数和配对记录通过。 |
| `node scripts/pack.mjs`、`git diff --check` | 打包和空白检查通过。 |

当前根目录缺少依赖链接且 Cordis 声明产物过期，按用户要求不执行目录外安装或构建。完整 Host 检查、面板／注入与 Workspace 集成、合并驱动的真实浏览器验收及真实 Provider 学习流程仍受限；语法、构建及局部回归不能替代这些验证。旧 [Ponytail 验收](ponytail-audit-2026-10-07.md)及各版本记录保留其原范围，不推断本次运行兼容性或性能改善。
