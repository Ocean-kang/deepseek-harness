# Memory 0.1.13 存储与维护验收

本记录覆盖 2026-10-13 至 10-14 在 Windows 上执行的独立 memory 插件验收：大 trace 回归、专用 SQLite worker、分页提炼、工作区历史导入、保留与清理，以及构建包和受支持的 Web profile。操作说明见[随包 README](../distribution/README.zh.md)，数据库与异步 API 升级见[迁移说明](../distribution/storage-upgrade.zh.md)。合成模型验证调用、日志和证据链，不证明一般模型的记忆质量。

## 数据与兼容性

插件自有 SQLite schema 从 5 升级至 6。升级保留 L0 事件、既有 L1 summary/candidate 和模型请求日志原文，增加摘要投影、版本 trace 分块、导入进度和准入／清理标记。迁移和旧已准备任务首次提交时，SQLite 内部仍可能解析单条旧 TEXT；JavaScript 读取摘要或 trace 页时不接收完整旧 trace。DSH Session 格式和上游持久化实现保持不变。

大 trace 检查使用 20 条约 4 KiB 的文件写入参数，形成 86,074 字节的完整 trace；原实现超过 65,536 字节输入预算，在模型调用前失败。`knowledge-v3` 和 `knowledge-v4` 的 L2/L3 输入均排除 trace，读取精确 L0 序号核实原始证据，并生成后续版本。分页拼接保留完整 trace 和 Unicode 字符；旧记录的原始 JSON 字节保持不变。已有失败任务由用户显式重试，升级不重跑已完成任务。

导入使用当前绑定工作区的 Session 持久化数据，保存真实 Session ID、事件序号、fork 继承前缀及逐来源的目标和进度。缺失或不支持的来源逐项报告，其他已验证来源继续导入；跨工作区请求拒绝。取消保留已提交数据，重启恢复未完成进度。`autoLearning` 关闭时导入仅复制 L0，开启时调用配置的提炼模型。

清理以完整会话为单位，在执行事务内重新检查引用；有效知识、冲突证据、待用选择及其所属会话、未完成或可重试任务、活动会话和有效共享授权保护完整来源链及模型请求日志。清理保留原工作区归属和 tombstone，自动恢复不重新采集；显式导入可恢复同一来源。清理使 SQLite 页可复用，独立压缩操作执行 VACUUM。保留期限不保证固定文件大小。

## 性能测量

测量排除模型网络时间，分别检查主线程回调顺序、采集缓存及 L1 源缓冲。字节数表示插件持有的序列化事件数据，不代表整个 Node 进程的 RSS；Session 实例、上游 JSONL 冷读、单条超大事件和迁移中的 SQLite 内部临时分配单独保留其限制。

| 场景 | 观察结果 | 判定范围 |
|---|---|---|
| 同步 SQLite 锁等待诊断 | 回调在写入以 SQLITE_BUSY 失败后才运行；一次观测约 167 ms，busy timeout 80 ms。 | 原同步后端仍作为隔离测试基线。 |
| 专用 worker 锁等待 | 回调先于写入完成，释放锁后写入成功；一次观测约 2 ms，busy timeout 5,000 ms。 | 断言回调与提交的先后关系，不把毫秒值作为跨机器门槛。 |
| 采集缓存，100 → 1000 条约 1 KiB 事件 | [实测记录](../.artifacts/capture-cache-metrics.json)：缓存峰值均为 7,362 字节，配置预算 8,192 字节；100 条 6 次事务、397 ms，1000 条 13 次事务、1,506 ms。 | 超出缓存的数据从原日志恢复，逐页核对全部原始事件。数据页预算 256 KiB，批次数量上限 128。 |
| 恢复逐条提交诊断 | 改造过程中，同样两档事件曾观察到约 19,442／142,137 ms；随后改为受数量和字节限制的恢复批次。 | 前后运行时机器并发负载不同，这些绝对值不构成稳定加速倍率。 |
| L1 异步源，100 → 1000 条事件 | 来源总量约 121,686 → 1,218,789 字节；源缓冲峰值均约 14,628 字节，合成调用 11 → 94 次，一次观测 13 → 77 ms。 | 按当前模型分组消费；不收集整轮事件。 |

