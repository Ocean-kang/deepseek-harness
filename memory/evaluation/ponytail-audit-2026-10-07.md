# Memory 全量 Ponytail 审计验收

本记录覆盖 `memory/` 全部 41 个源码文件，以及开发脚本、profile、fixture、导出入口、编译配置与文档引用。审计沿真实注册和消费路径核实冗余，保留完整 L0–L3 功能、历史任务恢复、版本和证据链。分层功能及持久化字段见[分层验收](layered-memory-2026-10-07.md)。

## 精简结果

| 删除或合并 | 保留的行为 |
|---|---|
| L1 执行引用复用来源引用解析器，删除虚构 candidate 的递归解析和 trace 重复数组检查。 | 空、重复、额外字段及未授权引用继续拒绝；两种授权入口和 trace 类型有回归覆盖。 |
| 知识提炼删除程序附加核查记录后的重复整批解析，简化返回分支。 | 模型返回、完整候选批次、发布和持久化读取继续校验；核查记录由程序生成。 |
| 知识验证复用直接输入记录，合并方法和执行证据的成功祖先检查。 | 方法仍须成功祖先，v4 仍须程序验证的执行引用，缺失 ancestry 继续拒绝。 |
| HTTP embedding 删除重复索引集合，直接检查向量槽。 | 重复、缺失、乱序、越界索引及向量维数继续处理。 |
| BM25 删除被最终排序覆盖的 SQL 排序。 | 分数、具体 memory ID 和短词匹配的最终排序不变。 |
| 面板首页与续页复用相同查询字段。 | 层级、场景、类型、搜索和分页条件保持一致；焦点、取消和通知行为不变。 |

默认插件集成 fixture 同步 `l1-v3` / `knowledge-v4` 的结构化响应、三次常规调用和混合索引状态。请求日志恢复测试明确使用原有 `l1-v2`，继续验证历史两次调用及事务故障恢复。检索 JSDoc 明确 RRF 分数。

没有发现可删除的完整功能源码文件。历史提示词和描述生成仍用于旧任务恢复；`visual-summary.ts` 同时被当前 JSON 请求与查询扩展使用。独立 worker 接口、请求日志、租约、核查事件、可信回执、冲突历史、项目共享预算、持久选择、增量状态投影及二次来源校验均有消费者。安装与源码 profile、捕获专用 scan fixture、可选 Memorix 配置和开发依赖链接脚本仍有公开或文档入口。

删除 `.tmp/` 中四组已无文档或运行消费者的旧源码、构建和提交准备副本，以及本轮已完成的构建比较脚本，共 200 个临时文件、14 个目录联接入口；约 2.52 MB。[清理清单](../.artifacts/ponytail-cleanup.json)记录路径和大小。先删除联接入口，再检查普通目录树并清除副本；依赖目标、当前构建、用户数据库与安装验收材料保留。上述临时文件受 `.gitignore` 排除。

## 已执行检查

命令从 `memory/` 执行，先加载 `scripts/environment.ps1 -ProjectId 'memory-ponytail-audit'`。tsx 在沙箱内受 `uv_os_get_passwd / ENOMEM` 阻止，相关命令使用相同宿主执行方式重试；缓存、报告、安装与临时文件均在本目录。

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs`，修正旧集成预期后定向复跑 `tests/plugin.spec.ts` | 分批最终 25 文件、312 项通过；4 个显式启用的验收文件及 4 项跳过。 |
| `node --import tsx/esm scripts/test.mjs tests/knowledge-worker.spec.ts tests/knowledge-store.spec.ts tests/layered-memory.spec.ts tests/pipeline.spec.ts` | 4 文件、95 项通过。 |
| Host/Client `tsc --noEmit --noUnusedLocals --noUnusedParameters` | 两个编译配置通过，无未使用符号。 |
| 仓库 `.oxlintrc.staged.json` 检查全部改动及新增 TS/TSX/MJS | 通过，3 条既有 suppression 在非类型检查模式提示未使用。 |
| `.tmp/panel-lint.config.json` 检查改动的两个 Client 文件 | 零诊断。 |
| 仓库 `findUiI18nViolations` 检查函数 | 两个 Client 文件均通过文案归属检查。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable 与 Client 构建通过。 |
| `npm run pack:portable` 与正式 `dsh plugin --profile web add` | 全新隔离 profile 安装成功；安装脚本和自动 peer 关闭。 |
| 正式 Web profile 的 installed-delivery `run` 与 `verify` | 完整原文分组、三层学习、手选单次消费、两轮自动召回及模型日志一致；重启版本、偏好及日志前缀保留，新增模型请求和召回均为零。 |

最终包为 [deepseek-ai-dsh-memory-l0-0.1.10.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.10.tgz)，SHA-256 为 `68fcfc7122ef4f20e1e9429e30ec5899e4355485f0216607734b482fac344be6`。[安装文件核对](../.artifacts/dsh-021-memory-0110-audit/installed-files.json)确认 14 个文件逐字节一致；[运行](../.artifacts/dsh-021-memory-0110-audit/delivery.json)和[重启](../.artifacts/dsh-021-memory-0110-audit/delivery.json.verified-trigram.json)保留合成模型报告与 Session 日志。此前分层验收的归档包另行留存，原校验值和报告保持可核对。

本轮未改变界面展示或用户操作，既有宽窄窗口浏览器证据见[分层验收](layered-memory-2026-10-07.md#真实模型与浏览器)。没有重新调用真实模型或 embedding Provider；真实模型质量、固定质量实验、跨平台、暗色主题视觉和仓库级 doc-sync 均未由本轮合成回归推断。

## 提交检查范围

提交包含此次对话的全部分层改进与精简，暂存清单限定 `memory/`，分支为 `memory`。仓库通用 `verify-translation-pairing --cached` 拒绝独立插件的 `distribution/layered-upgrade.md`，因为它不属于仓库文档语料；对应钩子使用本目录既有 `check-docs.mjs`，核对 20 份文档及 4 组双语记录。第三方声明生成钩子会写入根目录，按目录限制改为 `gen-third-party-notices.ts --check`；只读核对通过。其他暂存 lint、空白和 vendor 检查保留；临时钩子配置保存在 `memory/.tmp/`，没有修改 Git 配置或仓库钩子文件。
