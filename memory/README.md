---
description: "Capture project events, learn L1–L3 memories, and browse or recall them in DSH conversations."
kind: "package-bundle"
---

# Layered memory

English | [中文](README.zh.md)

## Summary

Keep complete recorded Session events in project-owned SQLite, browse L0–L3 and select L2/L3 for the next turn. Background learning reuses DSH models and credentials; BM25 retrieval needs no embedding key. The portable bundle enables logged recall through public extension points. See [installation](distribution/README.md) and [verification scope](evaluation/compatibility-0.2.1-alpha.1-2026-10-06.md).

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-plugin"></a>
## Use this plugin

This checkout targets DSH 0.2.1-alpha.1. After building `memory/lib`, run the following from the repository root to enable capture, L1–L3 learning, recall and the right-sidebar Memory tab. The bundle uses the active DSH home and its configured model credentials; `profiles/web.patch.yml` enables L0 capture only. If the bundle is already installed in the Web profile, omit `--patch ./memory/cordis.patch.yml` to avoid mounting it twice. For archive installation and upgrading from memory 0.1.8, see the [portable instructions](distribution/README.md).

```powershell
pnpm dsh web --patch ./memory/cordis.patch.yml --patch ./memory/profiles/chat-view.patch.yml
```

The [source patch](profiles/headless.patch.yml) mounts this plugin in the supported headless profile and makes the runner depend on the ready `memory` service. The [built patch](profiles/headless-built.patch.yml) selects the local build instead. These patches do not install dependencies. Use a matching, prepared DSH checkout; do not run a root installation or build under this directory's write restriction. Run `node scripts/link-profile.mjs` from `memory/` to register this package's directory with the profile resolver. The link and its target both remain inside `memory/`; existing unrelated entries are never replaced.

Dot-source the [PowerShell environment setup](scripts/environment.ps1) with an explicit stable project identifier. It checks output directories for links, sets the Harness home, caches, temporary paths and working directory beneath `memory/`, and disables telemetry. It launches no application. Its environment changes persist in that PowerShell session.

```powershell
. .\memory\scripts\environment.ps1 -ProjectId 'my-project'
```

The following source-profile invocation uses the repository's existing `dsh` bin and ESM hook from the `memory/` working directory. It requires the existing dependencies and their runtime artifacts, with output paths checked before launch. Missing model credentials produce a failed task whose recorded events are still copied; they do not demonstrate a successful model request.

```powershell
node --import tsx/esm ../apps/cli/src/bin.ts --profile headless --patch ./profiles/headless.patch.yml 'Reply with OK without using tools.'
```

The portable bundle and full Web overlay default to Workspace storage: `<workspace>/memory_<workspaceUUID>/memory.sqlite` contains the project's L0–L3 data. Only conversations created after the persisted activation time participate; old conversations and old centralized databases are not imported. Unassigned conversations use the new global database. See [data and configuration](distribution/README.md#data-and-configuration) for paths, backups and the explicit central-mode override. Configuration and existing-link checks run before database writes.

