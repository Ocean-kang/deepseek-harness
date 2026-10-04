# Memory 0.1.8 独立交付验收

本记录覆盖 Windows 上 memory 0.1.8 的面板操作、构建包、独立安装及重启持久化。运行使用受支持的 DSH 0.2.0-rc.2 Web profile，模型为明确标注的 `memory-smoke/keyless` 合成适配器；没有使用外部真实模型或据此判断一般记忆质量。知识输入及原文核查的详细证据见[知识增长验收](knowledge-growth-2026-10-04.md)，服务端增量轮询及查询扩展见[面板与召回验收](panel-recall-2026-10-04.md)。

## 面板与共享轮询

[Client 检查](../tests/panel.client.spec.tsx)和[共享状态检查](../tests/state-observer.spec.ts)共 26 项通过。以下行为通过 React 组件、真实状态订阅实现及可控时钟验证；实际浏览器的视觉与交互证据另列于本记录末尾。

| 范围 | 已观察结果 |
|---|---|
| 逐条选择与批量加入 | 选择框位于每条可插入记忆的标题前。勾选只更新草稿；批量按钮保存 L2、L3 的精确版本，单条加入保留另一条未保存选择。L0、L1 显示只读说明。 |
| L1–L3 展示 | 卡片优先显示一句话 `description`；旧记录没有该字段时显示可读正文。详情保留完整内容、来源、证据说明与默认收起的 JSON。 |
| 单轮待用与收据 | 保存后的正文、数量和预算同时进入待用区域及输入框提醒。消费后待用归零，提醒改为已提交的模型上下文记录。 |
| 共用轮询 | 同一 Session 的侧栏和输入框共享一个 state 请求及计时器。关闭其中一个区域仍继续刷新；两者均关闭后没有新请求。 |
| 取消与失败 | 取消一个请求不会中断另一订阅；卸载抑制迟到状态。写入期间返回的旧状态会被丢弃。首次状态读取失败且尚无刷新间隔时，侧栏刷新和输入框 Retry 均可重新读取。订阅回调抛错会被记录，其他订阅、轮询和最终清理仍完成。 |

## 构建、安装与运行

最终包为 [deepseek-ai-dsh-memory-l0-0.1.8.tgz](../.artifacts/packages/deepseek-ai-dsh-memory-l0-0.1.8.tgz)，包含 12 个文件，SHA-256 为 `c7b81971d39f898ea99dc6aa584abc4c5b4bcdef192a4a4aac7ec53dbce85e72`。5 个构建文件分别为 `client.js`、`index.mjs`、`portable.mjs`、`src-aP9P39AD.mjs` 和 `workspace-storage-DWzMNBfH.mjs`，均直接从 tarball 读取并与最终源码构建的 `memory/lib/` 及已安装文件逐字节核对。包内另包含双语安装指南及升级指南；0.1.5、0.1.7 安装包保留，未发布的旧本地 0.1.8 包已由本次最终构建替换。

新隔离 profile 位于 `.artifacts/final-installed-018-l2shrxc1pih/home/profiles/web`。安装通过正式 `dsh plugin --profile web add` 操作，关闭安装生命周期脚本及自动安装 peer，并将 pnpm store、Corepack 缓存、home、临时文件、文档目录和日志限制在本次 memory 验收目录。安装输出有 peer 提示；运行由目标 DSH 提供声明的服务。没有修改根工作区依赖、配置或源码，没有创建提交或推送。

[安装文件核对](../.artifacts/final-installed-018-l2shrxc1pih/installed-files.json)记录版本及 11 个逐字节相同的构建、配置和指南文件。[正式 profile 夹具](../tests/fixtures/installed-delivery.mjs)从已安装 bundle 取得 memory 服务，没有叠加源码入口或本地 `lib` 入口；分别执行 `run` 和重启后的 `verify`，两次进程均正常退出。

