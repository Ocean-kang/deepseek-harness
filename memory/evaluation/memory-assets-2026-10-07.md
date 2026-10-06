# 记忆资产侧栏与精简审计验收

本记录覆盖 `memory/` 的记忆资产侧栏布局与交互。设计参考用户提供的 TencentDB Agent Memory 截图及[项目说明](https://github.com/TencentCloud/TencentDB-Agent-Memory)。界面使用现有 L0–L3、具体版本详情、来源和待用接口；本次没有修改持久化字段、模型请求或召回语义。

## 精简审计

按 Ponytail 要求审读全部 `src/`，覆盖采集、SQLite 与工作区路由、请求日志、L1–L3 存储和提炼、文本与向量召回、注入、共享及 Host/Client 面板；同时核对全部开发脚本、profile、fixture、编译与构建配置、导出入口及文档引用。删除依据来自实际调用和配置加载关系，未按零静态引用直接删除公开接口。

| 精简 | 保留的行为 |
|---|---|
| 采集器只要求 `appendRaw`，删除工作区和两个测试 adapter 的 `readRaw` 转发。 | 恢复仍读权威 Session 持久化；公共 `RawMemory.readRaw` 不变。 |
| 知识提炼复用同文件 `eventRefs`，删除重复的来源去重计算。 | 原始证据顺序、具体版本和引用校验不变。 |
| HTTP embedding 改用参数属性；删除索引批次无人读取的返回值。 | 认证、超时、重试、用量、并发等待和错误处理不变。 |
| 面板状态通知删除同步更新外的临时控制器；类型直接导入实际所有者。 | 读取仍由 `reload` 取消并报告错误，标签页终止后不再应用通知。 |
| 文档检查自动发现并排序 `evaluation/*.md`。 | 链接、双语结构、行数和配对记录检查继续执行。 |
| 删除未使用的 `tests/fixtures/recovery.patch.yml`。 | 此文件仅覆盖数据库路径，没有当前 Loader 或脚本调用；`collector.spec.ts`、`plugin.spec.ts`、`workspace-storage.spec.ts` 保留恢复验证。 |

公开 worker 的 `watch`、`retire` 和恢复接口、持久化迁移及历史提示词、安装与源码 profile、独立依赖链接入口均保留。动态加载 fixture 与负向类型编译检查仍有消费者。历史验收材料保留安装、重启、真实 Provider 和容量证据；用户数据与忽略的构建产物不属于删除范围。双语 README 同步采集器实际依赖，纠正 worker 仍被描述为未来组合的过时文字。

## 展示与交互

层级导航展示名称和用途，资产列表展示层级、版本、有效状态及正文摘要，并高亮正在阅读的当前版本。已加载数量统计当前层级已加载的分页，累计生成数量保留独立说明。宽度达到 640 像素的面板并排展示列表和详情，较窄面板将详情放在列表上方。详情包含正文、来源、评分、生成信息、原始 JSON 和历史版本；下一轮待用区保留跨层选择及自动召回开关。

定向交互测试验证详情打开后的标题焦点、刷新时的输入焦点保留、关闭后返回原条目、双语分页计数、跨层选择、手选保存、历史版本、搜索分页和来源失效。[中文](../tests/expected/panel-assets.zh.json)与[英文](../tests/expected/panel-assets.en.json)展示快照固定分类名称、当前层级、资产正文和操作文案；它们是合成数据的 DOM 文本预期，不是浏览器截图或真实模型录制。CSS 使用现有主题颜色和字号变量；实际明暗主题对比及宽窄窗口排版尚未完成浏览器验收。

## 已执行检查

以下命令从 `memory/` 执行，先加载 `scripts/environment.ps1 -ProjectId 'memory-panel-design'`；缓存、临时输出和构建均限制在本目录。tsx 在沙箱内遇到 `uv_os_get_passwd / ENOMEM`，对应检查通过同一执行方式的宿主重试完成。

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs tests/panel.client.spec.tsx tests/panel-host.spec.ts tests/browser.spec.ts` | 3 个文件、41 项通过。 |
| `node ../node_modules/typescript/lib/tsc.js -p tsconfig.client.json --noEmit` | Client 类型检查通过。 |
| `node ../node_modules/oxlint/bin/oxlint --config .tmp/panel-lint.config.json --tsconfig tsconfig.client.json src/client/MemoryPanel.tsx src/client/locales.ts` | 两个 Client 文件零诊断；采用既有目录内严格规则配置。 |
| 仓库 `findUiI18nViolations` 检查函数 | 两个 Client 文件通过文案归属检查；版本格式属于双语词典。 |
| `node --import tsx/esm scripts/check-docs.mjs --write-pairing` | 16 份文档链接及 3 组双语结构、行数与配对记录通过。 |
| `node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native` | Host、portable 与 Client 构建通过。 |
| `git diff --check` | 无空白错误。 |

精简后加载 `scripts/environment.ps1 -ProjectId 'memory-audit'`，执行以下检查：

| 检查 | 结果 |
|---|---|
| `node --import tsx/esm scripts/test.mjs` | 24 个文件、296 项通过；4 个显式启用的验收文件及其 4 项测试跳过。包含现有来源、恢复、学习、召回及展示预期输出。 |
| Host 与 Client `tsc --noEmit --noUnusedLocals --noUnusedParameters` | 两个编译配置均通过。 |
| 既有目录内严格配置检查三个改动的 Client 文件 | 零诊断。 |
| 仓库 `.oxlintrc.staged.json` 检查全部改动的 TS/TSX/MJS 文件 | 通过；工作区文件的一条既有 suppression 提示在禁用类型检查时未使用。 |
| Host 五个改动文件套用额外严格配置 | 未通过，包含非空断言、未使用 catch 参数及类型感知规则诊断；此配置另行映射了仓库 source 规则，不能据暂存检查通过推断其通过。 |
| Host、portable 与 Client 构建 | 通过。 |

真实学习结果复核、真实 embeddings、profile 全量复制和容量基准均要求显式环境设置，本轮未启用；未由合成回归测试推断真实模型质量。

## 浏览器限制

`node scripts/workspace-web-smoke.mjs` 通过受支持的 `dsh web` profile 启动隔离的合成模型验收服务器，启用仓库要求的 in-page directory picker overlay。服务器在 `http://127.0.0.1:62749` 就绪，全部数据保存在 `.artifacts/workspace-web-3xdktV/`。浏览器工具首次打开及绑定原标签页后再次导航均返回 `ERR_BLOCKED_BY_CLIENT`，页面没有加载。未完成真实 Web 交互、截图、GIF 或视觉验收，也未据此声明真实模型质量。验收服务器已停止。
