# DSH 分层记忆插件 Codex 实现任务清单

## 摘要

本文将分层记忆插件划分为四次 Codex 实现任务，依次交付 L0 原始记忆、L1 任务记忆、L2/L3 长期记忆和记忆检索与注入。每次任务包含本层能力的实现、测试和说明，以验收标准判断完成；详细设计见 [PROJECT.md](PROJECT.md)。原始完整集成任务保留未完成状态；当前阶段按用户调整，仅在 memory/ 内复用 DSH 模型、凭据及日志实现后台 L0 → L1 → L2 → L3 整理，提供无需 embedding 的文本检索，保留向量增强。正式持久化登记、生产注入及 SDK 验收留到集成阶段。`MemoryService` 为记忆插件服务，不是 DSH 核心 API。实际完成状态以验证记录为准。

## 目录

- [执行约定](#执行约定)
- [Task 1：实现 L0 原始记忆](#task-1实现-l0-原始记忆)
- [Task 2：实现 L1 任务记忆](#task-2实现-l1-任务记忆)
- [Task 3：实现 L2/L3 长期记忆](#task-3实现-l2l3-长期记忆)
- [Task 4：实现记忆检索与注入](#task-4实现记忆检索与注入)
- [开发备注](#开发备注)

## 执行约定

每个 Task 是一次交给 Codex 的完整实现任务，默认按编号执行，完成验收后再推进下一项。任务内的实现内容属于同一次交付，不拆成单独的学习或接口设计任务；阅读源码和核实扩展点是相应实现的前置步骤。完成记录附在对应任务下，包含产出链接、实际检查及结果、未验证项；仅有设计或代码不能勾选完成。每项实现同步维护目录内说明和必要 JSDoc，检查按 [测试规范](../docs/testing.md)选择。

遵循 [目录规则](AGENTS.md)：代码、配置、数据库、日志、缓存和临时文件都放在 `memory/` 内，执行命令前确认实际输出位置。需要修改目录外工作区配置、依赖、共享源码、快照或持久化声明时，列出路径和原因，将相关任务标为受阻，继续可独立完成的部分。不得用自建启动器绕过受支持的 `dsh` profile。本清单不授权自动执行全部开发任务。

## Task 1：实现 L0 原始记忆

- [ ] 完成 Task 1。

### 本次实现内容

- **加载记忆插件**：在 `memory/` 内实现记忆插件入口和所需 profile patch，复用已有依赖。确认 Harness home、构建、测试和运行输出均位于目录内，通过受支持的 profile 加载并退出；无法加载时记录具体依赖和阻塞。
- **定义 L0 和最小读写接口**：按 [分层与数据定义](PROJECT.md#分层与数据定义)保留完整事件，复用 Session 标识、序号和事件类型。定义 `MemoryService` 的 `appendRaw`、`readRaw` 输入输出，明确项目归属、分页与提交成功语义。为新增跨组件 ID 使用品牌类型；校验项目和数据库配置，在执行前解析为完整配置。
- **实现 SQLite Provider**：核实并复用现有 SQLite 能力，建立原始事件表和 Session/序号唯一约束。实现事务批量写入及按项目、Session、事件范围分页读取。增加单调 schema 版本和迁移检查，相同键相同内容去重，不同内容报冲突。
- **将事件采集接入存储**：核实事件写入与通知流程，通过 `ctx.on()` 订阅 `session/event` 并调用服务提交完整事件，不以打印日志作为数据源。建立有界写入队列，保持事件顺序；事务成功后才推进已提交位置。配置队列容量并报告背压或存储错误，禁止丢失事件后仍报告成功。
- **补采、刷新和重启恢复**：对已载入 Session 比较已提交位置，从原 Session 日志补采缺失事件。核实并接入可等待的刷新流程，卸载时停止接收并等待在途写入，再释放数据库。测试重复载入、重启补采和来源丢失，明确不可恢复范围。

### 依赖

无前置实现任务。先核实 [架构](../docs/architecture.md)、[Session 源码](../packages/core/session/src/index.ts)、[启动组合说明](../packages/boot/app-boot/README.md)及 [防御模式](../docs/defensive-patterns.md)，确认插件加载、事件采集、存储和清理的可用接口。

### 交付物

- 记忆插件入口、加载配置和实际运行记录。
- L0 类型、最小服务定义及配置说明。
- SQLite Provider、数据库说明和存储测试。
- L0 自动采集逻辑和写入失败检查。
- 补采与清理逻辑、恢复测试及 L0 保存范围说明。

### 验收标准

- 插件可通过受支持的 profile 加载和退出，所有写入均在允许目录内；卸载后无残留监听，重新加载后不重复采集。
- 严格类型检查拒绝错用 ID，非法配置明确失败；读写接口能够表达有序事件批次和缺失范围。
- 写入后关闭并重开数据库，读取结果一致；重复写入不新增记录，事务失败无半次提交，未知较新 schema 拒绝打开。
- 执行一个任务后数据库事件与 Session 对应；注入写入失败时进度停在最后一次成功提交处。
- 重启并载入 Session 后补齐事件且无重复；来源丢失时明确报错，卸载后没有残留写入。
- 重开数据库仍可有序读取完整的已记录事件。L0 不复制附件或 spill 文件实体，不承诺恢复已经失效的引用，也不自动扫描全部磁盘历史或清理旧数据。

### 实现与验证记录（2026-09-26）

状态：目录内实现及下列检查已完成，完整验收仍受阻，保留 Task 1 未勾选。当次执行未涉及 Task 2–4，未推送或修改目录外源码、配置与依赖。

产出：[插件入口](src/index.ts)、[L0 接口](src/types.ts)、[配置解析](src/config.ts)、[SQLite Provider](src/sqlite.ts)、[采集器](src/collector.ts)、[源码 profile patch](profiles/headless.patch.yml)、[构建 profile patch](profiles/headless-built.patch.yml)、[使用说明](README.zh.md)。默认队列容量 1024、事务及补采页大小 128、锁等待 5000ms、WAL/FULL；配置均在执行前解析。内存队列不持久化，SQLite 记录连续提交位置，原日志负责补采。

执行检查前点入 `scripts/environment.ps1`，工作目录、Harness home、临时目录与缓存均设在 memory 内。后续检查发现环境已具有依赖和构建产物，本次未安装或构建目录外依赖。`tsconfig.json` 引用 vendor 项目已有声明，保持 memory 源码和测试的严格设置；未通过降低严格级别处理 vendor 编译选项差异。

| 实际命令（工作目录 memory/） | 结果 |
|---|---|
| `node scripts/check-local.mjs` | 14 个 TypeScript 文件语法解析、默认配置及 6 个非法输入检查通过；不代表类型检查。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 通过。 |
| `node scripts/test.mjs` | 4 个测试文件通过，19 个测试通过，1 个需要实际 profile 数据的测试默认跳过。 |
| `node scripts/test.mjs profile-copy`，设置 `DSH_MEMORY_VERIFY_COPY=1` | 对实际源码及构建 profile 生成的 L0 副本核对通过：1 个测试通过。 |
| 同一 `profile-copy` 命令，另设 `DSH_MEMORY_VERIFY_DB=data/recovery.sqlite` | 重启补采副本与当前原日志逐事件一致：1 个测试通过。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | 通过，仅生成 memory/lib/index.mjs。 |
| `node ../scripts/run-oxlint.ts --config ../.oxlintrc.json src tests` | 退出码 0。 |
| `node scripts/check-docs.mjs` | 四份文档的链接及 README 双语结构检查通过；不替代 doc-sync 和配对记录。 |
| `node ../scripts/verify-translation-pairing.ts --write memory/README.md`，随后运行同一命令去掉 `--write` | 用户授权 Git 提交后生成配对记录；1 对文档一致性检查通过。首次沙箱拒绝 Git 对象写入，提升后成功。 |
| `node ../scripts/gen-third-party-notices.ts --check` | 根目录第三方声明与生成结果一致；此命令只读，未重写该文件。 |

实际运行了 `node --import tsx/esm ../apps/cli/src/bin.ts --profile headless --patch ./profiles/headless.patch.yml 'Reply with OK without using tools.'`。首次被宿主 `uv_os_get_passwd` 调用阻断；按仓库沙箱规则提升宿主执行后，插件加载、采集并退出。该任务因 `MISSING_CREDENTIAL` 退出码为 1，L0 保存该 Session 的 19 条完整事件；没有宣称模型调用成功。

构建 profile 首次因目录外插件未纳入 profile 依赖解析而加载失败。运行 `node scripts/link-profile.mjs` 后，本地链接与目标均位于 memory 内；随后运行 `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml 'Reply with OK without using tools.'`，插件成功加载并采集第二个失败任务。两个首次运行合计保存 37 条事件，使用真实 JSONL Provider 解码原日志的核对测试通过。单独使用 Node 的单帧 Zstd 解压比较曾失败，因为只读到首帧 header；最终验证使用仓库 JSONL Provider，不把物理解压片段当作逻辑日志。

又以构建 profile、原 Session ID 和 `--patch ./tests/fixtures/recovery.patch.yml` 在新进程恢复该 Session。新的 recovery.sqlite 从原日志补采，随后任务仍因缺少凭据失败；最终 29 条事件与原日志完整一致。SQLite 数据和失败启动诊断分别位于 memory/data/、memory/home/，均被目录内 .gitignore 忽略。

测试涵盖真实 SQLite 事务回滚、重复与冲突、项目隔离、schema 拒绝、损坏前缀、取消、分页和缺失范围；Promise 屏障控制队列溢出与关闭等待；真实 Cordis/JSONL 测试覆盖卸载重载、fork 继承历史及根级清理期间的队列溢出。品牌 ID 的负向类型用例随严格类型检查执行。

仍未完成或受阻的项目：

- 没有 `DEEPSEEK_API_KEY`，也没有仓库根 .env；真实模型成功任务尚未验证，不能将缺少凭据的失败路径等同于真实模型验收。
- 必须新增的 keyless Session 录制回放归属 `snapshots/session/`，该路径在授权写入范围外。未写目录内替代快照；完整 Task 1 验收因此受阻。
- 未运行完整 `pnpm run doc-sync`、仓库级 build/hygiene 或平台矩阵。目录内验证不替代这些检查；本次不修改其配置使 memory 自动纳入工作区。

## Task 2：实现 L1 任务记忆

- [ ] 完成 Task 2。

### 本次实现内容

- **识别 turn 结束并读取 L0**：在 Session 事件中识别 `turn/end`，确定对应 turn 的事件范围与结束原因。等待该范围 L0 提交成功，再按顺序读取；缺失范围不得当作完整输入。建立带项目、来源范围和提炼配置版本的任务键，将采集进度与待提炼任务可靠保存。
- **定义 L1 总结内容**：定义目标、关键动作、结果、解决方案、turn 和结束原因字段。保留项目、来源事件引用、模型标识和提示模板版本，区分本次执行事实与注入参考。编写总结提示和输出校验规则，明确空 turn 可以返回无内容结果。
- **调用模型生成 L1**：从 [LLM 服务](../packages/llm/llm/README.md)核实可复用调用方式，配置模型、输入预算、超时和取消。调用模型并校验结构与来源，只允许引用输入中提供的事件。对超长 turn 分段提炼后合并并保留来源范围；无法满足预算时明确失败。确认提炼调用不会产生再次被采集的普通用户 turn。
- **保存 L1 并恢复失败任务**：扩展 Provider 保存记忆版本及 Operation ID，以事务提交 L1，再确认任务完成。保存尝试次数、失败原因和下次重试时间，对暂时性错误执行配置内的限次退避。支持重启恢复及显式重跑；提交结果不确定时先查询原 Operation ID。

### 依赖

Task 1 已完成，能够读取完整且已提交的 turn 事件范围。实现前核实 LLM 服务和 turn 结束事件。

### 交付物

- turn 到 L0 的读取流程和待提炼任务记录。
- L1 内容定义、提示模板和输出解析器。
- L1 提炼器、模型集成检查和无效输出测试。
- L1 持久化、任务处理器和故障恢复测试。

### 验收标准

- 结束事件先到而存储尚未完成时不调用模型；L0 完整后才生成可处理任务。
- 成功、失败、中止、阻塞及空 turn 样例均能明确表示，失败不会被写成成功经验。
- 有效输出生成候选；无效 JSON、伪造来源、超时和取消不产生有效 L1；无真实凭据时记录模型验证未完成。
- 重复结束通知只提交一次；模型成功但落盘失败后可恢复，取消不写半成品，重试耗尽可观察且可重跑。
- 一个有内容的 turn 产生带真实来源的 L1；重启和重试不会重复提交，也不会把失败经历记录为成功。

### 实现与验证记录（2026-09-26，目录内部分）

状态：用户后续指示直接实施 Task 2，保留仅写入 `memory/` 的限制。目录内存储、任务发现、提炼和恢复组件已实现；生产插件只接通任务发现和查询，自动模型提炼受 Session 请求日志登记限制，Task 1 和 Task 2 均保留未勾选。未执行 Task 3/4，未提交或推送。

产出：[L1 类型](src/l1-types.ts)、[配置解析](src/l1-config.ts)、[持久化任务与版本](src/l1-store.ts)、[提炼器](src/l1-extractor.ts)、[输出校验](src/l1-validation.ts)、[任务处理器](src/l1-worker.ts)。[SQLite Provider](src/sqlite.ts) 将 schema 1 事务升级到 schema 2，保留原 L0；插件在 L0 成功提交后扫描任务，并通过 MemoryService 提供版本读取、任务分页、状态查询及显式重跑。部署默认值和使用限制见 [README](README.zh.md)。

扫描位置、未闭合 turn 和任务创建原子提交。任务区分项目、Session、完整来源区间和提炼配置；配置变化不自动重提炼已扫描 turn。完全继承的 turn 不重复创建任务，跨继承边界结束的 turn 保留完整来源。候选先持久化，再事务提交记忆和完成状态；Operation ID 用于重试去重及查询不确定提交，预期版本拒绝并发覆盖。失败、取消、重试时间、尝试次数、模型调用计数和租约均可恢复；模型调用预算跨重试累计，显式重提炼才获得新预算。

独立提炼器使用真实 LLM 服务，测试 adapter 不访问外部模型。它要求调用方先完成来源 Session 的请求记录；测试中的记录器夹具只验证调用顺序和输入一致性，不构成生产 Session 日志验收。测试覆盖成功结束、失败、中止、阻塞、token 上限、中断、fork、空 turn、伪造来源、非法 JSON、非最终输出、Unicode 分段合并、超时、取消及预算耗尽。Worker 通过 Promise 屏障和可控时钟测试取消等待、定时退避、耗尽后重跑、候选恢复、提交结果不确定及数据库重开。

所有命令在点入 `scripts/environment.ps1` 后执行，缓存、构建产物、数据库和运行日志均位于 `memory/`；复用已有依赖，没有运行根目录安装或构建。

| 实际命令（工作目录 memory/） | 结果 |
|---|---|
| `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 通过，含 L1 品牌 ID 负向类型用例。 |
| `node scripts/test.mjs` | 7 个测试文件、65 个测试通过；需要 profile 数据的 1 个测试默认跳过。 |
| `node ../scripts/run-oxlint.ts --config ../.oxlintrc.json src tests` | 退出码 0。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | 通过，输出 memory/lib/index.mjs。 |
| `node scripts/check-local.mjs` | 24 个 TypeScript 文件语法检查和原有配置检查通过，不替代类型检查。 |
| `node scripts/check-docs.mjs` | 四份文档链接及 README 双语结构检查通过。 |
| `node ../scripts/verify-translation-pairing.ts --write memory/README.md`，随后去掉 `--write` 检查 | 更新目录内配对记录，1 对文档一致性检查通过；当前工具仅写该 sidecar，不写 Git 对象。 |
| `node scripts/link-profile.mjs` | memory 内 profile 链接检查通过，没有安装依赖。 |
| `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml --patch ./tests/fixtures/l1-scan.patch.yml 'Reply with OK without using tools.'` | 插件加载并退出，主任务因 `MISSING_CREDENTIAL` 返回 1；不是模型成功验收。 |
| `node --import tsx/esm ../apps/cli/src/bin.ts --profile headless --patch ./profiles/headless.patch.yml --patch ./tests/fixtures/l1-scan.patch.yml 'Reply with OK without using tools.'` | 首次遇到宿主 `uv_os_get_passwd` 沙箱错误，原样提升重试后插件加载并退出，主任务仍因 `MISSING_CREDENTIAL` 返回 1。 |
| `node scripts/test.mjs profile-copy`，设置 `DSH_MEMORY_VERIFY_COPY=1` 和 `DSH_MEMORY_VERIFY_DB=data/l1-smoke.sqlite` | 1 个测试通过；两次 profile 的 37 条 L0 事件与真实 JSONL 日志逐事件相同。 |

只读检查确认 smoke 数据库为 schema 2，包含两个 `pending` L1 任务，`attempts` 和 `calls` 均为零，没有 L1 记忆记录；这验证受限组合没有暗中绕过日志发起提炼。初轮检查发现测试 stream 缺少必要 block-end 字段，以及可选嵌套配置被默认构造的问题，均修正后通过相关检查。

仍未完成或受阻的项目：

- 自动调用所需的辅助请求事件尚未声明或写入 Session。当前 `Session.append()` 没有供插件设置 `ignorable` 的参数，存储重读会拒绝未登记的必需事件；不能伪装成已有标题事件或只写 SQLite。需要扩大到持久化声明发现配置、`packages/core/session/src/known-event-types.ts`、`docs/persistence-catalog.md`、`docs/persistence-schema.json` 和 `docs/persistence-changes/` 的授权范围，按正式生成与兼容性登记流程接入；实际生成文件清单还需随事件定义核对。
- 必需的 `snapshots/session/` 录制回放仍在目录外；新增 Session 事件还需核对 TypeScript/Python SDK 预期输出。没有创建目录内替代 Session 快照，也没有接通缺少日志记录的生产 worker。
- 环境没有真实模型凭据；真实模型成功 L1、主任务成功路径，以及辅助请求在 Session 中的完整回放未验证。
- 未运行完整 `doc-sync`、工作区 build/hygiene 或平台矩阵，未修改外部配置来纳入 memory；目录内检查不替代这些验收。

## Task 3：实现 L2/L3 长期记忆

- [ ] 完成 Task 3。

### 本次实现内容

- **评估知识重要性**：为项目决策、稳定约束、可复用解决方案和临时信息制定评估标准。校验模型评分，将评分范围、筛选阈值及提示版本记录为明确配置或设计约定。用重复、一次性和矛盾信息验证筛选；低分不删除原始 L0/L1。
- **从 L1 提炼和合并 L2**：读取同项目的新 L1 及相关现有知识，提炼架构事实、进度、决策和问题结论。比较候选与已有条目，对相同结论去重合并，保留每条知识的来源引用。提交新的 L2 版本；同项目按序提交，版本冲突后读取最新知识重新提炼。
- **更新、替代和失效知识**：实现新版本提交、替代和显式失效，保留旧版本及来源。对无法判断的矛盾结论标记冲突，不自动选一条当成稳定事实。让候选读取仅返回当前有效版本，并使失效或被替代版本的共享批准失效。
- **从 L2 提炼 L3**：从有效 L2 中筛选稳定知识，读取相关现有 L3 作为合并输入。生成并校验 L3 候选，复用版本提交、去重和来源追踪机制。保持项目归属，拒绝把未解决的冲突或重复引用提升为新验证结论。
- **实现用户批准共享与撤回**：核实可复用的受信任用户入口，展示正文、来源项目、版本和撤回限制。将批准与撤回绑定具体 Memory ID、Revision 和用户操作记录，不允许模型自行批准。仅共享当前有效且获批的 L3；更新后重新批准，不展开原项目私有来源正文。

### 依赖

Task 2 已完成，能够提供带来源和版本的 L1。实现前核实受信任用户入口以及现有版本提交机制。

### 交付物

- 重要性评估逻辑及样例说明。
- L1 → L2 聚合器及去重、并发测试。
- 版本更新逻辑和有效状态检查。
- L2 → L3 提炼器及稳定知识样例。
- 共享批准/撤回入口、持久化记录和权限测试。

### 验收标准

- 样例能按标准区分保留价值；高分只影响筛选，不能将未核实或矛盾结论判为真实。
- 两次描述同一事实的任务不会产生重复有效知识，不同项目的数据不会参与同一次聚合。
- 项目决策变化后新查询得到新版本，旧版本仍可追溯但不作为有效候选返回。
- 有效项目知识可以形成可追溯的 L3，矛盾来源不会生成肯定的稳定经验，L3 默认不跨项目共享。
- 批准前其他项目不可读，批准后仅可读指定 L3，撤回后新查询不可读；历史 Session 已记录内容不被重写。
- 知识可评分、去重、合并和更新，来源与版本可追溯；跨项目使用始终受具体版本批准约束。

### Task 3 目录内实施记录（2026-09-27）

已实现目录内知识评分、L1→L2 聚合、L2→L3 提炼、schema 3 存储迁移、不可变版本及候选查询、显式失效、内部共享批准/撤回事务，以及带请求记录前置条件的提炼器和显式 worker。来源沿用现有项目归属并绑定具体版本；共享投影不展开私有来源。真实用户 adapter 与自动模型 worker 均未在生产服务注册。

局部验收通过不等于 Task 3 整体完成，完成复选框保持未勾选。Task 2 的辅助 Session 事件登记、相关持久化声明、仓库级录制快照及 SDK 预期仍为目录外集成依赖。L2/L3 真实 Provider 提炼效果与完整用户批准入口未验证。本次不实现 Task 4、不修改目录外文件、不提交或推送。

本次命令均从 memory/ 运行，先点入 scripts/environment.ps1；缓存、临时数据库及构建产物均位于本目录。

| 验证命令 | 实际结果 |
|---|---|
| `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 通过。 |
| `node ../scripts/run-oxlint.ts --config ../.oxlintrc.json src tests` | 退出码 0。 |
| `node scripts/test.mjs` | 97 项通过，需显式启用的 profile-copy 测试 1 项跳过；其中 Task3 定向测试 26 项。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | 通过，输出 lib/index.mjs。 |
| `node scripts/check-local.mjs` | 33 个 TypeScript 文件语法及配置检查通过。 |
| `node scripts/check-docs.mjs` | 四份文档链接及 README 双语结构通过。 |
| `node ../scripts/verify-translation-pairing.ts --write memory/README.md`，随后去掉 `--write` 检查 | 目录内配对记录更新后，1 对指定文档一致性检查通过。 |
| `node scripts/test.mjs plugin` | 最后补强的服务排队测试在内，5 项通过；真实 L1 来源的 L2 任务保持 pending，模型调用计数为 0。 |
| `node scripts/test.mjs knowledge-worker` | 清理路径补强后，11 项通过；失败断言也会释放受控等待并关闭 worker。 |
| `node scripts/link-profile.mjs` | 检查通过，没有安装依赖。 |
| `node ../apps/cli/lib/bin.js --profile headless --patch ./.artifacts/task3-profile.patch.yml 'Reply with OK without using tools.'` | 构建版插件通过受支持 profile 加载，返回 OK，退出码 0；使用独立测试数据库。 |
| `node scripts/test.mjs profile-copy`，设置 `DSH_MEMORY_VERIFY_COPY=1` 和本次独立数据库路径 | 1 项通过；数据库 schema 3，21 条 L0 事件与真实 Session 日志一致，自动生成的长期知识为 0 条。 |

直接使用普通 Node 导入 lib/index.mjs 的检查曾因找不到外部 peer 依赖 @deepseek-ai/cordis 失败；受支持 profile 的产物 smoke 已通过，未增加独立应用入口。未运行根目录 doc-sync、完整构建/hygiene、录制快照或 SDK 验证；这些检查涉及目录外集成，不以目录内检查替代。

测试覆盖真实 SQLite 迁移及迁移回滚、阈值和低分冲突、成功方法证据链、来源隔离、幂等去重与版本替换、提交失败及数据库重开、租约和版本冲突、准确请求先记录后调用、非法输出、超预算、超时、取消、调用预算耗尽与显式重试，以及共享批准、回执拒绝、版本失效和撤回。模型测试通过真实 LLM 服务使用进程内受控 adapter；没有声称完成真实模型效果或 Session 日志录制回放验证。

## Task 4：实现记忆检索与注入

- [ ] 完成 Task 4。

### 本次实现内容

- **生成并保存 embedding**：核实可用 embedding 提供方，配置模型与维度，不用普通文本生成接口冒充 embedding。为有效 L1/L2/L3 生成向量，绑定具体记忆版本，校验数量、顺序、维度和有限数值。在记忆更新时更新索引；模型或维度变化时重建，重建期间明确报告未就绪。
- **筛选、排序并控制检索预算**：先选出当前项目有效记忆及获批共享 L3，再生成查询向量并计算余弦相似度。应用配置的阈值、数量和文本预算，同分按 Memory ID 稳定排序。返回正文、MemoryRef、项目/共享标记及相似度，测量首版候选扫描的耗时和容量。
- **将记忆记录并注入 Agent**：核实 [Agent 扩展点](../packages/core/agent/src/runtime-types.ts)，在每个 turn 首次实际模型请求前，以本次已接受的用户文本检索一次。注入前复查版本和批准，按条目裁剪并标记为历史参考；预算容不下的条目跳过。经正常事件记录流程保存实际注入正文及引用，遵守 waterfall 委托，不直接拼接未记录的请求或唤醒新 turn。从已提交日志判断是否已注入，处理恢复、重试和取消；必要的新事件声明及 SDK 更新受目录限制约束。
- **验证跨 Session 使用与故障处理**：用真实 Provider 和 Loader 运行学习 Session，再在新 Session 提问，检查相关记忆是否进入模型请求。覆盖空结果、检索失败、共享撤回、数据库失败、模型超时、取消、重启及并发项目隔离。验证卸载后无在途写入或残留监听；依照 [CI 测试可靠性规范](../.agents/skills/dsh-ci-test-reliability/SKILL.md)隔离资源并等待清理。
- **完成效果评估和交付检查**：运行受支持 profile 的产物 smoke 和真实模型流程，为跨 Session 命中、失败降级、批准及撤回安排 keyless 录制回放；核对持久化声明及两套 SDK 预期要求。固定模型和任务集，对照开启与关闭记忆的结果；两组有相同学习机会，对照组不提供跨 Session 记忆。记录完成率、步骤、Token、提炼与 embedding 成本及检索延迟，按知识是否相关且任务结果正确评估效果。核对 PROJECT.md 的需求覆盖及使用说明，按 [检查选择规则](../.agents/skills/dsh-pre-push-checks/SKILL.md)记录实际检查、未验证项与外部阻塞。

### 依赖

Task 1–3 已完成，能够提供当前有效的项目记忆和具体版本的共享批准。实现前核实 embedding 提供方、Agent 扩展点及 Session 记录流程。

### 交付物

- embedding 适配器、向量存储和索引检查。
- Retriever、检索测试和容量记录。
- Injector、可回放的注入记录及组合测试。
- 端到端及故障集成测试、实际执行记录。
- 评估记录、使用说明和交付清单。

### 验收标准

- 输入与向量一一对应，新旧向量空间不混用；旧版本不再命中，缺少提供方或凭据时不宣称语义检索完成。
- 同义查询能命中预设知识，无关查询可返回空结果；其他项目私有数据不返回，结果不超预算，不静默退化为关键词检索。
- 模型读取正文与日志一致；数据库后续变化不改变历史回放，同 turn 不重复注入，空查询和取消不误记注入成功。
- 新 Session 可使用已学习知识；可降级的记忆故障有诊断且主任务继续，失败不冒充保存或注入成功。
- 每项需求有实现和验证证据，不预设收益比例；缺少凭据、必要快照或目录外类型声明时保留未完成状态，不以目录内测试替代。
- 新 Session 能检索并使用相关历史知识，日志可还原实际注入正文；效果、额外成本、容量和未验证限制均有记录。

### Task 4 目录内实施记录（2026-09-27）

已实现独立 embeddings HTTP 适配器、严格配置与响应校验、schema 4 事务迁移、绑定版本和空间的向量存储、提交后增量索引、启动恢复、项目权限筛选、余弦排序、整条 UTF-8 预算，以及独立 Injector。MemoryService 提供 `retrieve`、`getIndexStatus`、`rebuildIndex`。未配置 embedding 时保持关闭；显式配置但缺少密钥时在打开数据库前失败。生产插件不注册 Injector，不提供批准工具或自动提炼。

Injector 组合测试使用真实 Agent、LLM 服务、JSONL Provider 和受控模型 adapter，验证正文进入正常 `user/message` 及请求、重试和同 turn 多步骤不重复检索、已提交日志控制监听器重载、取消不提交参考，以及索引失败时主任务继续。L1 测试保留来源标记和区分历史参考的提示。目录内测试不替代生产来源声明和仓库录制会话。

产出与需求覆盖、固定对照任务集、容量数据和外部路径见[评估记录](evaluation/task4.md)。本次仅修改 memory/，保留原有未跟踪的 profiles/web.patch.yml，未提交或推送。Task 4 复选框保持未勾选。

以下命令均从 memory/ 执行，先点入 scripts/environment.ps1；缓存、临时文件、数据库、日志和产物均在本目录。

| 实际命令 | 结果 |
|---|---|
| `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 通过，包含向量空间品牌 ID 负向类型检查。 |
| `node scripts/test.mjs` | 130 项通过，3 项按显式开关跳过：真实 embedding、容量测量、profile-copy。 |
| `node scripts/test.mjs retrieval-capacity`，设置 `DSH_MEMORY_BENCHMARK=1` | 1 项通过；100/1000/10000 条候选、128 维合成向量，每档 20 次计时。 |
| `node scripts/test.mjs plugin` | 6 项通过，包含配置后通过动态端口调用真实 fetch、检索及卸载。 |
| `node ../scripts/run-oxlint.ts --config ../.oxlintrc.json src tests` | 退出码 0。 |
| `node scripts/check-local.mjs` | 42 个 TypeScript 文件语法与原有配置检查通过；不替代类型检查。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | 通过，仅输出 memory/lib/index.mjs。 |
| `node scripts/link-profile.mjs` | 通过，未安装依赖。 |
| `node ../apps/cli/lib/bin.js --profile headless --patch ./.artifacts/task4-profile.patch.yml 'Reply with OK without using tools.'` | 构建版通过受支持 profile 加载并返回 OK，退出码 0；使用独立 task4-smoke.sqlite。未配置 embedding，不代表自动检索或注入验收。 |
| `node scripts/test.mjs profile-copy`，设置 `DSH_MEMORY_VERIFY_COPY=1`、`DSH_MEMORY_VERIFY_DB=data/task4-smoke.sqlite` | 1 项通过，L0 副本与真实原日志一致。 |
| `node scripts/check-docs.mjs` | 五份文档链接及 README 双语结构通过。 |
| `node ../scripts/verify-translation-pairing.ts --write memory/README.md`，随后去掉 `--write` | 目录内配对记录更新，1 对文档一致性检查通过。 |

真实 embedding endpoint、模型、维度与密钥未配置，未运行真实语义检查或完整任务对照，未预设收益与费用。1 万条候选的本地检索 p95 为 624.14ms；这是合成容量证据，不包含网络或真实模型延迟。完整学习 Session → 新 Session 使用仍依赖 Task2/3 请求记录与可信批准入口，以及目录外持久化声明、快照和 SDK 预期。未运行根目录 doc-sync、完整构建/hygiene、平台矩阵或仓库录制快照；目录内检查不替代这些验收。

## 开发备注

### 当前独立开发目标（2026-10-01）

用户调整目标为仅在 memory/ 内复用 DSH 已有模型、凭据和 Session 日志执行后台 L0 → L1 → L2 → L3 整理，并提供无需 embedding 的明确文本检索。向量检索保留为可选增强；正式 DSH 持久化登记、生产注入和 SDK 验收留到集成阶段，不作为本阶段继续开发的前提。

`autoLearning` 通过辅助 Session 日志和已加载的 LLM 服务派发后台任务；插件条目必须声明 llm 依赖，缺少时在打开数据库前失败。采集提交合并唤醒通知，采集刷新不等待模型，`flushLearning` 提供可等待的学习检查点。自动 profile 从默认模型读取两类提炼路由，凭据仍由现有适配器解析。卸载先关闭后台模型及检索，再排空采集并释放数据库；最终来源保留供下次恢复。文本检索显式使用 FTS5/BM25，先构造授权语料，再评分及复查版本与共享批准；不伪装成语义相似度，也不在向量失败时自动切换。

本次相关组合、检索、注入、任务、日志及配置检查共 79 项通过；容量开关用例跳过。类型检查、源码及测试 lint、文档链接与双语结构、README 配对、构建通过。后台组合测试观察到模型在显式检查点之前进入，并验证重载不重复调用；新 Session 的真实 Agent/JSONL 组合测试使用文本检索取得新生成的记忆，模型请求与持久化正文一致。成功真实运行的数据库重开检查另有 1 项通过，不再调用模型；`automatic.patch.yml` 构建版通过受支持 headless profile 加载并返回 OK，退出码 0。

真实 profile 运行复用 deepseek-official / deepseek-flash。成功运行数据库为 `data/automatic-live-490adac9-7da7-437b-bbad-b2c9ecb48d99.sqlite`，来源为 `memory-live-source-528194a2-ecd3-4631-aa56-f30e174117bf`；L1、L2、L3 各调用一次、各提交一个结果，BM25 命中本次 L3，退出码 0，输出 passed: true。此前运行中的祖先来源误引、输出 token 耗尽、旧库并发版本冲突及夹具数据库路径不一致均保留记录，不计为通过。提示词 v2 明确区分直接来源与核对祖先，已有 v1 任务保留原提示；夹具现在每次使用独立数据库。此单个真实案例不证明一般质量、语义检索效果或收益比例；费用缺少单价时为未知。

### 独立开发验证（2026-09-30）

[MemoryPipeline](src/pipeline.ts) 复用现有 LLM 服务和 worker，在目录内数据库中导入 L0 并执行到期的 L1/L2/L3 提炼；调用方可显式 flush，或通过 watch 自动调度已保存的重试和后续版本，不要求实时来源 Session。retire 停止项目后台调度并等待已排队工作，close 取消全部在途提炼并清理订阅及定时器。[辅助请求日志](src/request-journal.ts) 使用带 `ignorable: true` 的外部插件 Session 事件，在调用前保存完整请求，并在候选准备前提交结果流。其他 Harness 读取方保留这些事件且不把它们加入普通 Agent 历史。未添加独立可执行入口、修改共享源码或安装生产 Injector。

[组合测试](tests/pipeline.spec.ts) 通过真实 LLM 服务及受控 adapter，验证三层生成、独立查询、数据库重开不重复调用、日志重读、请求提交失败不调用模型，以及调用方取消和关闭后的清理。独立组合真实 Agent、JSONL 和 Injector 后，新的提问 Session 请求包含刚生成的记忆，持久化日志保存相同正文。[请求日志测试](tests/request-journal.spec.ts) 验证未记录和已修改请求拒绝、单次派发、所属项目隔离、结果提交失败保留未知结果和可重试任务。测试所属预期输出位于 [pipeline.json](tests/expected/pipeline.json)。这些记录不证明真实模型的提炼质量，也不替代正式 DSH 集成验收。

以下检查在加载目录内环境后执行，全部写入仍在 memory/。

| 实际命令 | 结果 |
|---|---|
| `node scripts/test.mjs` | 当时 145 项通过，4 项保留显式开关跳过；随后增加学习队列上限用例。 |
| `node scripts/test.mjs pipeline` | 当时 7 项通过，包含后台 L1 退避重试及重启后的 L2 重试；随后增加并发项目用例。 |
| `node scripts/test.mjs pipeline config request-journal plugin` | 24 项通过，包含全局学习并发上限、排队取消、队列满后的 L0 保留和已监听项目恢复；类型检查和源码、测试 lint 同时通过。 |
| `node scripts/test.mjs pipeline` | 11 项通过；新增同项目排队立即取消及已取消信号检查，验证释放队列容量后后续处理仍等待前一个项目任务，且不增加模型调用。 |
| `node scripts/test.mjs request-journal pipeline` | 最终 7 项通过，包含记录后修改输入拒绝、调用方取消及新 Session 组合用例。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 最终源码和测试通过。 |
| `node ../scripts/run-oxlint.ts --config ../.oxlintrc.json src tests` | 最终源码和测试通过。 |
| `node scripts/check-local.mjs` | 最终 49 个 TypeScript 文件语法、默认配置和 6 个无效输入检查通过。 |
| `node ../scripts/verify-translation-pairing.ts --write memory/README.md`，随后去掉 `--write` | README 双语配对记录更新且检查通过。 |
| `node scripts/check-docs.mjs` | 五份文档链接及 README 双语结构通过。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | 产物构建通过，输出 memory/lib/index.mjs。 |
| `node scripts/link-profile.mjs` | 本目录 profile 链接通过，不安装依赖。 |
| `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml 'Reply with OK without using tools.'` | 受支持的产物加载返回 OK；已有 otel 条目导入警告仍存在。未启用独立提炼。 |
| `git diff --check` | 通过。 |

尝试从普通 Node 进程直接导入构建产物时，未安装的外部 peer `@deepseek-ai/cordis` 无法解析；本目录尚未加入根工作区。源码开发测试使用现有路径解析，产物通过现有 profile 解析依赖。没有为此修改工作区或增加替代启动器。用户确认暂未配置 embedding，真实 embedding 语义及固定任务效果对照尚未执行；真实提炼样例见下节，正式持久化声明、SDK 预期与仓库录制快照仍待集成阶段验收。

### 后台调度与真实提炼验证

[流水线测试](tests/pipeline.spec.ts) 验证 L1 暂时失败后自动退避重试并继续到 L3，数据库重开后恢复 L2 重试，以及一个项目等待模型时另一个项目完成全部提炼。停止项目监听和关闭流水线后没有残留定时器，来源项目与私有记忆保持隔离。

通过现有受支持的 headless profile 加载[真实提炼测试 overlay](profiles/learning-live.patch.yml)，复用现有模型及凭据，处理一条合成的明确长期约束。实际模型为 `deepseek-official / deepseek-flash`；L1、L2、L3 各调用一次、各提交一个结果，无失败。L1 保留 `unknown`、空 actions 和 null solution；L2、L3 保存 strict TypeScript/ESM 约束及准确来源链，正文保留未执行实现和测试的限定。数据库为 `data/learning-live.sqlite`，本次来源 Session 为 `memory-live-source-ffd6583b-7f88-4e21-b095-41760a38e434`。这是一条真实模型样例，不代表一般质量或收益。

Provider 返回的三次用量记录合计 uncached input 2094、cached input 128、output 4403、total 6625 Token；未配置价格，费用未知。用量保存在辅助结果流中，不把未返回用量的未来调用记为零。本次没有 embedding 调用。

实际执行 `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/learning-live.patch.yml 'Validate independent memory learning.'`，退出码 0，输出 `passed: true`；已有 otel 导入警告仍存在。随后设置 `DSH_MEMORY_VERIFY_LEARNING=1` 和上述来源标识，执行 `node scripts/test.mjs learning-live pipeline`，9 项通过，其中一个检查重开实际数据库验证内容、来源及请求和结果日志，其余为受控组合验证。此检查不再调用模型。`node --check tests/fixtures/learning-live.mjs`、最终类型检查、源码及测试 lint、文档检查和构建均通过。独立测试夹具通过既有 profile 启动，没有新增应用 bin。

真实提炼已验证上述单条约束样例；真实 embedding 语义及固定任务完整效果对照仍未执行。正式 profile 自动采集到提炼的注册、持久化声明、SDK 预期与仓库录制快照仍留在集成阶段，整体复选框保持未勾选。

本清单只规定待执行的实现任务，不代表插件、测试或效果评估已完成。重要性评估的具体标准在 Task 3 实现时确定并同步设计说明；其余接口和行为以 PROJECT.md 为需求参考，实现前核实当前 DSH 源码。
