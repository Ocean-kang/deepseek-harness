# 独立记忆插件卡片与召回验收

本记录对应 2026-10-03 开始、2026-10-04 完成验收的独立 memory 0.1.6 插件开发，目标运行环境为 DSH 0.2.0-rc.2 Web profile。用户指定全部开发、测试、说明及验收产物位于 `memory/`；交付对象为可安装插件。目录内交付规则见 [AGENTS](../AGENTS.md)，当前功能见 [README](../README.zh.md)，安装及升级说明见[随包文档](../distribution/README.zh.md)。

## 目标与范围

保留 JSON 存储，提供 L0 对话与执行、L1 主题与动作及结果、L2 项目经验与约束、L3 稳定原则与决策的可读卡片；详情展示来源、重要性、证据状态、生成理由及原始数据。搜索查看与模型自动召回分别显示，中文自动召回使用 trigram 子串匹配并说明三字符与非语义检索限制。显示提炼进度、累计生成及失败状态，提供手动和自动刷新并保留阅读位置。区分勾选、保存待用与实际进入模型上下文，展示待用内容、数量和预算，手选在接纳后消费一次，自动召回按对话持续生效。检查完整来源链，暂停过期派生记忆，有可用当前来源时重新提炼并保留历史。

独立插件的升级说明、Session 日志验收预期输出与运行记录均在本目录持有。未来向 DSH 源码提交集成 PR 时再执行其顶层快照、升级指南、SDK 及网站生成要求；这些材料不作为本次独立包的范围阻塞。真实浏览器布局与交互仍需要实际页面观察。

## 目录内功能证据

| 需求 | 验证依据 |
|---|---|
| 卡片、详情及真实性说明 | [面板 Host](../tests/panel-host.spec.ts)检查真实存储的可读字段、重要性范围、证据和原始 JSON；已知召回与提炼记录的 JSON 仅留在详情，普通用户正文保持原样。[Client 测试](../tests/panel.client.spec.tsx)检查详情展开与待用展示。 |
| 中文匹配与检索用途 | [文本检索](../tests/text-retrieval.spec.ts)检查长中文问题的子串匹配、短词限制及无共同字面的同义词不命中；Client 检查搜索分页和高亮。 |
| 生成反馈与刷新 | Client 检查成功与失败同时显示、刷新失败后重试、保留搜索和未保存勾选；可控卡片尺寸检查 L0 前插会话、知识卡片前插记录及版本更新后的阅读偏移。 |
| 保存及实际接纳 | [注入测试](../tests/injector.spec.ts)通过真实 Agent admission 和 JSONL 验证手选消费一次与实际模型请求；Client 检查输入框待用提醒及已提交正文。 |
| 来源失效与重核 | [知识存储](../tests/knowledge-store.spec.ts)检查失效传递、历史保留、共享及手选过滤、分页补足、幂等重核；[Worker](../tests/knowledge-worker.spec.ts)检查调用前记录当前来源和过期目标、调用期间失效后拒绝发布。 |
| 独立入口配置 | [portable](../tests/portable.spec.ts)检查默认 trigram、默认刷新间隔及显式 unicode61/刷新配置覆盖；[配置](../tests/config.spec.ts)检查 Loader 保留刷新间隔并拒绝无效值。 |

