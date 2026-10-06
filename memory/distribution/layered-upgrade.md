---
kind: upgrade-guide
description: "Upgrade memory 0.1.9 to structured episodes, scenario cards, L3 recall and optional hybrid search."
---

# Layered memory upgrade

English | [中文](layered-upgrade.zh.md)

## Change

Memory 0.1.10 on DSH 0.2.1-alpha.1 creates `l1-v3` episodes and `knowledge-v4` scenario cards with descriptions in the extraction response. Automatic recall searches L3; explicit browsing, retrieval and manual L2 selection remain available. Embedding configuration enables BM25 plus vectors with RRF. Stable methods require program-checked successful execution ancestry. Historical `supported` is displayed as model support, not verified execution.

SQLite schema 5, L0 events, version history, candidates, tasks and source references are preserved. Old unfinished tasks keep their saved prompt versions and display-call behavior. New JSON fields are optional on historical reads. Old readers do not support the new prompt versions; use a backup for rollback rather than reopening new data with memory 0.1.9.

## Migration

1. Stop processes using memory and copy each memory directory with SQLite sidecars. Install the 0.1.10 archive using the existing DSH Web profile and restart; see [installation](README.md#install-and-use).
2. Keep `autoLearning` and the conversation's automatic-recall preference configured independently. Browse L2 by scenario when project context is needed; inspect L1 for execution history and L0 for original evidence.
3. If embeddings are configured, inspect hybrid index readiness before enabling recall. Optional `hybrid` fields are `rrfK`, `candidateLimit`, `limit` and `maxBytes`; they default to 60, 20, 5 and 8192. BM25 requires no embedding key.
4. Existing records remain readable. Explicit re-extraction creates new versions with current fields; it does not rewrite old versions. Methods lacking program-checked ancestors need fresh successful execution before promotion.
5. Confirm that new cards show conclusions and evidence origin, trace and sources start collapsed, and a recalled turn records exact L3 references in its Session. Trusted user/external confirmations require `KnowledgeStore.confirmEvidence` receipts; the extraction model cannot create them.
