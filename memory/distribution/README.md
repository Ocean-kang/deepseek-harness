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

Memory 0.1.10 targets the Web profile of DSH 0.2.1-alpha.1. Its DSH peer declarations reject other runtime versions. Download the built archive and install it through DSH; source compilation and changes to DSH code are unnecessary.

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.10.tgz
dsh --profile web
```

To upgrade from memory 0.1.8 on DSH 0.2.0-rc.2, stop DSH, back up the [memory directories](#data-and-configuration), update DSH to 0.2.1-alpha.1, then run the installation command above in the same DSH home and restart. Memory's SQLite schema and producer-owned Session fields are unchanged. No `allow-version` exemption is needed. For a source overlay, rebuild `memory/lib` and restart with the same patch arguments. Memory 0.1.8 remains the package for DSH 0.2.0-rc.2; do not use memory 0.1.10 on that runtime.

Open Memory in the conversation sidebar. L1 displays task goals, problems, results and solutions; its trace and sources are collapsed. L2 groups readable knowledge cards by scenario. L3 separates engineering knowledge and interaction profiles. Summaries arrive with extraction. Select eligible L2/L3 for one turn; the pending area and composer show saved text and budget. Automatic recall defaults off and searches only L3 when enabled. Learning and recall remain independent. Source replacement or invalidation pauses derived recall while exact history remains readable. See the [layered-memory upgrade](layered-upgrade.md).

Reopen a previously captured conversation after restart to browse memory, inspect admitted text and save next-turn selections. The panel reads its captured SQLite L0 prefix incrementally even before the Session is loaded. These operations do not start an Agent, append recovery markers or repeatedly read the canonical log.

<a id="data-and-configuration"></a>
## Data and configuration

The bundle enables capture, background learning and next-turn injection through the existing DSH model route and credentials. New `l1-v3` / `knowledge-v4` tasks generate readable fields and descriptions in one extraction response per bounded group; large sources may need multiple groups and merges. `supported` remains a semantic model judgment; program-checked execution and trusted confirmation have distinct evidence statuses. Candidate and task checkpoints, source refs and restart recovery remain durable. SQLite schema 5 and existing generations remain intact; new optional JSON fields and prompt versions are described in the [upgrade guide](layered-upgrade.md).

With the default `storageMode: workspace`, all project L0–L3 records, versions, learning tasks and pending selections live in `<workspace>/memory_<workspaceUUID>/memory.sqlite`. The UUID is the registered DSH Workspace ID. Conversations in the same Workspace share that database. A conversation without a matching Workspace uses `$DSH_HOME/memory/workspace-memory.sqlite`, or `~/.dsh/memory/workspace-memory.sqlite` when `DSH_HOME` is absent. Stop every DSH process using a database before copying its directory, including SQLite sidecars.

First use stores an activation time in the global memory directory's `workspace-storage.json`. Only conversations created at or after that time are captured and can recall memory. Reopening an older conversation does not import its history; start a new conversation instead. A new fork does not extract inherited turns. Restarting restores stored project tasks without requiring the source conversation to be open. Existing centralized databases are untouched and are not imported.

Overrides target entry `memory-l0` in the profile patch. `storageMode: central` explicitly selects the earlier single-database behavior, with `dataRoot` as the absolute data directory and `databasePath` relative to it. In workspace mode, `dataRoot` holds activation state and unassigned-conversation data; `databasePath` does not select a project's database. `autoLearning` controls background calls, `injection` controls recall, and `browser` controls page and body budgets. The portable entry resolves omitted settings. Workspace mode uses `workspace.id` for projects and `projectId` for unassigned conversations; `projectByPath` applies only to central mode.

Workspace mode disables `/memory-share` and all cross-project recall. A missing or unwritable Workspace directory, a redirected memory path, or a failed database open reports an error and retains the canonical Session log for retry; project data is never redirected to the global store. Directory checks reject existing links but cannot prevent another process replacing a directory concurrently.


Web services enable the panel unless `panel: false`. BM25 defaults to trigram; short Chinese terms use substring matching. Portable query expansion remains optional: on no hits, one logged L1-model call suggests terms before one further search. Explicit `textSearch` objects default expansion off. Panel browsing searches one selected level, with scenario and knowledge/profile filters. Optional `embedding` enables BM25 + vectors + RRF and requires `endpoint`, `model`, `dimensions` and `apiKeyEnv`; `hybrid` controls rank and result budgets. No embedding credentials are required for BM25 alone.

<a id="known-limitations"></a>
## Known limitations

This is an independent plugin archive for the declared DSH version; installing it requires no DSH source changes. Its acceptance evidence and recorded Session expectations remain with the plugin source. Verification covers Windows installation, upgrade, restart, learning and manual/automatic recall with a keyless synthetic model fixture. Real-model learning has a separate single-sample check; neither demonstrates general memory quality. Other operating systems and untested DSH or SDK versions remain unverified. Only Sessions loaded while the plugin is active are captured. No L4, synchronization, retention or bulk history import is provided.