## 已执行检查

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs` | memory 完整测试集 22 文件通过、4 文件按显式开关跳过；215 项通过、4 项跳过。 |
| `node --import tsx/esm scripts/test.mjs tests/panel-host.spec.ts tests/panel.client.spec.tsx` | 最后的 L0 投影修复后，5 项 Host 和 16 项界面检查通过；包括嵌套 L1 召回、取消/失败片段及用户 JSON 原样保留。 |
| Host / Client `tsc --noEmit` | 历史对话读取与 L0 投影修复后通过。 |
| tsdown 构建 | Host、独立入口及 Client 产物生成成功。 |
| `node --import tsx/esm scripts/check-docs.mjs` | 9 份文档、3 组双语配对通过；版本更新后重新生成并检查配对记录。 |
| `node scripts/pack.mjs` | 0.1.6 安装包生成成功，包含 12 个文件，双语 trigram 升级说明及工作区动态模块在包内。 |
| 正式 `dsh plugin --profile web add` | 先安装 0.1.5，再用 0.1.6 tarball 升级 `.artifacts/cards-install-home/profiles/web`；安装版本与四份说明文件逐字节核对通过。 |
| 最终包独立安装与文件核对 | 界面修复后重新构建并安装到 `.artifacts/cards-final-home/profiles/web`；5 个构建模块与 4 份说明逐字节一致。 |
| 正式 Web profile 的 installed-delivery 夹具 | 默认配置下新对话学习、单次手选、两轮自动召回和完整 JSONL 通过；随后两次重启分别通过 trigram/3000ms 与 unicode61/7000ms 检查。 |
| `tests/profile-copy.spec.ts` 的实际日志核对 | 浏览器发送后，指定 reader 的完整正式 JSONL 与 SQLite 副本一致；第 5 轮接纳 1 条手选记忆，第 6 轮未再次接纳。 |
| 最后修改的 Host、协议、词典及 Host 测试 lint | 4 个文件的适用 oxlint 检查零诊断。 |

检查执行前使用 [environment.ps1](../scripts/environment.ps1) 将 home、临时路径和缓存限定于本目录。安装额外将 pnpm store 限定在 `.cache/pnpm-store`；最终包的全新 profile 使用 `.cache/cards-final-pnpm-store` 与独立缓存以排除之前的测试包缓存。关闭安装生命周期脚本并使用宿主 DSH 已有的 peer 服务；没有安装或改写根工作区依赖。

重复打包相同版本、相同路径的 0.1.5 tarball 后，安装工具仍判定已是最新版本；逐字节检查发现随包指南保持旧内容。因此本次独立插件交付使用新版本 0.1.6，并验证实际升级后的文件。历史报告及 DSH peer 版本没有改动。

源码 Client 的适用严格 lint 已通过；Host 完整源码检查仍有既有诊断，变更行检查没有新增诊断。它们不表示整个 DSH 仓库 lint 已通过。此前的 [2026-10-02 记录](workspace-storage-2026-10-02.md)是另一轮验证，旧 0.1.4 profile 不作为本次安装证明。

## 安装包运行与浏览器

最终交付包为 [.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.6.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.6.tgz)，SHA-256 为 `8459b055a90bf3db04e571f83869cd1b6b51e57147039f83cfb6e1382a313915`。

[安装验收夹具](../tests/fixtures/installed-delivery.mjs)经公开 `dsh web` profile 加载已安装插件，没有加载 memory 源码入口或本地 lib。新 source Session 生成对应 L1，L2 精确引用该 L1，L3 精确引用该 L2。reader 的两轮手选验证只有第一轮接纳记忆，随后两轮自动召回均接纳；共 5 个 Agent 模型请求逐项核对记忆正文与正式持久化事件。适配器为显式标注的合成模型，不代表一般模型的提炼质量。

最终包的完整运行证据及两条可解码 JSONL 路径见 [run 报告](../.artifacts/cards-portable-accepted.json)。[默认配置重启](../.artifacts/cards-portable-accepted.json.verified-trigram.json)与 [unicode61 覆盖重启](../.artifacts/cards-portable-accepted.json.verified-unicode61.json)均保留 3 个精确历史版本、完整旧日志前缀和自动召回设置，无新模型请求或召回。恢复只允许每条 Session 最多追加一条公开 `session/end-seed` 标记。后续学习合法替代 L2/L3 时，旧版本的 superseded 状态与内容均保留。

重现安装运行时，将 `DSH_HOME` 指向上述最终验收 home、`DSH_AGENTS_HOME` 指向本目录下隔离路径，并使用 `tests/fixtures/compatibility.patch.yml`、`tests/fixtures/installed-delivery.patch.yml` 及设置本目录 `documentsDirectory` 的 overlay；不叠加源码 `cordis.patch.yml`。设 `DSH_MEMORY_DELIVERY_EVIDENCE` 为本目录下未使用的绝对 JSON 路径；首次 `run`，随后相同路径使用 `DSH_MEMORY_DELIVERY_MODE=verify`。显式配置迁移时覆盖 memory-l0 的 `textSearch.tokenizer` 与 `browser.refreshIntervalMs`，并设置夹具对应的 `DSH_MEMORY_DELIVERY_TOKENIZER`、`DSH_MEMORY_DELIVERY_REFRESH_MS`。证据使用独占创建，不覆盖已有验收历史。

真实浏览器重试成功。内置浏览器打开正式已安装包的本机 Web 服务，读取历史对话、卡片、搜索高亮及可信度详情。验收发现历史对话没有加载 Session 时面板失败，已改为按捕获的项目身份读取正式持久化日志，不启动 Agent；另修复 L0 已知召回与提炼记录露出 JSON，以及窄侧栏来源按钮溢出。最终安装包的 [L0 截图](../.artifacts/cards-browser-final-l0.jpg)确认方括号开头的正文与嵌套 L1 摘要均保留。搜索与刷新保留查询词，普通用户 JSON 不被重新解释。L1 展示主题、动作和结果；L3 当前版本展示原则、来源及生成详情，[历史 L3 截图](../.artifacts/cards-browser-final-lineage.jpg)确认旧来源版本触发待重新核实和暂停召回说明。

真实操作将 L2 加入下一轮后，侧栏和输入框展示 1 条待用记忆、正文及 290/8192 字节预算，见[发送前截图](../.artifacts/cards-browser-pending.jpg)。关闭自动召回，使用真实键盘输入发送；第 5 轮显示实际送入模型 1 条、待用归零，见[发送后截图](../.artifacts/cards-browser-used.jpg)。随后第 6 轮没有重复接纳，正式持久化证据见[浏览器收据核对](../.artifacts/cards-browser-receipt.json)。界面中的累计生成与失败可以同时存在；合成模型没有通用提炼质量保证。没有创建源码集成 PR，因此未录制 PR 展示 GIF。
