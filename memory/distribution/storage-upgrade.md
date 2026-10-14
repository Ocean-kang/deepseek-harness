---
kind: upgrade-guide
description: "Upgrade schema-5 memory databases and synchronous consumers to asynchronous storage with historical imports and opt-in retention."
---

# Asynchronous memory storage upgrade

English | [中文](storage-upgrade.zh.md)

## Change

The plugin upgrades SQLite schema 5 to 6 with historical-import progress, explicit admission, cleanup tombstones, compact summary/candidate projections and trace chunks. Migration backfills projections and chunks while preserving original L0/L1 records and Session logs; task inputs remove duplicated L1 trace. Legacy backfill or the first commit of a prepared legacy task can temporarily materialize one record in native SQLite memory; operational reads use bounded projections and pages. Knowledge inputs exclude complete trace and verify exact L0 evidence. Completed extraction tasks are not rerun.

Memory database, task, selection and retrieval methods use asynchronous storage. Custom Cordis consumers must await their results. A storage-worker failure can leave a mutation's outcome unknown: consumers must report this state and inspect durable progress after reopening the provider, rather than blindly repeat the write. Trace consumers read pages of JSON text and concatenate them before decoding a complete trace; a summary read does not load the complete trace.

Explicit historical import admits selected older Sessions only in their verified current Workspace and preserves fork-inherited cuts. Imports follow `autoLearning`: enabled learning schedules configured model calls, while disabled learning only copies L0. Automatic retention is disabled until `retention.maxAgeDays` is configured. Cleanup removes expired whole Sessions only when no retained record, pending selection, unfinished task, sharing grant or active Session requires their sources. Retained evidence can exceed the configured age indefinitely.

## Migration

1. Stop DSH and back up each [memory directory](README.md#data-and-configuration), including SQLite sidecars. Install through the supported profile, restart, and reload browser tabs. Schema-5 readers cannot open schema-6 databases; rollback uses the backup.
2. Update custom consumers to await memory reads, task operations and selection writes. Replace full-trace access through L1 summaries with `readTrace` pagination. Keep each exact memory revision and trace cursor together while reading.
3. Retry a previously failed large-trace knowledge task explicitly when required. Complete trace remains stored, while knowledge inputs exclude it and verify conclusions through exact L0 evidence.
4. In a conversation belonging to the current Workspace, preview historical Sessions, select sources and start import. Check persisted per-source progress after completion or restart. Cancel stops further copying but keeps committed data and already queued learning. Fix missing or unsupported source data before starting another import.
5. Leave retention disabled to preserve all captured data. To enable automatic cleanup, configure `retention.maxAgeDays`; `retention.intervalMs` defaults to 86400000. Preview cleanup before manual execution and inspect deleted and protected counts afterwards. Cleanup makes database pages reusable; explicit compaction reduces physical file size and can wait on database locks.
6. Confirm project isolation, retained evidence and pending selections after restart. JSONL cold reads and single oversized events can still exceed the plugin's page budget; the source backend remains unchanged.