## 已执行检查

所有命令从 `memory/` 执行，并加载 `scripts/environment.ps1 -ProjectId memory-implementation`。Windows 沙箱曾阻止夹具路径读取和本地 profile 运行；相应命令按原参数在宿主重试。构建、缓存、日志、安装 home、测试数据和浏览器材料均位于插件目录。

| 检查 | 当前证据 |
|---|---|
| `node --import tsx/esm scripts/test.mjs` | [整包日志](../.tmp/tests-full-stable.log)：35 文件中 31 通过、4 跳过；363 项通过、4 跳过，无失败或未处理异常，耗时 656.94 秒。 |
| `node --import tsx/esm scripts/test.mjs tests/plugin.spec.ts tests/workspace.spec.ts tests/retrieval.spec.ts tests/knowledge-store.spec.ts tests/browser.spec.ts` | 5 文件、60 项通过，覆盖异步调用方和 schema 回滚／升级。 |
| `node --import tsx/esm scripts/test.mjs tests/storage-worker.spec.ts tests/browser.spec.ts tests/collector.spec.ts tests/workspace.spec.ts` | 4 文件、26 项通过，覆盖原数据与浏览页字节限制、单条超大事件、按页恢复和工作区扫描。 |
| 大 trace、L1 store/worker、层级提炼和真实 worker 聚焦检查 | 50 项通过；旧 trace 与真实 worker 最终 14 项通过，包含旧 prepared 任务恢复和 schema-5 实际迁移。 |
| `node --import tsx/esm scripts/test.mjs tests/maintenance.spec.ts` | 最终 26 项通过。除隔离、取消／重启、fork 去重、旧来源准入、清理保护链、事务回滚和 tombstone 归属外，覆盖无事件计数来源的已导入预览、增长、截断、缺失、读取失败及空来源。 |
| `node --import tsx/esm scripts/test.mjs tests/compatibility.spec.ts tests/storage-worker.spec.ts` | [最终日志](../.tmp/tests-compat-worker-final.log)：15 项通过，包含最终运行依赖、worker 故障未知结果和队列已满时关闭。 |
| `node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit`、Client 同命令使用 `tsconfig.client.json` | 最终两个程序均通过。日志：[Host](../.tmp/typecheck-host-final.log)、[Client](../.tmp/typecheck-client-final.log)。 |
| `node ../node_modules/oxlint/bin/oxlint -c .tmp/memory-lint.json --threads 2 src tests scripts` | [最终日志](../.tmp/lint-final.log)：通过。[局部配置](../.tmp/memory-lint.json)检查 const 重赋值、重复对象键及未使用变量；包含 JavaScript 夹具和脚本，允许命名的未使用 catch 参数。不是仓库全部 lint 规则的验收。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native`、`node scripts/pack.mjs` | [构建](../.tmp/build-final.log)及[打包](../.tmp/pack-final.log)通过。0.1.13 归档包含 18 个文件，其中 7 个运行文件。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing --evaluation storage-0.1.13-2026-10-13.md` | 12 份本次文档的链接和 5 组双语结构、物理行数、配对记录通过。 |

整包检查之后，真实 Web 验收发现 Session 元数据缺少可选事件计数时，完成的导入仍显示可导入。最终修复使用至多两次单事件读取核对已复制来源末尾，不扫描整条来源；上述 26 项聚焦测试和类型检查在修复之后执行。整包日志对应这项末尾预览修复之前的版本；没有把新增测试计入此前的 363 项结果。

## 构建包与实际运行