| Field | Default | Meaning |
|---|---|---|
| `storageMode` | `central` for direct mounts; `workspace` for portable | Physical storage mode. |
| `dataRoot` | Plugin directory | Absolute allowed data directory; the portable entry uses the DSH user-data directory. |
| `projectByPath` | false | Central mode only: derive fallback ownership from the Session working directory. |
| `injection` | false | Install logged manual and optional automatic recall; requires a retriever. |
| `projectId` | Required | Fallback project identifier; the patch reads `DSH_MEMORY_PROJECT`. |
| `databasePath` | Required | SQLite file inside `memory/`; the example uses `data/l0.sqlite`. |
| `queueCapacity` | 1024 | Global maximum buffered live event count. |
| `batchSize` | 128 | Maximum events per capture transaction. |
| `pageSize` | 128 | Maximum source events per recovery read, also limited by batch size. |
| `learningConcurrency` | 2 | Maximum simultaneous project drains across all Workspace databases. |
| `learningQueueCapacity` | 128 | Maximum admitted drains waiting for project ordering or concurrency capacity. |
| `autoLearning` | false | Enable background learning; requires L1/knowledge settings and `llm` in the plugin entry's inject list. |
| `textSearch` | Absent | Explicit BM25 text search, mutually exclusive with `embedding`. |
| `panel` | false | Mount the Web panel RPC; the plugin entry requires `connection` and `webServer`. |
| `browser` | `{}` | Page size 50, query budget 8192 bytes, combined recall limits of 5 records and 8192 rendered bytes; shared refresh interval 3000 ms and at most 32 cached Sessions (`stateCacheSessions`). |
| `busyTimeoutMs` | 5000 | SQLite lock wait; zero disables waiting. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`; synchronous mode is FULL. |
| `l1` | Absent | Optional extraction configuration; enables task discovery and supplies L1 settings for `autoLearning`. |
| `knowledge` | Absent | Optional L2/L3 model and scoring settings; `autoLearning` controls model dispatch. |

Workspace capture resolves `SessionHeader.cwd` through the optional Workspace registry and uses its canonical root and UUID. A missing registry, cwd or matching Workspace selects the unassigned project. Recovery scans registered project databases after the registry becomes active, including when memory starts first. A directory lookup failure rejects capture and remains retryable. Loaded database ownership is retained. Central mode keeps its stored project ownership and optional path-derived fallback behavior.

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

With `l1` configured and `autoLearning` disabled, the plugin reports `memory/integration` and leaves tasks pending. The [scan fixture](tests/fixtures/l1-scan.patch.yml) exercises this capture-only composition. Enable background learning with [automatic.patch.yml](profiles/automatic.patch.yml), which resolves both extraction models from `agentDefaultModel` and uses the existing LLM adapter's credentials. L0 commits coalesce project wakeups; capture flush does not wait for model calls. After capture, `ctx.memory.flushLearning(project, signal)` awaits currently due work; failures remain inspectable in task states. Inspect operations through `ctx.memory.listTasks(project, after, limit)` and `getTask(project, operation)`, and read exact versions through `getMemory(project, ref)`. `rerunTask(project, operation, mode)` accepts `retry` for failed/deferred work or `reextract` for a new operation using the current configuration. Unload cancels model work before releasing SQLite; the final captured sources remain recoverable on restart.

`ctx.memory.appendRaw` accepts project identity, source header, inherited prefix length, and an ordered contiguous event batch. It permits overlap with the stored prefix. Identical JSON values are duplicates; another project, different source metadata, or conflicting event content rejects the entire transaction. An empty batch binds source metadata and returns the current prefix. Successful writes return only after commit; cancellation observed after commit does not undo it.

`ctx.memory.readRaw` accepts a project, Session ID, half-open interval, page limit and optional next-position cursor. The result reports event values, the next page cursor, the committed prefix, and missing ranges across the entire requested interval. A null cursor means there are no more stored pages, not that the requested interval is complete. Missing Sessions and Sessions belonging to another project are both invisible. Corrupt data rejects instead of becoming an empty successful page.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Long-term knowledge

Recall and shared reads check the complete exact-version source chain. Replaced, invalidated, unsupported or missing sources pause derived recall; the panel labels the record “Needs rechecking” while retaining its JSON and history. Reconciliation queues an idempotent recheck from eligible current parents even when the original task is complete. Background learning rechecks the conclusion against those parents; publication retains only current ancestry. Without eligible parents, recall stays paused until new evidence is available. Rechecking does not imply successful extraction or approval of a new shared version.

When `knowledge` is configured, the plugin queues one L2 task per current L1 version and one L3 task per supported current L2 version. It reconciles existing versions at startup and newly committed versions in the same process. Equivalent tasks are idempotent; commits from another process are discovered on restart. With `autoLearning`, the recoverable pipeline executes these tasks in the background.

Resolve explicit provider/model settings with `resolveKnowledgeConfig`, then call `ctx.memory.consolidate(project, level, sourceRefs, spec)` to persist an L2 or L3 task. This queues work without dispatching a model. Inspect it through `getKnowledgeTask` / `listKnowledgeTasks`; `retryKnowledgeTask` requeues failed work. Use `listCandidates(project, level, after, limit)` for supported current records and `invalidateMemory(project, ref, reason, operation)` to invalidate current owned L2/L3. Exact `getMemory` reads preserve owned history; a shared result is a distinct projection with `shared: true`, title and body, without sources or generation metadata.

| Field | Default | Meaning |
|---|---|---|
| `scoreMin` / `scoreMax` | 0 / 5 | Inclusive integer range; maximum 100. |
| `l2Threshold` / `l3Threshold` | 3 / 4 | Ordered thresholds inside the score range. |
| `promptVersion` | `knowledge-v3` | Persisted implementation version; v3 reads original L0 evidence and generates a separate display description. Historical v1/v2 tasks retain their prompts. |

Knowledge uses the L1 model-budget defaults above. At the default scale, temporary information scores 0–1, local experience 2, reusable methods 3, stable constraints 4, and explicit decisions 5. Importance never establishes truth: evidence is separately supported, unverified, or conflict. Low scores do not delete sources; conflicts remain stored even below the threshold. L3 accepts only supported stable categories. New L2/L3 tasks read the exact L0 events cited by their L1 ancestry. When the event set exceeds one request, bounded groups supply original evidence and a later model step merges their checked candidates without rereading all original events in one request. Optional `Knowledge.examinedEvents` records program-assigned event references supplied during these checks; it does not establish factual truth. `supported` remains a model judgment with structural and reference validation; historical tasks can rely only on summaries. Repeated summaries of the same events are not independent evidence.

The [knowledge store](src/knowledge-store.ts) persists source versions, settings, prepared candidates, attempt/call counts and backoff. Same-project leases serialize aggregation; each unprepared attempt refreshes existing knowledge and ancestry. New v3 requests contain direct memory content, original evidence and the number of omitted ancestor records; the full exact-version chain remains available for server validation. Sources and evidence are grouped by complete UTF-8 input size; each complete group selects existing knowledge by shared ancestry and literal term overlap until its input budget is full. Omitted records remain stored but cannot be merge targets; lexical selection can miss equivalent facts. Recheck targets are mandatory inputs. Groups and descriptions validate before one atomic publication; checked candidates use bounded model merges when needed. A required source, single original event, or checked candidate that cannot fit fails with `budget` without truncation; merges that do not shrink also fail. Version conflicts discard stale candidates; storage retries retain prepared candidates. Cancellation releases the lease and refunds the attempt while retaining charged calls. Explicit retry keeps the operation, prompt version and lifetime call count; old v1/v2 tasks with oversized ancestor chains require a new operation using current settings. Close workers before their provider.

The [knowledge extractor](src/knowledge-extractor.ts) uses the real LLM service and requires an awaited Session-backed request recorder. With `autoLearning`, the capture plugin installs the auxiliary Session recorder and worker. Independent development can also use the pipeline below; controlled adapters do not establish real-provider quality.

When the interactive command registry is composed, `/memory-share show <id>@<revision>` displays a current supported L3 version, the revocation limit, and a five-minute token. The user then runs `/memory-share approve <token>` in the same Session; `/memory-share revoke <id>@<revision>` stops future sharing. The handler awaits Session durability before committing an exact-version grant or revocation, and uses its logged human command as the one-time receipt. These commands are unavailable without the interactive registry. The mounted memory service exposes no approval method or model tool. Replacement, invalidation and revocation remove a grant atomically; cross-project reads expose only the approved projection. Revocation cannot erase content already recorded in another Session or derived from prior reads.

### Independent development

This directory delivers an independently installable plugin for the declared DSH peer version. Its build, archive, upgrade instructions, recorded Session expectations and acceptance evidence belong under `memory/`; the [development rules](AGENTS.md) define the complete local workflow. Acceptance covers installation, supported-profile execution, model-visible logs, persistence and restart, and real Web interaction. A future DSH source-integration PR has separate repository registration, top-level snapshot, upgrade-guide, SDK and repository-wide check requirements; those artifacts do not replace or block this plugin's own verification.

The Web and panel development patches select `ui-chat.transcriptView: detailed`. The [Chat presentation patch](profiles/chat-view.patch.yml) selects the same mode for a Memorix-only launch. A later overlay may choose another supported mode.

The [Web panel patch](profiles/panel.patch.yml) mounts the built portable entry and Client through DSH's existing authenticated connection and right sidebar. It enables capture, background learning and logged recall, stores registered project databases in their Workspace directories, and declares `webServer` on the Connection provider. After environment setup and the build below, launch `node --import tsx/esm ../apps/cli/src/bin.ts web --patch ../apps/web/tests/pin-browse-picker.overlay.yml --patch ./profiles/panel.patch.yml --no-open --port 0`, then open the Memory tab for a conversation. Browsing is scoped to its captured project and supports L0–L3, literal search, exact-version detail and owned version history; Workspace mode disables shared L3; central mode omits private sources from approved projections. A capture failure blocks reads and selections rather than changing recorded metadata.

The sidebar uses a DeepSeek-blue masthead, underlined level navigation and numbered entries separated by fine rules. Text and controls adapt to light and dark themes and narrow panes. Version details display the viewed revision and validity state. Load older versions when the history spans multiple pages; changing the viewed revision retains the loaded history pages. Search pagination uses the submitted query; editing the search field does not change it until submission starts a new result page. Saved selections survive a page refresh, while cancelling pending selections leaves the knowledge records available.

Previously captured conversations remain browsable after restart even when their Session is not loaded. The panel incrementally reads committed SQLite L0 events to display admitted memory text and reconcile pending selections; unchanged polls read no event bodies. Canonical events appear after capture commits. Saving selections does not start an Agent or append recovery markers.

Cards show conversation and execution records at L0. New L1–L3 cards show a one-sentence description produced by a separate model step after extraction; old versions fall back to readable content. Detail retains full topics, actions, results, knowledge, sources, scores, evidence and folded original JSON. The second step adds one charged call per final memory and prevents partial publication if it fails. L0 recall cards show recorded text; auxiliary cards show requests and returned descriptions. Search filters the selected level and highlights literal matches. The panel displays project-wide task progress and failures. Short windows allow the whole panel to scroll while the memory list retains a minimum height. The sidebar and composer share one state poll per Session; refreshes retain the submitted query, loaded pages, detail and scroll. Set `browser.refreshIntervalMs` for the interval.

L2/L3 selections persist for one admitted recall, with server-side version, sharing, count and rendered-text checks. Cancellation clears only pending references. With `injection: true`, the plugin combines manual selections and optional BM25 matches, logs exact admitted text and references through `user/message`, and consumes selections after commit. The portable bundle and panel patch enable injection; [web.patch.yml](profiles/web.patch.yml) remains capture-only.

Select the checkbox at the start of each eligible L2/L3 card, then choose Add selected to next turn, or add one card directly. L0/L1 remain read-only. The pending area and composer show saved text, count and the rendered-byte budget, including while the sidebar is closed. Manual selection is consumed once after admission; automatic recall remains enabled until switched off. Its switch preserves pending references and their consumption receipt even when a version is stale. New selections still require eligibility and budget checks. After sending, the composer and panel show exact committed context and references; admission does not guarantee that the answer cites every memory.

The sidebar reads this plugin's L0–L3 database. The optional [Memorix overlay](profiles/memorix.cordis.yml) exposes `mcp__memorix__...` tools; add `--patch ./profiles/memorix.cordis.yml` to the panel launch to use both. Install Memorix separately. Its data lives in `data/memorix`, and its Windows subprocess user directory is `home/memorix`, so its project marker and update cache also stay in this development directory. These paths do not import the user's existing Memorix store.

[MemoryPipeline](src/pipeline.ts) composes existing LLM, Session and SQLite libraries without registering a DSH agent plugin. The caller supplies a configured LLM service, resolved L1/knowledge settings, an open memory database, and complete source event batches. `learn(batch)` commits L0 and processes presently due L1 → L2 → L3 tasks. `flush(project, signal?)` also recovers stored sources after reopening; no live source Session is needed. `watch(project)` performs startup recovery and schedules future retries and subsequent memory commits; use `learn` or `flush` for new L0 input. `retire(project)` stops background scheduling and awaits that project's queued drains. Without watch, another flush after the stored backoff executes a retry. Inspect L1 and knowledge task states: a returned L0 result does not mean every model task succeeded.

```ts
import { MemoryPipeline, SqliteMemory, resolveConfig } from './src/index.ts'

