---
kind: upgrade-guide
description: "将 memory 0.1.9 升级为结构化经历、场景知识卡、L3 召回及可选混合检索。"
---

# 分层记忆升级

[English](layered-upgrade.md) | 中文

## 变更

DSH 0.2.1-alpha.1 上的 memory 0.1.10 创建 `l1-v3` 经历和 `knowledge-v4` 场景知识卡，在提炼响应中生成描述。自动召回搜索 L3；显式浏览、检索及手选 L2 继续可用。Embedding 配置启用 BM25 与向量的 RRF 融合。稳定方法必须有程序核验成功执行的祖先。历史 `supported` 展示为模型支持，不是执行验证。

SQLite schema 5、L0 事件、版本历史、候选、任务及来源引用保留。未完成的旧任务继续使用保存的提示词版本和展示调用行为。历史读取允许缺省新增 JSON 字段。旧读取器不支持新版提示词；回退时使用备份，不要用 memory 0.1.9 打开新数据。

## 迁移

1. 停止使用记忆的进程，复制每个记忆目录及 SQLite sidecar。通过已有 DSH Web profile 安装 0.1.10 包后重启；参见[安装说明](README.zh.md#install-and-use)。
2. 独立配置 `autoLearning` 和对话自动召回偏好。需要项目背景时按场景浏览 L2，需要执行历史时查看 L1，需要原始证据时查看 L0。
3. 配置 embedding 后，开启召回前检查混合索引就绪状态。可选 `hybrid` 字段为 `rrfK`、`candidateLimit`、`limit`、`maxBytes`，默认 60、20、5、8192。BM25 不需要 embedding 密钥。
4. 已有记录继续可读。显式重新提炼按当前字段创建新版本，不改写旧版本。缺少程序核验祖先的方法须有新成功执行后才能晋升。
5. 确认新知识卡展示结论和证据来源，trace 与来源默认折叠，召回轮次在 Session 中记录精确 L3 引用。可信用户/外部确认要求 `KnowledgeStore.confirmEvidence` 回执，提炼模型不能创建这些回执。
