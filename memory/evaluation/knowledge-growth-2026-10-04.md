# 知识增长与原文核查验收

本记录覆盖 [KnowledgeExtractor](../src/knowledge-extractor.ts)、[KnowledgeStore](../src/knowledge-store.ts)、[KnowledgeWorker](../src/knowledge-worker.ts) 与 [MemoryPipeline](../src/pipeline.ts) 的输入预算、分组聚合、原始证据和展示描述。模型使用通过真实 Harness LLM 服务接入的 keyless 合成适配器；没有执行真实 Provider 的语义质量评价。

## 行为证据

| 检查 | 观察结果 |
|---|---|
| 80 条已有 L2 或 L3 | [Worker 回归](../tests/knowledge-worker.spec.ts)分别构造完整输入超过 120 KiB 的默认 v3 L2、历史 v2 L3 任务。保存 `failed / budget / calls=0` 后显式重试，原任务完成；v3 调用提炼及展示各一次，v2 只调用提炼一次。模型输入受默认 65,536 字节预算约束，原有 80 条知识保留并增加第 81 条。 |
| 多个完整来源 | 三条较大的前一层记忆在 6,500 字节预算下进入三个独立请求。每条来源均被处理；前两次响应期间仍没有发布任何新知识，全部成功后一次提交。第二组返回无效 JSON 时，两组结果均不发布。 |
| 多组更新同一目标 | v2 与 v3 分别处理三个来源组及其共同目标；增加一次 `merge-target` 请求后，只发布原目标的一个新版本。v3 的合并请求仍携带四个去重后的原始 L0 事件；再执行一次展示描述，总调用数为 5。 |
| 精确核查目标 | 新建 recheck 任务保存精确 `recheck` 引用，该目标必须进入请求。过大的目标产生 `failed / budget / calls=0`，不会静默省略。目标在派发前换代时产生 `TARGET_CHANGED`，保留新版本并避免过期核查。 |
| 原始 L0 事件 | v3 的 L2、L3 请求均含祖先 L1 实际引用的 L0 事件及 Session/seq；原文按项目和事件位置精确读取。返回不匹配的 seq 时在记录及派发前失败，不退回摘要。单条原文无法容纳时明确失败，调用数为零。 |
| 单条记忆引用多份原文 | 实际 Web UI 验收库的一条 L1 引用了 11 个事件，完整事件 JSON 合计 69,833 字节，最大事件 26,234 字节；旧任务以 `knowledge-v3 / failed / budget / calls=0` 停止。[回归](../tests/knowledge-worker.spec.ts)按相同事件数量和主要容量构造独立合法 Session，保留全部引用。L2、L3 都把每个完整原文事件实际提供给核查请求，所有请求不超过 65,536 字节；全部段完成后调用 `merge-evidence`，再生成展示句，最终一次提交。后段返回无效 JSON 时没有发布前段结果。 |
| 分层合并 | 原文核查产生的多个候选总量超过 65,536 字节时，候选按完整正文分组归并，再合并归并结果；合并输入保留直接 MemoryRef 和已检查事件数量，不重复传输完整原文或事件列表。回归检查每个请求的系统提示词及文本总量均在预算内，最终保留所有 11 个已提供原文的引用。无法缩小下一层输入的合并会明确失败。 |
| 长祖先链 | 回归构造 18 条不同身份的 active L2 引用链，祖先正文合计超过 65,536 字节；v3 对直接记录正文和原文建模，完整祖先仍用于程序授权校验，L3 提炼及展示两次调用完成。另一次独立诊断使用 45 条 active L2：祖先 124,171 字节、唯一原文 215 字节，实际 v3 请求 5,307 字节并完成；同一输入的历史 v2 任务及显式重试均以零调用预算失败。 |
| 程序记录检查范围 | `examinedEvents` 保存实际提供给该任务核查步骤、且属于候选所引祖先 L1 的去重事件引用。模型输出此字段会被拒绝；持久读取拒绝空列表、非法 seq 或祖先以外的引用。重开后列表保留，共享 L3 投影仍只暴露标题及正文。非空 L3 recheck 同时核查旧目标与当前来源；提交删除失效祖先时一并删除其检查引用，新版本重开后只记录最终保留来源的已检查原文。 |
| 两阶段生成 | 提炼候选通过校验后，模型单独生成 `description`；展示请求只接收已验证的正文内容。L2、L3 各调用两次，描述重开数据库后仍可读取。描述响应无效时不发布已提炼的半成品。 |
| 调用预算 | v3 预留至少一次描述调用；候选数量确定后统一检查剩余描述预算。一个调用的总预算在派发前失败；两个调用的总预算产生两个候选时只完成一次提炼，零描述调用，且无发布结果。显式重试保留操作整个生命周期的已计费调用。 |
| 租约及并发 | 每次实际派发续期项目租约。注入时钟的回归在初始租约快到期时触发下一步，竞争 Worker 不能在旧到期时间抢占；空闲崩溃恢复仍使用单次请求时限及退避余量。 |
| 日志及重启 | [Pipeline 测试](../tests/pipeline.spec.ts)记录 L1–L3 的提炼与展示六个完整辅助 Session，各有请求和流结算；[层级预期](../tests/expected/layered-summary.json)检查阶段顺序与原文出现，重开后逐层保留描述。 |

