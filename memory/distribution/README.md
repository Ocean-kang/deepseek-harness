---
description: "Install portable DSH memory and browse or select memories for ordinary conversations."
kind: "package-bundle"
---

# Portable memory

English | [中文](README.zh.md)

## Summary

Browse L0–L3, select L2/L3 for one conversation turn, or enable BM25 automatic recall. Background learning reuses the model and credentials already configured in DSH; no embedding key is needed.

## Table of Contents

- [Install and use](#install-and-use)
- [Data and configuration](#data-and-configuration)
- [Known limitations](#known-limitations)

<a id="install-and-use"></a>
## Install and use

Memory 0.1.16 targets the Web profile of DSH 0.2.1-rc.3. Its DSH peer declarations reject other runtime versions. Download the built archive and install it through DSH; source compilation and changes to DSH code are unnecessary.

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.16.tgz
dsh --profile web
```

To upgrade, stop DSH and back up the [memory directories](#data-and-configuration), including SQLite sidecars. Install 0.1.16 in the same DSH home and restart. Databases migrate to schema 7; rollback requires the backup. Custom consumers must await memory operations and use trace pagination; follow the [reliability upgrade guide](reliability-upgrade.md). Installations on earlier DSH versions, including 0.2.1-alpha.2, must first update DSH to 0.2.1-rc.3. No `allow-version` exemption is needed. Source overlays rebuild `memory/lib` and restart with their existing patch arguments. Upgrades from memory 0.1.8 also follow the [layered-memory guide](layered-upgrade.md).

The panel uses the official Web `connection` dependencies and `POST /api/memory/panel`. Reload open browser tabs after installing 0.1.16 so Client and Host use the same APIs. Remove any local `connection` override containing `webRuntime`; it is a plugin ID, not a service. Confirm that the Memory tab loads and a next-turn selection survives reload. Custom callers of the former `/memory/panel` route use the shared API with RPC method `memory/panel`.

Open Memory in the conversation sidebar. L1 displays task goals, problems, results and solutions; its trace and sources are collapsed. L2 groups readable knowledge cards by scenario. L3 separates engineering knowledge and interaction profiles. Summaries arrive with extraction. Select eligible L2/L3 for one turn; the pending area and composer show saved text and budget. New conversations default to automatic L1–L3 recall; saved explicit switches retain their values. The read-only `memory_search` tool supports follow-up searches. Learning and recall remain independent. Source replacement or invalidation pauses derived recall while exact history remains readable. See the [layered-memory upgrade](layered-upgrade.md).

Reopen a previously captured conversation after restart to browse memory, inspect admitted text and save next-turn selections. The panel reads its captured SQLite L0 prefix incrementally even before the Session is loaded. These operations do not start an Agent, append recovery markers or repeatedly read the canonical log.

In a bound Workspace, open historical import, filter Sessions by creation time, preview pages and select sources to copy. Import follows `autoLearning`: enabled learning can call the configured model; disabled learning only copies L0. Progress survives restart, repeated imports deduplicate, and cancellation keeps committed data and queued learning. Expand L1 trace to read its complete JSON text in pages. Cleanup preview shows expired whole Sessions and protected data; manual cleanup preserves retained evidence. Automatic cleanup requires `retention.maxAgeDays`. Use explicit compaction when reusable database pages must be returned to the filesystem.

<a id="data-and-configuration"></a>
## Data and configuration

The bundle enables capture, background learning and next-turn injection through the existing DSH model route and credentials. New `l1-v4` / `knowledge-v6` tasks generate readable fields and descriptions in one extraction response per bounded group; large sources may need multiple groups and merges. `supported` remains a semantic model judgment; program-checked execution and trusted confirmation have distinct evidence statuses. Schema 7 retains existing generations, import progress, cleanup exclusions and paged traces, and adds execution-evidence audits and persistent incremental indexes. Knowledge extraction omits complete trace while verifying exact L0 evidence.

With the default `storageMode: workspace`, all project L0–L3 records, versions, learning tasks and pending selections live in `<workspace>/memory_<workspaceUUID>/memory.sqlite`. The UUID is the registered DSH Workspace ID. Conversations in the same Workspace share that database. A conversation without a matching Workspace uses `$DSH_HOME/memory/workspace-memory.sqlite`, or `~/.dsh/memory/workspace-memory.sqlite` when `DSH_HOME` is absent. Stop every DSH process using a database before copying its directory, including SQLite sidecars.

First use stores an activation time in the global memory directory's `workspace-storage.json`. Automatic capture admits conversations created at or after that time. Explicit historical import separately admits selected older Sessions without changing the activation time. Cleaned Sessions carry exclusions that stop automatic recovery from restoring them; explicit import can admit them again. A new fork does not extract inherited turns. Restarting restores stored project tasks without opening the source conversation. Existing centralized databases are untouched and are not imported.

Overrides target entry `memory-l0` in the profile patch. `storageMode: central` explicitly selects the earlier single-database behavior, with `dataRoot` as the absolute data directory and `databasePath` relative to it. In workspace mode, `dataRoot` holds activation state and unassigned-conversation data; `databasePath` does not select a project's database. `autoLearning` controls background calls, `injection` controls recall, and `browser` controls page and body budgets. The portable entry resolves omitted settings. Workspace mode uses `workspace.id` for projects and `projectId` for unassigned conversations; `projectByPath` applies only to central mode.

SQLite operations and persistent incremental FTS run in a bounded storage worker pool; `storageWorkers` defaults to 4. `queueMaxBytes` defaults to 8 MiB, `pageMaxBytes` to 256 KiB and `tracePageMaxBytes` to 64 KiB. Count limits remain effective; a single oversized event is processed alone, and capture overflow recovers from the source log. `storageQueueCapacity` defaults to 128 requests and `storageQueueMaxBytes` to 8 MiB. Automatic cleanup is disabled without `retention.maxAgeDays`; its configured `retention.intervalMs` defaults to 86400000. Retention uses the last event time and preserves current knowledge, pending selections, unfinished tasks, active Sessions, granted versions and their complete evidence and extraction journals.

Workspace mode disables `/memory-share` and all cross-project recall. A missing or unwritable Workspace directory, a redirected memory path, or a failed database open reports an error and retains the canonical Session log for retry; project data is never redirected to the global store. Directory checks reject existing links but cannot prevent another process replacing a directory concurrently.


Web services enable the panel unless `panel: false`. BM25 defaults to trigram; short Chinese terms use substring matching. Query expansion defaults off; explicitly enabling `textSearch.expandQuery` permits: on no hits, one logged L1-model call suggests terms before one further search. Explicit `textSearch` objects default expansion off. Panel browsing searches one selected level, with scenario and knowledge/profile filters. Optional `embedding` enables BM25 + vectors + RRF and requires `endpoint`, `model`, `dimensions` and `apiKeyEnv`; `hybrid` controls rank and result budgets. No embedding credentials are required for BM25 alone.

<a id="known-limitations"></a>
## Known limitations

This independent archive requires no DSH source changes. Acceptance evidence and recorded Session expectations remain with the plugin source; synthetic fixtures and individual real-model samples do not establish general memory quality. Other operating systems and untested DSH or SDK versions remain unverified. Automatic capture follows loaded Sessions, while explicit historical import reads the current Workspace's persisted sources. JSONL cold reads and individual oversized events can still exceed plugin page budgets. Retained evidence can outlive its configured age, so retention does not impose a fixed disk-size limit. L0 retains attachment and spill references rather than copying binary files. No L4 or synchronization is provided.