const spec = await resolveConfig({
  projectId: 'my-project', databasePath: 'data/development.sqlite',
  l1: { provider: 'configured-provider', model: 'configured-model' },
  knowledge: { provider: 'configured-provider', model: 'configured-model' },
})
const memory = await SqliteMemory.open(spec)
const pipeline = new MemoryPipeline(memory, spec, llm, report)
try {
  await pipeline.learn(sourceBatch)
} finally {
  await pipeline.close()
  await memory.close()
}
```

`llm`, the nonthrowing `report` callback and project-owned `sourceBatch` are supplied by the caller; this fragment is library usage, not an application launcher. An optional caller-owned `MemoryRetriever` on the same database enables `pipeline.retrieve`. Close the pipeline, then the retriever and database. Abort an individual learning batch through its `signal`, or close the pipeline to cancel all learning; committed sources and unfinished tasks remain recoverable.

[MemoryRequestJournal](src/request-journal.ts) commits exact provider/model, prompt, input and output budget before dispatch, then saves the compact returned stream before candidate preparation. Each attempt has a separate auxiliary Session in L0 with `memory/extraction-request` and `memory/extraction-result` events. Their envelopes carry `ignorable: true`: other Harness readers retain them without deriving ordinary agent history. No turn is invented and the original source Session is unchanged. A missing settlement means the outcome is unknown, not success. These events use the existing L0 tables. `listSessions(project, after, limit)` exposes owner-filtered metadata for paging and audit; `readRaw` retrieves the actual events.

The independent path covers learned-memory/query/restart behavior, scheduled retries, concurrent projects, request and result failures, cancellation and owner isolation. The installable bundle adds capture-to-model dispatch and logged recall; general real-model effectiveness remains unverified.

Project drains execute serially within each project and share the configured concurrency limit. A full learning queue rejects with `backpressure` after L0 capture; call `flush` later to recover the retained source. Watched projects resume when capacity becomes available. Cancelling a drain waiting for project ordering or concurrency capacity removes it before any model call or task lease, frees its queue capacity and preserves ordering for later drains.

For an opt-in real-provider learning smoke, build this package, link the local profile, then run `node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/learning-live.patch.yml 'Validate automatic memory learning and text retrieval.'` from `memory/`. This test-only overlay replaces the headless runner with the [learning fixture](tests/fixtures/learning-live.mjs), mounts automatic learning and text search, and uses the already selected model and credentials. Its YAML explicitly bounds attempts, calls, output and timeout. Each run processes a synthetic standing constraint in a unique `data/automatic-live-<uuid>.sqlite` database, prints its database path and source Session, and requests launcher exit. It installs no production injection and performs no embedding calls. `passed: true` requires L1, L2 and L3 results for that run and a text-search hit; failed runs remain recorded and do not establish general quality or retrieval effectiveness.

Set `DSH_MEMORY_VERIFY_LEARNING=1`, `DSH_MEMORY_VERIFY_LEARNING_SOURCE` to the exact `sourceSession` printed by that run, and `DSH_MEMORY_VERIFY_LEARNING_DB` to its memory-relative database path, then execute `node scripts/test.mjs learning-live`. This reopens the database without further model calls and checks conservative L1 content, the explicit constraint, exact ancestry and request/result settlements. Missing run identity or database path fails visibly.

### Text retrieval

Set `textSearch: {}` to use SQLite FTS5/BM25 without an embedding model, key or network request. Results identify `method: 'bm25'`; ranked hits carry a positive BM25 `score`, short substring matches omit it, and `similarity` is null. Vector results identify `method: 'vector'`. Configure one mode explicitly; neither replaces a failing query in the other mode. Private memories are removed before constructing the scoring corpus, and current revisions and grants are checked before return and admission. Each query builds and closes a capped in-memory corpus from SQLite records; it adds no durable text tables. Corpus changes in the requested project require a fresh query; unrelated private commits do not affect ranking.

Direct text-search defaults are `tokenizer: unicode61`, `limit: 5`, `maxBytes: 8192`, `maxCandidates: 10000`, `pageSize: 128`, `timeoutMs: 5000`, `maxQueryBytes: 8192` and `maxTerms: 64`. Portable and automatic/panel overlays select `trigram`. Queries use literal OR terms; Han-containing runs expand into consecutive three-character terms. One- and two-character terms use literal substring matching within the authorized corpus; these hits have no BM25 score. Over-budget queries reject without truncation. Portable memory also enables `expandQuery`: with no text hits and at least one eligible record, one recorded call to the configured L1 model supplies search paraphrases before one additional text query. Direct mounts default this option off; enabling it requires the L1 model and injected `llm` service. `expansionTimeoutMs` defaults to 15000; each corpus scan retains `timeoutMs`. Invalid or failed expansion rejects visibly. Model output supplies search terms only; returned memories remain stored, authorized versions. Relevance and semantic completeness are not guaranteed. Native SQLite statements cannot be interrupted. `getIndexStatus` reports candidate capacity; there is no retained text index to rebuild.

<a id="semantic-retrieval"></a>
### Semantic retrieval

Configure `embedding` to index current memories and enable `ctx.memory.retrieve`, `getIndexStatus` and `rebuildIndex`. Without it, search methods reject with `config`. Explicitly configure the complete embeddings `endpoint`, exact response `model`, positive `dimensions`, and `apiKeyEnv`. The named environment variable must contain a nonempty key at activation. Text is sent to that endpoint; keys are not saved in SQLite. This provider is independent of the conversational model.

| Field | Default | Meaning |
|---|---|---|
| `sendDimensions` | false | Send the optional dimensions field; response dimensions are always checked. |
| `batchSize` / `concurrency` | 16 / 1 | Index batch and parallel request limits. |
| `timeoutMs` / `maxAttempts` | 15000 / 3 | Per-attempt HTTP timeout and total transient-failure attempts. |
| `retryBaseMs` / `retryMaxMs` | 500 / 5000 | Exponential retry delay bounds. |
| `retrievalTimeoutMs` | 5000 | Query deadline including HTTP retries and scanning. |
| `limit` / `maxBytes` | 5 / 8192 | Result count and UTF-8 budget including wrapper and references. |
| `threshold` | 0.65 | Minimum cosine similarity; calibrate for the configured model. |
| `pageSize` / `maxCandidates` | 128 / 10000 | Candidate page size and query scan limit. |

`retrieve({ projectId, text, levels?, limit?, maxBytes?, signal? })` returns `hits`, exact rendered `text`, `scanned` and `elapsedMs`. Hits contain fixed revisions, project IDs, shared flags and similarity. Omitted levels select L1/L2/L3. Current supported knowledge and latest L1 versions are eligible; foreign private memories are excluded before scoring. Results sort by descending similarity and ascending Memory ID. Whole entries exceeding the remaining byte budget are skipped so smaller entries can fit. Empty text, no candidates and no matches return empty results; incomplete indexes reject explicitly.

Indexing starts on load and after local memory commits. Startup fills missing vectors without repeating completed batches. Endpoint, model, dimensions or text-format changes select a separate vector space. `getIndexStatus(project)` checks project completeness and reports capped scans. Queries reject missing vectors with `index-not-ready` and excessive candidates with `budget`. Index failures produce diagnostics and retained status; `rebuildIndex()` drains the worker and rebuilds its space, then callers inspect status. Other connections do not notify this process; reload or rebuild recovers their missing vectors. Old vectors remain stored. No keyword fallback is installed.

The plugin installs the [Injector](src/injector.ts) when `injection` is enabled. It delegates `agent/pre-step`, searches accepted user text once per turn, rechecks visibility and lets the loop record exact recall text as `user/message`. Committed logs govern recovery and remain unchanged after database edits. References are not instructions and do not wake turns. Revocation cannot remove content admitted after its final visibility check. The plugin owns its [persisted source fields](persistence-source.json).

<details>
<summary>Storage, recovery, and lifecycle</summary>

The [SQLite provider](src/sqlite.ts) owns a separate database identity and schema version 5. It upgrades schema 1, 2, 3 or 4 transactionally without rewriting L0 events or L1 versions. Events use a `(session_id, seq)` primary key. Session metadata and the next uncommitted position advance in the same transaction as event rows. Unknown newer versions and other database identities are refused.

The [L1 store](src/l1-store.ts) scans committed L0 pages and commits task creation with its scan cursor and open-turn state. Startup scans every stored project, including unloaded Sessions; successful capture and direct appends scan their actual project. It skips fully inherited turns and retains turns ending beyond a fork's inherited prefix. Task keys include project, Session interval, layer and saved extraction settings. Configuration changes affect newly discovered turns; explicit re-extraction creates a new operation for an existing logical memory. Candidate checkpoints precede atomic memory-version and task-completion commits. Operation lookup resolves uncertain commits, and expected revisions reject concurrent replacement. Historical versions remain readable as superseded records.

The [extractor](src/l1-extractor.ts) requires an awaited recorder of the exact auxiliary request in an auxiliary Session before calling the existing LLM service. Background learning uses MemoryRequestJournal; controlled tests use the same LLM service with an in-process adapter. Every nonempty result cites supplied events and retains the program-owned turn end reason. Oversized events are split at Unicode code-point boundaries, summarized and merged within the request and call budgets. Nonshrinking merges fail explicitly. Invalid JSON, foreign sources, incomplete output and successful solutions attributed to non-completed turns are rejected.

The [worker](src/l1-worker.ts) provides serialized `flush`, timed `watch`, awaited `retire`, and cancellation-aware `close` for a future recorder-owning composition. It reads complete L0 pages, saves validated candidates, and retries transient failures without repeating a model call when a candidate is already durable. A dispatch is charged before provider I/O; a crash after charging can consume budget even when no response is saved. Explicit retry retains the operation and its call count; re-extraction starts a new budget and checks the current memory revision. Each claim has a durable lease lasting `timeoutMs * maxCalls + retryMaxMs`; a restarted worker waits for that lease to expire before reclaiming work abandoned by a crashed process. An orderly cancellation releases its lease immediately. The database must outlive all workers.

The [collector](src/collector.ts) installs through the [plugin entry](src/index.ts). A single write chain orders capture, explicit checkpoints and teardown. Live capture detaches complete events before deferred writes. Recovery reads bounded pages through Session persistence; it never uses deprecated synchronous history readers. A queue overflow retains the required target position and reports backpressure. A failed write pauses automatic processing for that Session until explicit flush or reload retries it. No periodic retry timer is installed.

The RAM queue is not durable. SQLite holds the committed position, while the canonical Session log supplies missing events after restart. `session/flush` waits for the captured target, including recovery when needed. Its handler calls the persistence service's own flush rather than recursively dispatching the Session checkpoint. Unload removes listeners, waits for accepted work, attempts final recovery and closes SQLite even when recovery fails. Diagnostics omit event bodies and report failure categories and Session identities.

Separate Host and Client compiler configurations keep the plugin and tests strict while referencing the existing projects' compiler configurations and declarations. The test entry imports configuration directly and disables Vite's configuration-file loader to avoid an ancestor-directory configuration bundle. Its cache and coverage paths remain inside this directory. Use the following commands after environment setup; the build replaces `lib/` with the current `lib/index.mjs`, `lib/portable.mjs`, `lib/client.js` and their imported modules, without building peers. The [packager](scripts/pack.mjs) removes its temporary staging directory after success or failure.

```powershell
node ../node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit
node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node --import tsx/esm scripts/test.mjs
node ../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts --config-loader native
node scripts/link-profile.mjs
node ../apps/cli/lib/bin.js --profile headless --patch ./profiles/headless-built.patch.yml 'Reply with OK without using tools.'
```

Run `node --import tsx/esm scripts/check-docs.mjs` for directory-local links, bilingual structure and pairing records. After reviewing both languages, use the same command with `--write-pairing` to refresh the three local consistency records.

`DSH_MEMORY_VERIFY_COPY=1` enables the opt-in `profile-copy` test, which compares SQLite with the canonical log through the real JSONL decoder. `DSH_MEMORY_VERIFY_DB` selects a memory-relative database and defaults to `data/l0.sqlite`. Run this verification immediately after the corresponding profile run; later activity collected into another database can extend the source log.

For an isolated profile, `DSH_MEMORY_VERIFY_SOURCE_ROOT` selects its memory-relative Session directory instead of `home/sessions`. `DSH_MEMORY_VERIFY_COPY_SESSION` restricts comparison to one captured Session, so a learning database's SQLite-only auxiliary request Sessions are not mistaken for canonical profile logs. The `learning-live` check verifies those auxiliary request and result records separately.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Verification scope](evaluation/workspace-storage-2026-10-02.md)
- [Memory-card acceptance](evaluation/memory-cards-2026-10-03.md)
- [Batch learning and sidebar acceptance](evaluation/batch-sidebar-2026-10-04.md)
- [Knowledge growth and original-evidence acceptance](evaluation/knowledge-growth-2026-10-04.md)
- [Panel polling and recall acceptance](evaluation/panel-recall-2026-10-04.md)
- [0.1.8 delivery acceptance](evaluation/delivery-0.1.8-2026-10-04.md)
- [Browser interaction and real-provider acceptance](evaluation/browser-live-2026-10-04.md)
- [Standalone trigram upgrade](distribution/trigram-upgrade.md)
- [Manual quality experiment inputs](evaluation/task4-cases.json), not yet executed
- [Session persistence service](../packages/session/session-persistence/README.md)
- [DSH profile composition](../packages/boot/app-boot/README.md)

## Model Experience

The mounted plugin introduces no model tool. With `injection`, admitted memory text enters the ordinary conversation request and Session log; with `autoLearning`, auxiliary model calls use existing providers and credentials and log complete requests and response streams. Extractor prompts treat event text as untrusted evidence and retain uncertainty. L0 checkpoint failures may fail the caller checkpoint; L1 scan failures retain their cursor without rolling back committed L0.

## Known Limitations and Deferred Work

- Only Sessions loaded while the plugin is active are adopted; no complete disk-history scan is performed.
- A lost canonical log prevents recovery of uncopied events. Existing copied events remain readable.
- Queue capacity counts events, not bytes. A single large event and a recovery page can require substantial memory; use smaller batch and page sizes where necessary.
- Source-wide flush may report another Session writer's failure. Recovery treats that failed checkpoint as an error.
- SQLite calls are synchronous and can block up to the configured lock timeout. Larger workloads may need an independently designed worker-backed provider.
- Database growth is unbounded; there is no retention policy or attachment backup. The extractor loads one complete turn into memory before partitioning requests; the byte budget limits requests, not peak process memory.
- L0 copies preserve recorded event data and file references; attachment and spill files are not copied. Missing referenced files cannot be reconstructed from these copies.
- Direct mounting defaults `autoLearning` and `injection` off; the portable bundle enables both. Each conversation defaults automatic recall off. Real models use credentials already configured in DSH.
- Keyless fixtures and a single real-model learning sample do not establish general memory quality. The fixed manual quality experiment has not been executed; vector thresholds require calibration for the chosen embedding model.
- Source-provider replacement requires another profile lifecycle test. Directory-local recorded Session expectations cover this plugin's model-visible output; they do not establish compatibility with untested DSH or SDK versions.
- Local acceptance does not establish a cross-platform matrix or repository-wide doc-sync result. DSH source integration has separate registration and CI requirements.