## 已执行命令

以下命令从 `memory/` 执行。测试使用本目录的 Vitest 配置，缓存位于 `.cache/vite`；PowerShell 的 `TEMP`、`TMP` 指向本目录 `.tmp`，每个 SQLite 夹具使用独立临时目录并等待关闭后清理。TypeScript 配置为 `noEmit`，禁用 incremental。

| 命令 | 结果 |
|---|---|
| `node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/knowledge-worker.spec.ts tests/knowledge-store.spec.ts tests/pipeline.spec.ts tests/learning-live.spec.ts` | 3 个文件、81 项通过；真实 Provider 验证文件的 1 项 opt-in 测试跳过。包含上述预算、原文分段、层次合并、检查记录、非空 recheck、描述、租约和重启回归。 |
| `node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/knowledge-worker.spec.ts` | 去除提炼器非空断言后，42 项 Worker 行为测试通过。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --pretty false` | Host 类型检查通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config .tmp/panel-lint.config.json --tsconfig tsconfig.host.json src/visual-summary.ts src/query-expansion.ts src/knowledge-extractor.ts` | 三个新增模型流程文件使用共享的严格规则配置，零诊断。 |
| `node --import tsx/esm scripts/check-docs.mjs` | 文档链接检查运行；沙箱中 tsx 初始化因 `uv_os_get_passwd / ENOMEM` 失败，使用相同命令宿主升级重试后报告 README、升级说明的 3 个配对记录待刷新。随后主任务执行 `node --import tsx/esm scripts/check-docs.mjs --write-pairing`，13 份文档及 3 组双语检查通过。 |
| `git diff --check -- memory` | 无空白错误；Git 对部分既有 CRLF 文件给出后续转换为 LF 的提示。 |

## 容量与准确性限制

现有同层记录按来源身份与词项重合排序，再以直接记录正文和对应原文一起纳入剩余字节预算。v3 模型输入省略完整祖先正文、嵌套来源列表和历史检查列表；任务快照仍保存完整版本和祖先，用于精确原文读取、输出授权及乐观并发校验。未选记录保持存储，任务输出只能引用实际进入该次模型请求的直接版本；伪造对省略目标的更新会被拒绝。此选择仍可能遗漏低词项重合、同义改写或预算外的相关事实，不能保证每次核对全部历史矛盾。

所有新增来源均被处理，原文按完整事件分组，不截断事件内容。每段只允许依据已提供原文分类，摘要不能补足未见证据；所有段完成后的合并只使用此前已核查候选。候选总量过大时再分层合并，完整检查记录由程序去重保存。单个完整 L0 事件、必需的直接来源正文、精确 recheck 目标正文或单个合并候选无法装入预算时仍明确失败；合并不能缩小输入或总调用数超过剩余 `maxCalls` 时也不发布部分结果。真正耗尽 `maxCalls` 的任务不能通过重置尝试次数增加其生命周期预算。

`supported` 是模型基于提供的证据作出的分类，通过来源及结构校验后保存。v3 提供的是祖先 L1 已引用的原始 L0 事件，并非祖先全部对话、附件内容或外部世界的独立事实核验；事件里的声明与真实执行结果仍须由模型区分。分段任务的最终合并请求不同时重读全部原文；`examinedEvents` 记录前置请求实际收到哪些完整事件，不能作为独立事实证明。历史 v1/v2 任务保留原提示词，不补发原文核查或展示描述；有界已有记录选择可恢复其总量导致的预算失败，但超大单条来源或祖先链仍可能阻断，需采用当前 v3 配置创建新任务。

本次解决模型请求随既有记录总量增长而必然超预算的问题。存储仍为乐观并发比较保存全部同层版本引用，读取、相关度排序及任务快照大小仍随记录总量增长；没有声称数据库扫描、历史保留或任意长来源链具有常量成本，也没有执行大规模性能基准。
