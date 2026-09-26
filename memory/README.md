---
description: "Configure L0 event copies and durable L1 task discovery, and inspect extraction and recovery limits."
kind: "package-reference"
---

# L0 and L1 memory

English | [中文](README.zh.md)

## Summary

Keep complete recorded Session events in project-owned SQLite and optionally discover L1 extraction tasks from completed turn intervals. Read exact memory versions and inspect pending or failed operations. L1 storage, extraction and retry components have local tests; automatic model extraction remains unavailable until its Session request logging is integrated. Execution evidence and outstanding acceptance checks are recorded in [Tasks](Tasks.md).

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this plugin

The [source patch](profiles/headless.patch.yml) mounts this plugin in the supported headless profile and makes the runner depend on the ready `memory` service. The [built patch](profiles/headless-built.patch.yml) selects the local build instead. These patches do not install dependencies. Use a matching, prepared DSH checkout; do not run a root installation or build under this directory's write restriction. Run `node scripts/link-profile.mjs` from `memory/` to register this package's directory with the profile resolver. The link and its target both remain inside `memory/`; existing unrelated entries are never replaced.

Dot-source the [PowerShell environment setup](scripts/environment.ps1) with an explicit stable project identifier. It checks output directories for links, sets the Harness home, caches, temporary paths and working directory beneath `memory/`, and disables telemetry. It launches no application. Its environment changes persist in that PowerShell session.

```powershell
. .\memory\scripts\environment.ps1 -ProjectId 'my-project'
```

The following source-profile invocation uses the repository's existing `dsh` bin and ESM hook from the `memory/` working directory. It requires the existing dependencies and their runtime artifacts, with output paths checked before launch. Missing model credentials produce a failed task whose recorded events are still copied; they do not demonstrate a successful model request.

```powershell
node --import tsx/esm ../apps/cli/src/bin.ts --profile headless --patch ./profiles/headless.patch.yml 'Reply with OK without using tools.'
```

Configuration is resolved before opening SQLite. Relative database paths resolve against `memory/`, not the invoking directory. Existing links in database paths or sidecar paths are rejected. The directory must be controlled by the current user; path checks do not prevent another process from replacing a directory between validation and open.