| 运行阶段 | 已观察结果 |
|---|---|
| 新对话学习 | 新 source Session 生成 L1、L2、L3，逐层引用精确父版本。所有三层均保存非空展示描述，L2、L3 使用 `knowledge-v3`。 |
| 单条记忆的长原文 | L1 引用 9 个原始事件，序列化合计 100,082 字节，最大单事件 60,074 字节。L2、L3 各执行两个完整事件组，再执行 `merge-evidence`；请求均计入 system 与输入 JSON，最大 63,529 字节。夹具将每个模型请求中的原始事件与 source Session 原文逐项核对，两层最终 `examinedEvents` 均精确覆盖这 9 个引用。 |
| 手选与自动召回 | reader 首轮消费一条手选，下一轮没有再次消费；随后两轮自动召回均进入模型上下文。5 次 Agent 循环模型请求与正式持久化的召回消息逐项核对。 |
| 日志交付 | [运行报告](../.artifacts/final-installed-018-l2shrxc1pih/delivery.json)保留请求、三条精确记忆版本及两个 Session 日志，并导出通过当前 Session 格式编码的 [source JSONL](../.artifacts/final-installed-018-l2shrxc1pih/delivery.json.memory-installed-source-187bfabf-5d04-4339-8739-99829abdef31.jsonl) 和 [reader JSONL](../.artifacts/final-installed-018-l2shrxc1pih/delivery.json.memory-installed-reader-e78e6b50-7c15-40c4-83c0-803f75f1b6f3.jsonl)。 |
| 重启 | [重启报告](../.artifacts/final-installed-018-l2shrxc1pih/delivery.json.verified-trigram.json)确认三条历史版本的完整内容、展示描述、`examinedEvents` 及状态保留，旧日志前缀不变，待用为空、自动召回偏好保留；新增模型请求和召回均为零。两个恢复 Session 各追加一个受支持的 `session/end-seed` 标记。 |

## 已执行检查

构建和检查均从 `memory/` 执行，并使用 [environment.ps1](../scripts/environment.ps1) 限制写入位置。tsx 在沙箱初始化时出现 `uv_os_get_passwd / ENOMEM`；相同的相关测试、安装或 profile 启动命令升级到宿主后通过，没有绕过产品校验。

| 命令或操作 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs tests/panel.client.spec.tsx tests/state-observer.spec.ts` | 2 个文件、26 项通过。 |
| 主任务最终完整 Memory 检查 | 24 个文件通过，291 项通过、4 项条件跳过。 |
| `node ../node_modules/typescript/lib/tsc.js -p tsconfig.client.json --noEmit` | Client 类型检查通过。 |
| Client 适用严格 oxlint | 将根配置的共享及源码规则映射到 Client，5 个文件零诊断；临时配置位于 `.tmp/panel-lint.config.json`。不表示全仓库 lint 通过。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、独立入口及 Client 最终构建通过。 |
| `npm run pack:portable` | 0.1.8 安装包生成，12 个文件。 |
| 正式 `dsh plugin --profile web add` 及文件核对 | 新 profile 安装成功；构建文件、配置和随包指南一致。 |
| 正式 `dsh web` 的 installed-delivery 夹具 | `run` 与重启 `verify` 均通过，默认 trigram 和 3000ms 刷新配置符合报告。 |
| `git diff --check` 的本次 Client、测试及夹具范围 | 无空白错误。 |

## 实际浏览器证据

主任务的[实际浏览器与真实模型验收](browser-live-2026-10-04.md)记录最终源码构建的受支持 Web profile：原先因 69,833 字节原文而失败的同一任务重试后完成 L2、L3；1280×720 窗口中列表保留 130px 高度，16px 选择框实际可见，整块面板及正文、页脚可滚动。重启保留两条待用记忆、522 字节；发送后待用归零，输入框显示精确两条收据，下一轮没有重复消费。该报告另列真实 Provider 的模型调用及查询扩展证据，范围与本记录的合成安装验收分别注明。

这份记录确认插件安装、持久化、模型日志及确定性操作行为。容量、长来源链成本、模型事实判断及同义查询质量的限制分别由[知识增长](knowledge-growth-2026-10-04.md#容量与准确性限制)和[面板召回](panel-recall-2026-10-04.md#证据范围与限制)报告说明；没有执行跨平台安装、真实 Provider 的一般质量评价或端到端性能基准。