最终[独立安装包](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.13.tgz)的 SHA-256 为 `515bba5d981ccd198133d20faa888d76bdcef313f56c4e42d39dffca98b00216`。安装通过 `scripts/workspace-web-smoke.mjs` 调用受支持的 `dsh plugin --profile web add`，随后调用 `dsh web`；归档以内容哈希命名，避免相同版本路径复用旧包。安装副本的全部 7 个运行文件与本次构建相同。没有通过插件 bin 或 SDK 参数绕过应用启动。

安装验收设置 `DSH_MEMORY_DELIVERY_MODE=run` 和插件目录内的 `DSH_MEMORY_DELIVERY_EVIDENCE`，执行 `node scripts/workspace-web-smoke.mjs --patch <memory/tests/fixtures/installed-delivery.patch.yml 的绝对路径>`；随后在同一隔离目录使用 `--reuse-run` 和 `MODE=verify` 重启。[最终运行报告](../.artifacts/installed-0.1.13-input-audit/delivery.json)包含 100,601 字节的精确原始证据，单条最大 60,074 字节，L2/L3 合计 6 个验证／合并请求。37 次 memory 辅助模型调用的实际选项与 L0 中 `memory/extraction-request` 逐项一致，5 次普通循环请求的召回内容也与 Session 日志一致。手动选择只使用一次，自动召回连续两轮生效，原文导出为当前 Session 格式 JSONL。

[最终重启报告](../.artifacts/installed-0.1.13-input-audit/delivery.json.verified-trigram.json)确认 3 条原始记忆版本、两份 Session 日志及自动召回设置保留；已被后续提炼替代的版本仍以原状态可读。重启仅追加普通 `session/end-seed` 标记，没有新增模型调用或召回。验收先等待提炼屏障再检查召回：早期夹具没有等待 reader 轮次引起的 L2 换版，来源检查安全地过滤了暂时过期的 L3；失败运行保留，未当作通过。

真实 Web 验收使用同一最终归档及已有 Harness Client；界面显示 Client 版本 `0.2.1-alpha.1-f30a276`，未在目录外重建 Client。CUA 当时不可用，按浏览器技能允许的回退使用仓库现有 Playwright 和独立无头 Chrome 上下文。[最终事实](../.artifacts/workspace-web-SOgBeI/web-final-proof.json)和[重启事实](../.artifacts/workspace-web-SOgBeI/web-restart-proof.json)记录实际 DOM 操作结果：创建时间筛选后的两页预览显示 3 个已导入、1 个可重新导入，重启恢复导入和清理状态，已清理来源不会自动重新采集；显式重新导入后再次执行清理，删除 1 个会话／1 条事件／313 字节，保护 1 个会话／3 条事件／505 字节，独立 Compact 成功。

界面从当前 L3 第 3 版逐级打开 L2 第 3 版、旧来源 L1 和精确 L0 序号 1。trace 展开后以 4 页还原原 JSON；验收覆盖页替换而非累积保留。为了让真实界面呈现分页，验收 profile 将浏览页设为 2 项、trace 页设为 16 字节；生产默认值未变。材料包含[导入预览](../.artifacts/workspace-web-SOgBeI/frames/restart-import-preview.png)、[最终包清理](../.artifacts/workspace-web-SOgBeI/frames/final-package-cleanup-executed.png)、[保护来源和 trace](../.artifacts/workspace-web-SOgBeI/frames/restart-protected-source-trace.png)及[操作记录](../.artifacts/workspace-web-SOgBeI/fallback-operations.jsonl)。浏览器驱动退出 0，自有浏览器、服务器和辅助进程均已停止；Windows 的服务器终止状态记录为主动停止，不伪装为自然成功退出。

## 验收边界

完整目录文档检查仍受到旧验收记录引用的缺失本地归档影响，共 44 处旧材料链接错误；本次 README 双语配对、升级说明和验收材料独立检查通过。没有运行整个 DSH 仓库的测试、跨平台矩阵或真实 Provider 质量评估。上游 JSONL 冷读仍可能加载完整 Session；单条事件超过页预算时原文独占一页，既不截断也不丢弃。