| Field | Default | Meaning |
|---|---|---|
| `projectId` | Required | Stable project identifier; the patch reads `DSH_MEMORY_PROJECT`. |
| `databasePath` | Required | SQLite file inside `memory/`; the example uses `data/l0.sqlite`. |
| `queueCapacity` | 1024 | Global maximum buffered live event count. |
| `batchSize` | 128 | Maximum events per capture transaction. |
| `pageSize` | 128 | Maximum source events per recovery read, also limited by batch size. |
| `busyTimeoutMs` | 5000 | SQLite lock wait; zero disables waiting. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`; synchronous mode is FULL. |
| `l1` | Absent | Optional extraction configuration; currently enables durable task discovery only. |

The optional `l1` object requires explicit `provider` and `model` values. Its remaining fields are resolved once and saved on each task:

| Field | Default | Meaning |
|---|---|---|
| `maxInputBytes` | 65536 | UTF-8 budget for system text and JSON-framed input per request. |
| `maxOutputTokens` | 2048 | Provider output-token cap. |
| `timeoutMs` | 60000 | Deadline for recording and streaming one auxiliary call. |
| `maxCalls` | 32 | Durable call budget shared across one operation's retries. |
| `maxAttempts` | 3 | Total attempts before automatic retry stops. |
| `retryBaseMs` | 1000 | Initial exponential retry delay. |
| `retryMaxMs` | 30000 | Maximum retry delay; must be at least `retryBaseMs`. |

With `l1` configured, the plugin reports `memory/integration` and leaves tasks pending without dispatching a model request. The [scan fixture](tests/fixtures/l1-scan.patch.yml) exercises this limited composition through the supported profile. It does not enable automatic summarization. Inspect operations through `ctx.memory.listTasks(project, after, limit)` and `getTask(project, operation)`, and read exact versions through `getMemory(project, ref)`. `rerunTask(project, operation, mode)` accepts `retry` for failed/deferred work or `reextract` for a new operation using the current configuration. Requeueing does not bypass the missing Session logging integration.

`ctx.memory.appendRaw` accepts project identity, source header, inherited prefix length, and an ordered contiguous event batch. It permits overlap with the stored prefix. Identical JSON values are duplicates; another project, different source metadata, or conflicting event content rejects the entire transaction. An empty batch binds source metadata and returns the current prefix. Successful writes return only after commit; cancellation observed after commit does not undo it.

`ctx.memory.readRaw` accepts a project, Session ID, half-open interval, page limit and optional next-position cursor. The result reports event values, the next page cursor, the committed prefix, and missing ranges across the entire requested interval. A null cursor means there are no more stored pages, not that the requested interval is complete. Missing Sessions and Sessions belonging to another project are both invisible. Corrupt data rejects instead of becoming an empty successful page.

## Understand the implementation

<details>
<summary>Storage, recovery, and lifecycle</summary>

The [SQLite provider](src/sqlite.ts) owns a separate database identity and schema version 2. It upgrades schema 1 transactionally without rewriting L0 events. Events use a `(session_id, seq)` primary key. Session metadata and the next uncommitted position advance in the same transaction as event rows. Unknown newer versions and other database identities are refused.

The [L1 store](src/l1-store.ts) scans committed L0 pages and commits task creation with its scan cursor and open-turn state. It skips fully inherited turns and retains turns ending beyond a fork's inherited prefix. Task keys include project, Session interval, layer and saved extraction settings. Configuration changes affect newly discovered turns; explicit re-extraction creates a new operation for an existing logical memory. Candidate checkpoints precede atomic memory-version and task-completion commits. Operation lookup resolves uncertain commits, and expected revisions reject concurrent replacement. Historical versions remain readable as superseded records.

The [extractor](src/l1-extractor.ts) requires an awaited recorder of the exact auxiliary request in the source Session before calling the existing LLM service. Its current production recorder is unavailable; unit tests use a recorder fixture and the real LLM service with an in-process adapter. Every nonempty result cites supplied events and retains the program-owned turn end reason. Oversized events are split at Unicode code-point boundaries, summarized and merged within the request and call budgets. Nonshrinking merges fail explicitly. Invalid JSON, foreign sources, incomplete output and successful solutions attributed to non-completed turns are rejected.

The [worker](src/l1-worker.ts) provides serialized `flush`, timed `watch`, awaited `retire`, and cancellation-aware `close` for a future recorder-owning composition. It reads complete L0 pages, saves validated candidates, and retries transient failures without repeating a model call when a candidate is already durable. A dispatch is charged before provider I/O; a crash after charging can consume budget even when no response is saved. Explicit retry retains the operation and its call count; re-extraction starts a new budget and checks the current memory revision. Each claim has a durable lease lasting `timeoutMs * maxCalls + retryMaxMs`; a restarted worker waits for that lease to expire before reclaiming work abandoned by a crashed process. An orderly cancellation releases its lease immediately. The database must outlive all workers.

The [collector](src/collector.ts) installs through the [plugin entry](src/index.ts). A single write chain orders capture, explicit checkpoints and teardown. Live capture detaches complete events before deferred writes. Recovery reads bounded pages through Session persistence; it never uses deprecated synchronous history readers. A queue overflow retains the required target position and reports backpressure. A failed write pauses automatic processing for that Session until explicit flush or reload retries it. No periodic retry timer is installed.

The RAM queue is not durable. SQLite holds the committed position, while the canonical Session log supplies missing events after restart. `session/flush` waits for the captured target, including recovery when needed. Its handler calls the persistence service's own flush rather than recursively dispatching the Session checkpoint. Unload removes listeners, waits for accepted work, attempts final recovery and closes SQLite even when recovery fails. Diagnostics omit event bodies and report failure categories and Session identities.

`node scripts/check-local.mjs` checks TypeScript syntax and configuration without external dependencies or file writes; it does not type-check. The local TypeScript configuration keeps the plugin and tests strict while referencing the vendor projects' own compiler configurations and existing declarations. The test entry imports configuration directly and disables Vite's configuration-file loader to avoid an ancestor-directory configuration bundle. Its cache and coverage paths remain inside this directory. Use the following commands after environment setup; the build emits `lib/index.mjs` and does not build peers.

```powershell
node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/test.mjs
node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native
node scripts/link-profile.mjs
node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml 'Reply with OK without using tools.'
```

`DSH_MEMORY_VERIFY_COPY=1` enables the opt-in `profile-copy` test, which compares SQLite with the canonical log through the real JSONL decoder. `DSH_MEMORY_VERIFY_DB` selects a memory-relative database and defaults to `data/l0.sqlite`. Run this verification immediately after the corresponding profile run; later activity collected into another database can extend the source log.

</details>

## Further Exploration

- [Task 1 and validation record](Tasks.md#task-1实现-l0-原始记忆)
- [Layered memory design](PROJECT.md)
- [Session persistence service](../packages/session/session-persistence/README.md)
- [DSH profile composition](../packages/boot/app-boot/README.md)

## Model Experience

The mounted plugin introduces no model tool or injected memory, and currently dispatches no extraction calls. The separately tested extractor's [prompt](src/l1-extractor.ts) treats event text as untrusted evidence, distinguishes execution from recalled references, and requests a sourced JSON summary. It preserves uncertainty; normal turn completion alone does not prove success. A failed L0 checkpoint can fail the caller's durability checkpoint; L1 scan failures retain their cursor and report diagnostics without undoing committed L0.

## Known Limitations and Deferred Work

- Only Sessions loaded while the plugin is active are adopted; no complete disk-history scan is performed.
- A lost canonical log prevents recovery of uncopied events. Existing copied events remain readable.
- Queue capacity counts events, not bytes. A single large event and a recovery page can require substantial memory; use smaller batch and page sizes where necessary.
- Source-wide flush may report another Session writer's failure. Recovery treats that failed checkpoint as an error.
- SQLite calls are synchronous and can block up to the configured lock timeout. Larger workloads may need an independently designed worker-backed provider.
- Database growth is unbounded; there is no retention policy, attachment backup, L2/L3, retrieval or index. The extractor loads one complete turn into memory before partitioning requests; the byte budget limits requests, not peak process memory.
- Automatic L1 extraction is blocked on a registered auxiliary Session event and the required persistence declarations and recorded-session evidence outside `memory/`. No request is journaled only in SQLite or disguised as an ordinary user turn. Real-provider validation also requires credentials.
- Source-provider replacement requires another profile lifecycle test. Directory-local tests do not replace required recorded-session snapshots.
