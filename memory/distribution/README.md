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

Memory 0.1.9 targets the Web profile of DSH 0.2.1-alpha.1. Its DSH peer declarations reject other runtime versions. Download the built archive and install it through DSH; source compilation and changes to DSH code are unnecessary.

```sh
dsh plugin --profile web add ./deepseek-ai-dsh-memory-l0-0.1.9.tgz
dsh --profile web
```

To upgrade from memory 0.1.8 on DSH 0.2.0-rc.2, stop DSH, back up the [memory directories](#data-and-configuration), update DSH to 0.2.1-alpha.1, then run the installation command above in the same DSH home and restart. Memory's SQLite schema and producer-owned Session fields are unchanged. No `allow-version` exemption is needed. For a source overlay, rebuild `memory/lib` and restart with the same patch arguments. Memory 0.1.8 remains the package for DSH 0.2.0-rc.2; do not use memory 0.1.9 on that runtime.

Open a conversation and choose Memory in the right sidebar. New L1–L3 cards show a separately generated one-sentence description; detail keeps full content, sources, scores, evidence and folded JSON. Select eligible L2/L3 with the checkbox at the start of each card, then add selected records to the next turn. The pending area and composer show saved text, count and budget. Selections are consumed after recall commits; automatic recall defaults off and its switch persists independently. Both paths check versions, ancestry, permissions and a default budget of five records and 8192 rendered bytes. Shared polling preserves search and reading position. Inspect the committed context receipt after sending. Obsolete sources pause recall and trigger eligible rechecks while history stays readable.

Reopen a previously captured conversation after restart to browse memory, inspect admitted text and save next-turn selections. The panel reads its captured SQLite L0 prefix incrementally even before the Session is loaded. These operations do not start an Agent, append recovery markers or repeatedly read the canonical log.

<a id="data-and-configuration"></a>
## Data and configuration

The bundle enables capture, background learning and next-turn injection without a custom patch. Its model route is read from the DSH default at load. New L1–L3 memories require extraction followed by one display-description call per final memory, within the same task budget. New L2/L3 extraction includes the original L0 evidence cited by its ancestry; `supported` remains a model judgment and reference validation. Existing versions remain readable. Bounded input selection and source grouping avoid failures caused solely by accumulated knowledge; an individual source or original event that cannot fit still fails explicitly.

With the default `storageMode: workspace`, all project L0–L3 records, versions, learning tasks and pending selections live in `<workspace>/memory_<workspaceUUID>/memory.sqlite`. The UUID is the registered DSH Workspace ID. Conversations in the same Workspace share that database. A conversation without a matching Workspace uses `$DSH_HOME/memory/workspace-memory.sqlite`, or `~/.dsh/memory/workspace-memory.sqlite` when `DSH_HOME` is absent. Stop every DSH process using a database before copying its directory, including SQLite sidecars.

First use stores an activation time in the global memory directory's `workspace-storage.json`. Only conversations created at or after that time are captured and can recall memory. Reopening an older conversation does not import its history; start a new conversation instead. A new fork does not extract inherited turns. Restarting restores stored project tasks without requiring the source conversation to be open. Existing centralized databases are untouched and are not imported.

Overrides target entry `memory-l0` in the profile patch. `storageMode: central` explicitly selects the earlier single-database behavior, with `dataRoot` as the absolute data directory and `databasePath` relative to it. In workspace mode, `dataRoot` holds activation state and unassigned-conversation data; `databasePath` does not select a project's database. `autoLearning` controls background calls, `injection` controls recall, and `browser` controls page and body budgets. The portable entry resolves omitted settings. Workspace mode uses `workspace.id` for projects and `projectId` for unassigned conversations; `projectByPath` applies only to central mode.

Workspace mode disables `/memory-share` and all cross-project recall. A missing or unwritable Workspace directory, a redirected memory path, or a failed database open reports an error and retains the canonical Session log for retry; project data is never redirected to the global store. Directory checks reject existing links but cannot prevent another process replacing a directory concurrently.


The panel is enabled when Web services exist; `panel: false` disables its RPC. The bundle uses BM25 with `trigram`: Chinese text expands into three-character OR terms and one- or two-character terms use literal substring matching. Portable `textSearch.expandQuery` defaults on: when text has no hits and eligible records exist, one logged call to the existing L1 model supplies paraphrases before one additional search. Model output supplies search terms, never memory facts; errors remain visible. Set `expandQuery: false` for text-only recall, and use `expansionTimeoutMs` to change the 15000 ms deadline. Explicit `textSearch` objects retain direct-mount defaults, including expansion off. See the [upgrade instructions](./trigram-upgrade.md). Panel search remains literal browsing of one level. `embedding` selects vector retrieval and requires `endpoint`, `model`, `dimensions` and `apiKeyEnv`; supplying both retrieval modes rejects.

<a id="known-limitations"></a>
## Known limitations

This is an independent plugin archive for the declared DSH version; installing it requires no DSH source changes. Its acceptance evidence and recorded Session expectations remain with the plugin source. Verification covers Windows installation, upgrade, restart, learning and manual/automatic recall with a keyless synthetic model fixture. Real-model learning has a separate single-sample check; neither demonstrates general memory quality. Other operating systems and untested DSH or SDK versions remain unverified. Only Sessions loaded while the plugin is active are captured. No L4, synchronization, retention or bulk history import is provided.
