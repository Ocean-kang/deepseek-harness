# Memory 0.1.8 浏览器及真实模型验收

本记录使用最终 0.1.8 构建，在 Windows 的受支持 DSH Web/headless profile 中验证实际交互及一次真实模型学习。全部数据库、home、日志、缓存和截图均位于 `memory/`。安装包及安装重启证据见[交付验收](delivery-0.1.8-2026-10-04.md)。

## 浏览器连接与原失败任务

初次浏览器控制返回 `ERR_BLOCKED_BY_CLIENT`；本地 Codex 日志同时记录没有可用的浏览器路由。公共页面可以打开，Chrome provider 连标签页清单也无法读取。通过 Codex 浏览器面板打开本地认证 URL，再由 CUA 操作该页面后，本地路由恢复，后续导航和交互均成功。没有确定是哪个浏览器组件最先阻断连接，不能据此断言 localhost 或私网地址不受支持；[官方浏览器说明](https://learn.chatgpt.com/docs/browser)列明 localhost 开发用法。本次没有关闭用户浏览器、改变安全设置或改用独立 Playwright。

实际验收数据库为 `.artifacts/workspace-web-AKFYX5/documents/deepseek-harness/default-workspace/memory_4261d006-aad6-4cfc-a041-356be477af41/memory.sqlite`。原 L1 引用 11 条完整 L0 事件，合计 69,833 字节、最大单事件 26,234 字节；旧构建的同一个 v3 L2 操作处于 `failed / budget / calls=0`。重启最终运行时，通过 mounted memory 服务显式重试该操作；L2 完成四次调用，随后 L3 也完成四次调用，两层均保存展示描述和检查列表。全部事件保留，没有通过删除来源或提高 65,536 字节默认预算让任务通过。

## 真实 Web 交互

CUA 在 1280×720 窗口操作受支持的 Web profile；模型为明确标注的 `memory-smoke/keyless` 合成适配器。最终页面使用 `http://127.0.0.1:57168`，不在报告保存认证 URL。持久化核验见[浏览器结果](../.artifacts/workspace-web-AKFYX5/browser-proof.json)。

| 操作 | 实际观察 |
|---|---|
| 分层展示及只读范围 | L1–L3 卡片展示单独生成的一句话描述；L2/L3 标题前有选择框。L0/L1 保留查看及追溯来源，不提供手选注入。 |
| 跨层选择 | 勾选一条 L2、切换 L3 再勾选一条，批量加入下一轮。侧栏和输入框均显示两条待用，完整参考正文为 522/8192 字节。 |
| 重启保留 | 更换最终 CSS 构建后重启同一个 Web 数据目录，两条待用及精确版本仍在，未重新选择。 |
| 单轮消费 | 第 2 轮发送后待用归零，输入框显示“第 2 轮已送入模型上下文 2 条记忆”；保存的召回事件有两条 `selected: true`。第 3 轮不再选择时没有新召回事件。 |
| 查询扩展 | 开启自动召回，发送文本无命中的“模块规范”。持久辅助 Session 记录一次 `expand-query`，合成模型返回 `ESM` 搜索词；第 4 轮记录五条自动召回，全部 `selected: false`，没有手选消费。此样例验证回退流程，不衡量真实模型的同义理解质量。 |
| 短窗口 | 两条待用曾将列表挤到约 6.6 像素；最终构建在同一窗口保留 130 像素正文区，16 像素选择框和描述均可见。整个面板的滚动区域为 805 像素，下方批量按钮可滚达并成功操作。 |

[布局修复后的截图](../.artifacts/workspace-web-AKFYX5/frames/selected-two-memories-fixed.jpg)展示选择框、一句话摘要及待用区；[发送后的截图](../.artifacts/workspace-web-AKFYX5/frames/manual-injection-receipt.jpg)展示已提交的两条记忆收据。原问题截图保留用于比较：[被挤压的列表](../.artifacts/workspace-web-AKFYX5/frames/selected-two-memories.jpg)。

第 4 轮正常学习成功；同时，一个较旧的自动 L3 重核在目标已换代后记录 `TARGET_CHANGED / calls=0`，未发布过期结果。该历史失败仍可检查，不能将它算作当前版本的预算失败或隐藏为成功。

## 一次真实 Provider 学习

最终构建通过已有 `deepseek-official/deepseek-flash` 路由和凭据运行 [learning-live profile](../profiles/learning-live.patch.yml)，处理一条明确标注未实施、未运行测试的长期项目约束：使用 strict TypeScript 和 ESM。输出见[真实运行结果](../.artifacts/live-final-2026-10-04.json)，完整受控日志位于 `.artifacts/live-final-2026-10-04.log`。

| 检查 | 结果 |
|---|---|
| L1→L2→L3 | 三层任务均 `done`，每层提炼和描述各一次，共六次模型调用；没有失败。 |
| 内容与召回 | L3 保留 strict TypeScript/ESM 约束，同时保留仅为用户声明、没有实施或测试的限定；文本检索命中一条 L3。 |
| 重开核验 | 指定本次 `sourceSession` 和数据库重开，`learning-live` 的一项 opt-in 测试通过。三层描述、L2/L3 原文检查引用、准确祖先和六次请求/流结果结算全部保留；核验没有再调用模型。 |

已执行命令为 `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/learning-live.patch.yml 'Validate automatic memory learning and text retrieval.'`；核验设置 `DSH_MEMORY_VERIFY_LEARNING=1`、本次准确来源 Session 和数据库路径后运行 `node --import tsx/esm scripts/test.mjs learning-live`。tsx 沙箱初始化的 `uv_os_get_passwd / ENOMEM` 通过同一命令的窄范围宿主重试处理。

最终 memory 行为集为 24 个文件、291 项通过，另有四项按需检查跳过；上述真实 Provider 核验单独通过一项。Host、Client 类型检查、新模型请求代码及 Client 的适用严格 lint 均通过；没有执行全仓库测试或大规模性能基准。此记录覆盖一个真实学习样例及合成 Web 交互，不建立一般事实准确性或召回率结论；单条必要原文超过预算等限制见[知识增长说明](knowledge-growth-2026-10-04.md#容量与准确性限制)。
