---
kind: upgrade-guide
description: "Upgrade memory recall defaults, execution evidence and persistent text indexes."
---

# Memory reliability upgrade

English | [中文](reliability-upgrade.zh.md)

## Change

Version 0.1.14 upgrades SQLite schema 6 to 7. Execution evidence requires consistent explicit success fields: `success: true, exitCode: 1` and `success: false, exitCode: 0` cannot establish successful execution. Historical successful L1 versions are quarantined until their original tool records pass policy-2 auditing. Invalid or unavailable evidence also suspends derived recall and consolidation; original events, summaries, versions and independent confirmation receipts remain available.

New conversations automatically recall L1–L3. Saved explicit conversation switches retain their values. `recall.automatic` and `recall.levels` configure these defaults. The installable bundle exposes the read-only `memory_search` tool; direct mounts enable it with `searchTool: true` and require the tools service. Query expansion defaults off, including in the bundle; `textSearch.expandQuery: true` explicitly enables its extra model call.

New tasks use `l1-v4` and `knowledge-v6` to retain explicit user declarations without claiming successful execution. Existing tasks retain their recorded prompts and budgets. A user's policy statement can support a constraint; successful methods still require checked tool evidence. Re-extract an old empty result through the task API to apply the new prompts.

Text retrieval uses persistent requester-isolated FTS corpora. `textSearch.maxCandidates` limits matching candidates processed for a query, rather than total library size. A top-result query can succeed in a library larger than that limit; an exhausted processing budget is reported as an error. `indexTimeoutMs` defaults to 60000 and bounds resumable index synchronization separately from the online query timeout. `browser.stateCacheSessions` also bounds retained filter corpora; evicted corpora rebuild when requested. `scanned` counts processed matches. BM25 scores remain meaningful only within the queried corpus.

Workspace storage uses at most `storageWorkers` workers, default 4, with ordered operations per database. Knowledge consolidation selects at most `knowledge.maxExisting` existing candidates, default 64, before loading their full content; `knowledge.maxSearchTerms` defaults to 64. Required targets and source-linked candidates cannot be silently omitted.

## Migration

1. Stop DSH and back up each memory directory, including SQLite sidecar files. Install the new package through the supported profile and restart. Older binaries cannot open schema 7; rollback requires the complete backup.
2. Set `recall: { automatic: false }` to retain opt-in recall for conversations without saved preferences, or choose a narrower `recall.levels`. Existing saved preferences take precedence.
3. Enable `textSearch.expandQuery` only when the additional model call is wanted. Configure the L1 model and LLM service when enabling it. Keep `searchTool: false` on direct mounts that do not supply the tools service.
4. Allow the initial evidence audit and text indexing to finish. An interrupted audit resumes from stored verdicts; index synchronization retains completed pages. Inspect `l1.executionAudit(project, ref)` for a quarantined version. Missing source logs require restoring the evidence; invalid success claims require explicit re-extraction through the existing task API.
5. Update consumers that interpret `scanned`, index capacity or `maxCandidates`. Confirm current-version retrieval, explicit recall switches, shared-grant revocation and restart recovery before resuming ordinary use. Use the evaluation report for measured capacity and sample-specific quality results.
