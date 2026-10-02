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

This bundle targets the Web profile of DSH 0.2.0-rc.2. Its DSH peer declarations reject other runtime versions. Download the built archive and install it through DSH; source compilation and changes to DSH code are unnecessary.

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.5.tgz
dsh --profile web
```

Open a conversation and choose Memory in the right sidebar. Browse L0–L3 and inspect exact bodies, sources and historical versions. Select L2/L3 and save the next-turn selection; it is consumed after recall commits to the Session log. Automatic recall defaults off for each conversation: enable its switch and save to use BM25. Both paths share version and permission checks, deduplication, and a default budget of five records and 8192 rendered bytes. Reload the panel after a turn to inspect the exact memories used.

<a id="data-and-configuration"></a>
## Data and configuration

The bundle enables capture, background learning and next-turn injection without a custom patch. The model route is read from the DSH default when the plugin loads. Background learning makes model calls using existing DSH credentials; automatic retrieval itself makes no embedding calls.

With the default `storageMode: workspace`, all project L0–L3 records, versions, learning tasks and pending selections live in `<workspace>/memory_<workspaceUUID>/memory.sqlite`. The UUID is the registered DSH Workspace ID. Conversations in the same Workspace share that database. A conversation without a matching Workspace uses `$DSH_HOME/memory/workspace-memory.sqlite`, or `~/.dsh/memory/workspace-memory.sqlite` when `DSH_HOME` is absent. Stop every DSH process using a database before copying its directory, including SQLite sidecars.

First use stores an activation time in the global memory directory's `workspace-storage.json`. Only conversations created at or after that time are captured and can recall memory. Reopening an older conversation does not import its history; start a new conversation instead. A new fork does not extract inherited turns. Restarting restores stored project tasks without requiring the source conversation to be open. Existing centralized databases are untouched and are not imported.

Overrides target entry `memory-l0` in the profile patch. `storageMode: central` explicitly selects the earlier single-database behavior, with `dataRoot` as the absolute data directory and `databasePath` relative to it. In workspace mode, `dataRoot` holds activation state and unassigned-conversation data; `databasePath` does not select a project's database. `autoLearning` controls background calls, `injection` controls recall, and `browser` controls page and body budgets. The portable entry resolves omitted settings. Workspace mode uses `workspace.id` for projects and `projectId` for unassigned conversations; `projectByPath` applies only to central mode.

Workspace mode disables `/memory-share` and all cross-project recall. A missing or unwritable Workspace directory, a redirected memory path, or a failed database open reports an error and retains the canonical Session log for retry; project data is never redirected to the global store. Directory checks reject existing links but cannot prevent another process replacing a directory concurrently.


The panel is enabled when Web services are available; `panel: false` disables its RPC registration. BM25 is the default retrieval mode. Supplying `embedding` selects vector retrieval without adding BM25; supplying both `embedding` and `textSearch` is rejected. Vector retrieval requires an explicit `endpoint`, `model`, `dimensions` and `apiKeyEnv`; the named environment variable supplies its credential.

<a id="known-limitations"></a>
## Known limitations

Verification covers Windows installation, upgrade, restart, learning and manual/automatic recall with a keyless synthetic model fixture. Real-model learning has a separate single-sample check; neither demonstrates general memory quality. Other operating systems and both SDK projections remain unverified. Only Sessions loaded while the plugin is active are captured. No L4, synchronization, retention or bulk history import is provided.
