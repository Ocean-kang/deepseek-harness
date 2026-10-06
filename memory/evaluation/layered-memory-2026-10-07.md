# Memory 0.1.10 分层记忆验收

本记录覆盖独立 `memory/` 插件在 Windows、Node 24.21.0 和 DSH 0.2.1-alpha.1 上的分层记忆改进。安装、构建、缓存、数据库、Session 日志和浏览器截图均位于本目录。没有修改 DSH 源码、工作区配置、锁文件或用户已有数据。升级操作见[随包指南](../distribution/layered-upgrade.zh.md)。

## 实现与持久化字段声明

L0 保留完整原始事件。L1 默认读取标题、目标、问题、结果、解决方案和总结，执行细节与证据折叠显示。L2 保存带场景的知识卡，包含结论、原因、适用条件、推荐做法与限制；L3 区分工程知识与交互偏好。自动召回只搜索 L3，显式浏览和检索保留其他层级，学习与召回开关独立。配置 embedding 后组合 BM25、向量排名和 RRF；无需 embedding 也可使用文本检索。

| 插件拥有的持久化类型 | 新字段或取值 | 兼容与验证 |
|---|---|---|
| `L1Summary` | 可选 `title/problem/summary/trace/executionEvidence` | 历史 JSON 无须补写；新任务使用 `l1-v3`。Trace 由程序采集；成功结果引用根据匹配的 L0 tool call/result 验证。 |
| `Knowledge` | 可选场景、知识卡字段、`kind/evidenceStatus/conflicts/confirmation` | 历史 `supported` 仅表示模型支持；新任务使用 `knowledge-v4`。用户或外部确认必须通过可信存储 API，学习任务不能提交确认回执。 |
| `KnowledgeCandidate` | 可选 `action`，新任务明确 store/update/merge/skip/conflict | 复用既有候选、任务、事务和精确版本引用。冲突保留前版本、候选、原因、来源及时间，暂停受影响的派生召回。 |
| `L1Spec/KnowledgeSpec` | 增加 `l1-v3/knowledge-v4` | 旧未完成任务继续使用保存的提示词版本和调用预算；新任务在提炼响应内生成展示字段。 |
| 共享记忆投影 | 可选 `scenario/kind` | 不公开私有证据、模型配置或 ancestry。 |

SQLite `SCHEMA_VERSION` 保持 5，未增加 SQL 格式代次；现有 JSON 读取器接纳可选字段。已有 `memory-recall` source 字段与 ignorable 提炼事件格式不变；请求和响应流继续通过 Session 日志重建。旧二进制不支持新提示词版本，回退必须恢复升级前的完整备份。DSH 源码集成时另行补齐正式持久化登记和 SDK 投影。本次独立插件的字段声明由此记录持有。

## 已执行检查

检查从 `memory/` 执行，加载 `scripts/environment.ps1 -ProjectId 'memory-layered'`。tsx 在沙箱内因 `uv_os_get_passwd / ENOMEM` 无法启动，对应测试、文档与 profile 命令使用相同主机执行方式重试；没有绕过产品沙箱或测试断言。

| 检查 | 结果 |
|---|---|
| `scripts/test.mjs` 的 17 个相关文件，随后定向重跑修复与新增行为 | 分批通过；覆盖 L1/知识 worker、存储、pipeline、配置、两种检索、注入、面板、工作区与兼容性。最终证据确认、失败 trace 与面板回归为 3 文件 64 项通过。 |
| `tests/workspace-storage.spec.ts` | 10 项通过；项目隔离、恢复、手选与自动模型输入断言保留，常规三层调用数为 3。 |
| `tests/learning-live.spec.ts`，显式指定本次真实运行数据库与 Session | 1 项通过；复开验证内容、精确来源、实际请求及响应日志，无额外模型调用。 |
| Host/Client `tsc --noEmit` | 两个编译配置通过。 |
| `.tmp/panel-lint.config.json` 检查改动的 Client 文件 | 零诊断。 |
| 仓库 `findUiI18nViolations` 检查函数 | 两个改动 Client 文件均通过文案归属检查。 |
| 仓库 `.oxlintrc.staged.json` 检查改动及新增 TS/TSX/MJS | 通过；3 条既有 suppression 在非类型检查模式下提示未使用。 |
| `tsdown --config tsdown.config.ts --config-loader native` | Host、portable 和 Client 构建通过；Client 保留 DSH 要求的加载格式。 |
| `npm run pack:portable` 与正式 `dsh plugin --profile web add` | 新隔离 profile 安装成功；安装生命周期脚本及自动 peer 关闭。 |
| 正式 Web profile 的 installed-delivery `run` 与 `verify` | 两次正常退出；完整原文分组、L1–L3、手选单次消费、两轮自动召回、模型日志和重启恢复通过。 |
| 旧 0.1.9 数据库复制件读取 | 三条原精确版本内容一致；原数据库 SHA-256 未变。 |
| 文档链接、四组双语结构、行数与配对记录 | 通过。 |
| `git diff --check` | 无空白错误。 |

本轮安装包留存为 [deepseek-ai-dsh-memory-l0-0.1.10-layered.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.10-layered.tgz)，SHA-256 为 `17fd032d8efba947f92fa7f1711bb54f1b10594955d38d715bfc111fe0b5c3cb`。[安装文件核对](../.artifacts/dsh-021-memory-0110-release/installed-files.json)确认 14 个文件逐字节一致；[运行](../.artifacts/dsh-021-memory-0110-release/delivery.json)、[重启](../.artifacts/dsh-021-memory-0110-release/delivery.json.verified-trigram.json)与[旧库读取](../.artifacts/dsh-021-memory-0110-release/old-reader.json)报告保留检查结果。验收模型为明确标注的 `memory-smoke/keyless` 合成适配器，原始输入、召回消息及模型请求保留在安装报告及 JSONL 中。精简后的交付包与检查见[全量审计验收](ponytail-audit-2026-10-07.md)。

## 真实模型与浏览器

真实 `deepseek-official/deepseek-flash` 使用既有 DSH 模型选择和凭据，通过支持的 headless profile 执行一次显式长期约束样本。L1、L2、L3 各 1 次调用、各生成 1 条记忆，无失败；BM25 命中 L3。结果保留“没有实施或测试执行”的限制，证据状态为 `model_supported`。数据库为 `data/automatic-live-3980ff1f-5b3c-4968-b45a-4e4b720ca43f.sqlite`，源 Session 为 `memory-live-source-02262870-fe4b-47ae-84dd-97951f01b4e9`。

实际 Web 使用支持的 `dsh web` profile、合成模型和规定的 in-page directory picker。浏览器验证 L1 详情、默认折叠的 trace/来源/JSON、L2 知识卡字段、跨层场景筛选及 L3 工程知识/交互偏好筛选。1100 像素视口并排展示，460 像素视口将详情排在列表之前；面板 `scrollWidth` 与 `clientWidth` 相等。截图为[宽面板](../.artifacts/workspace-web-3em1xk/layered-wide.jpg)和[窄面板](../.artifacts/workspace-web-3em1xk/layered-narrow.jpg)。

混合检索用确定性合成向量验证排名融合、场景与类型过滤、字节预算和未完成索引拒绝，没有调用真实 embedding Provider。真实模型仅执行一个约束样本，不代表一般提炼质量；固定质量实验、跨平台矩阵、暗色主题视觉和仓库级 doc-sync 未执行。人工/外部确认只有可信存储 API，未新增 UI 确认流程。未创建 PR，因此未录制 PR GIF。
