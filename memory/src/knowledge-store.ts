/** SQLite transactions for knowledge versions, aggregation jobs and exact-version grants. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { l1Key, resolveKnowledgeConfig } from './l1-config.ts'
import type { L1Store } from './l1-store.ts'
import { integer, json, object, textValue } from './l1-validation.ts'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import type { MemoryId, MemoryRef, OperationId } from './l1-types.ts'
import type { EvidenceConfirmation, KnowledgeFilter, KnowledgeInput, KnowledgeLevel, KnowledgeMemory, KnowledgeSpec, KnowledgeTask, OwnedMemory, ShareAction, SharedMemory } from './knowledge-types.ts'
import { knowledgeKey, knowledgeRef, parseKnowledge, parseKnowledgeCandidates } from './knowledge-validation.ts'

/** Version-3 migration; the parent opens and commits the migration transaction. */
export const KNOWLEDGE_SCHEMA = `
CREATE TABLE knowledge_versions (
 id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), project TEXT NOT NULL,
 level TEXT NOT NULL CHECK(level IN ('L2','L3')), operation_id TEXT NOT NULL,
 content_key TEXT NOT NULL, knowledge TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','superseded','invalidated')), PRIMARY KEY(id,revision)
) STRICT;
CREATE UNIQUE INDEX knowledge_current_id ON knowledge_versions(id) WHERE state = 'active';
CREATE UNIQUE INDEX knowledge_current_content ON knowledge_versions(project,level,content_key) WHERE state = 'active';
CREATE TABLE knowledge_tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL) STRICT;
CREATE TABLE knowledge_operations (id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL) STRICT;
CREATE TABLE knowledge_share_actions (id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL) STRICT;
CREATE TABLE knowledge_grants (id TEXT NOT NULL, revision INTEGER NOT NULL, action_id TEXT NOT NULL REFERENCES knowledge_share_actions(id),
 PRIMARY KEY(id,revision), FOREIGN KEY(id,revision) REFERENCES knowledge_versions(id,revision)) STRICT;
`

/** Version-7 selection indexes; historical rows are populated in resumable pages after migration. */
export const CONSOLIDATION_SCHEMA = `
CREATE TABLE knowledge_level_generations (project TEXT NOT NULL, level TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(project,level)) STRICT;
CREATE TABLE knowledge_selection_sources (project TEXT NOT NULL, level TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, PRIMARY KEY(id,revision,source_id,source_revision)) STRICT;
CREATE INDEX knowledge_selection_source ON knowledge_selection_sources(project,level,source_id);
CREATE INDEX knowledge_selection_source_identity ON knowledge_selection_sources(source_id,source_revision);
CREATE TABLE knowledge_recheck_pending (project TEXT NOT NULL,level TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project,level,id,revision)) STRICT;
CREATE VIRTUAL TABLE knowledge_selection_fts USING fts5(id UNINDEXED, revision UNINDEXED, project UNINDEXED, level UNINDEXED, text, tokenize='unicode61');
CREATE TABLE knowledge_selection_backfill (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), after_id TEXT NOT NULL, after_revision INTEGER NOT NULL, ready INTEGER NOT NULL) STRICT;
INSERT INTO knowledge_selection_backfill VALUES (1,'',0,0);
CREATE TRIGGER knowledge_generation_insert AFTER INSERT ON knowledge_versions BEGIN
 INSERT INTO knowledge_level_generations VALUES(new.project,new.level,1) ON CONFLICT(project,level) DO UPDATE SET generation = generation + 1;
 INSERT INTO knowledge_selection_fts(rowid,id,revision,project,level,text)
 SELECT new.rowid,new.id,new.revision,new.project,new.level,json_extract(new.knowledge,'$.title') || ' ' || json_extract(new.knowledge,'$.body') WHERE new.state = 'active';
 INSERT OR IGNORE INTO knowledge_selection_sources SELECT new.project,new.level,new.id,new.revision,
 json_extract(source.value,'$.ref.id'),json_extract(source.value,'$.ref.revision') FROM json_each(new.knowledge,'$.sources') source WHERE new.state = 'active';
END;
CREATE TRIGGER knowledge_generation_update AFTER UPDATE ON knowledge_versions BEGIN
 INSERT OR IGNORE INTO knowledge_recheck_pending SELECT project,level,id,revision FROM knowledge_selection_sources WHERE source_id = old.id;
 INSERT INTO knowledge_level_generations VALUES(new.project,new.level,1) ON CONFLICT(project,level) DO UPDATE SET generation = generation + 1;
 DELETE FROM knowledge_selection_fts WHERE rowid = old.rowid;
 DELETE FROM knowledge_selection_sources WHERE id = old.id AND revision = old.revision;
END;
CREATE TRIGGER knowledge_generation_delete AFTER DELETE ON knowledge_versions BEGIN
 INSERT OR IGNORE INTO knowledge_recheck_pending SELECT project,level,id,revision FROM knowledge_selection_sources WHERE source_id = old.id;
 INSERT INTO knowledge_level_generations VALUES(old.project,old.level,1) ON CONFLICT(project,level) DO UPDATE SET generation = generation + 1;
 DELETE FROM knowledge_selection_fts WHERE rowid = old.rowid;
 DELETE FROM knowledge_selection_sources WHERE id = old.id AND revision = old.revision;
 DELETE FROM knowledge_recheck_pending WHERE id = old.id AND revision = old.revision;
END;
CREATE TRIGGER knowledge_l1_revision AFTER INSERT ON l1_memories BEGIN
 INSERT OR IGNORE INTO knowledge_recheck_pending SELECT project,level,id,revision FROM knowledge_selection_sources WHERE source_id = new.id AND source_revision != new.revision;
END;
CREATE TRIGGER knowledge_l1_delete AFTER DELETE ON l1_memories BEGIN
 INSERT OR IGNORE INTO knowledge_recheck_pending SELECT project,level,id,revision FROM knowledge_selection_sources WHERE source_id = old.id AND source_revision = old.revision;
END;
CREATE TRIGGER knowledge_l1_audit AFTER INSERT ON memory_execution_audits WHEN new.status != 'valid' BEGIN
 INSERT OR IGNORE INTO knowledge_recheck_pending SELECT project,level,id,revision FROM knowledge_selection_sources WHERE source_id = new.memory_id AND source_revision = new.revision;
END;
`

function selectionText(value: string): string {
  // Separate Han characters so short Chinese queries use the same inverted index as Latin words.
  return (value.normalize('NFC').toLocaleLowerCase('en-US').match(/\p{Script=Han}|[\p{L}\p{N}_]+/gu) ?? []).join(' ')
}

function indexSelection(db: DatabaseSync, row: Record<string, unknown>): void {
  const owner = db.prepare('SELECT rowid FROM knowledge_versions WHERE id = ? AND revision = ?').get(textValue(row.id), integer(row.revision))!
  const rowid = integer(owner.rowid)
  db.prepare('DELETE FROM knowledge_selection_fts WHERE rowid = ?').run(rowid)
  db.prepare('DELETE FROM knowledge_selection_sources WHERE id = ? AND revision = ?').run(textValue(row.id), integer(row.revision))
  if (row.state !== 'active') return
  const knowledge = object(json(row.knowledge))
  const text = [knowledge.title, knowledge.body, knowledge.scenario].filter(value => typeof value === 'string').join(' ')
  db.prepare('INSERT INTO knowledge_selection_fts(rowid,id,revision,project,level,text) VALUES (?,?,?,?,?,?)').run(rowid, textValue(row.id), integer(row.revision), textValue(row.project), textValue(row.level), selectionText(text))
  for (const source of refs(Array.isArray(knowledge.sources) ? knowledge.sources.map(value => object(value).ref) : [])) {
    db.prepare('INSERT OR IGNORE INTO knowledge_selection_sources VALUES (?,?,?,?,?,?)').run(textValue(row.project), textValue(row.level), textValue(row.id), integer(row.revision), source.id, source.revision)
    const invalid = db.prepare(`SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM l1_memories WHERE id = ? AND revision = ?
      AND revision = (SELECT MAX(revision) FROM l1_memories WHERE id = ?))
      AND NOT EXISTS(SELECT 1 FROM knowledge_versions WHERE id = ? AND revision = ? AND state = 'active' AND json_extract(knowledge,'$.evidence') = 'supported')`)
      .get(source.id, source.revision, source.id, source.id, source.revision)
    if (invalid !== undefined) db.prepare('INSERT OR IGNORE INTO knowledge_recheck_pending VALUES (?,?,?,?)').run(textValue(row.project), textValue(row.level), textValue(row.id), integer(row.revision))
  }
}

/** Populate at most one page of historical selection documents and checkpoint atomically.
 * @param db - open migrated connection, outside another transaction.
 * @param limit - positive page bound.
 * @returns whether another page remains; the caller yields between pages before exposing the store.
 */
export function backfillConsolidationIndex(db: DatabaseSync, limit = 128): { pending: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'Selection backfill limit must be positive')
  const cursor = db.prepare('SELECT * FROM knowledge_selection_backfill WHERE singleton = 1').get()!
  if (cursor.ready === 1) return { pending: false }
  if (typeof cursor.after_id !== 'string') throw new MemoryError('corrupt', 'Invalid selection index cursor')
  const after = cursor.after_id
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare('SELECT * FROM knowledge_versions WHERE (id > ? OR (id = ? AND revision > ?)) ORDER BY id,revision LIMIT ?')
      .all(after, after, integer(cursor.after_revision), limit)
    for (const row of rows) indexSelection(db, row)
    const last = rows.at(-1)
    db.prepare('UPDATE knowledge_selection_backfill SET after_id = ?,after_revision = ?,ready = ? WHERE singleton = 1')
      .run(last === undefined ? after : textValue(last.id), last === undefined ? integer(cursor.after_revision) : integer(last.revision), Number(rows.length < limit))
    db.exec('COMMIT')
    return { pending: rows.length === limit }
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** Remove duplicated L1 traces from legacy task snapshots, preserving exact versions and recorded requests.
 * @param db - owning connection inside the version-6 schema migration transaction.
 * @returns completion after mutable task inputs contain no duplicated L1 trace arrays.
 */
export function compactLegacyKnowledgeTaskTraces(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id FROM knowledge_tasks WHERE json_valid(body)').iterate()) {
    const id = textValue(row.id)
    for (const section of ['sources', 'existing', 'lineage']) {
      const path = `$.input.${section}`
      for (const item of db.prepare(`SELECT entry.key FROM knowledge_tasks task, json_each(task.body, ?) entry
        WHERE task.id = ? AND json_type(task.body, ?) = 'array'
        AND CASE WHEN entry.type = 'object' THEN json_extract(entry.value, '$.level') = 'L1'
          AND json_type(entry.value, '$.summary.trace') IS NOT NULL ELSE 0 END`)
        .iterate(path, id, path)) {
        const tracePath = `${path}[${integer(item.key)}].summary.trace`
        db.prepare('UPDATE knowledge_tasks SET body = json_remove(body, ?) WHERE id = ?').run(tracePath, id)
      }
    }
  }
}

function storedConfig(value: unknown): KnowledgeSpec {
  const item = object(value)
  if (!['knowledge-v1', 'knowledge-v2', 'knowledge-v3', 'knowledge-v4', 'knowledge-v5', 'knowledge-v6'].includes(textValue(item.promptVersion))) throw new MemoryError('corrupt', 'Unsupported knowledge prompt version')
  const resolved = resolveKnowledgeConfig({ provider: textValue(item.provider), model: textValue(item.model),
    maxInputBytes: integer(item.maxInputBytes), maxOutputTokens: integer(item.maxOutputTokens), timeoutMs: integer(item.timeoutMs),
    maxCalls: integer(item.maxCalls), maxAttempts: integer(item.maxAttempts), retryBaseMs: integer(item.retryBaseMs), retryMaxMs: integer(item.retryMaxMs),
    scoreMin: integer(item.scoreMin), scoreMax: integer(item.scoreMax), l2Threshold: integer(item.l2Threshold), l3Threshold: integer(item.l3Threshold),
    ...item.maxExisting === undefined ? {} : { maxExisting: integer(item.maxExisting) },
    ...item.maxSearchTerms === undefined ? {} : { maxSearchTerms: integer(item.maxSearchTerms) } })
  const { maxExisting: _default, maxSearchTerms: _termsDefault, ...legacy } = resolved
  return { ...legacy, ...item.maxExisting === undefined ? {} : { maxExisting: resolved.maxExisting },
    ...item.maxSearchTerms === undefined ? {} : { maxSearchTerms: resolved.maxSearchTerms }, promptVersion: item.promptVersion as KnowledgeSpec['promptVersion'] }
}

function refs(value: unknown): MemoryRef[] {
  if (!Array.isArray(value)) throw new MemoryError('corrupt', 'Expected reference list')
  return value.map(knowledgeRef)
}

function levelOf(value: unknown): KnowledgeLevel {
  if (value !== 'L2' && value !== 'L3') throw new MemoryError('corrupt', 'Invalid knowledge level')
  return value
}

/** Internal store; no model tools or user approval adapter are installed by this class. */
export class KnowledgeStore {
  /** Queue current preceding-level versions and source rechecks without dispatching model work.
   * @param project - owner. @param level - target. @param config - frozen model settings.
   * @param pageSize - source page bound.
   */
  enqueueCandidates(project: ProjectId, level: KnowledgeLevel, config: KnowledgeSpec, pageSize: number): void {
    let after = ''
    for (;;) {
      const records = this.listCandidates(project, level === 'L2' ? 'L1' : 'L2', after, pageSize)
      for (const record of records) this.enqueue(project, level, [record], config)
      if (records.length < pageSize) break
      after = records.at(-1)!.id
    }
    this.enqueueRechecks(project, level, config)
  }
  /** @param db - parent-owned connection.
   * @param l1 - existing L1 reader.
   * @param changed - nonthrowing post-commit notification.
   * @param assertOpen - parent lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly l1: L1Store, private readonly assertOpen: () => void, private readonly changed: () => void = () => {}) {}

  private transaction<T>(run: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try { result = run(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.changed()
    return result
  }

  private decode(value: unknown, validateExamined = true): KnowledgeMemory {
    const row = object(value)
    const config = storedConfig(json(row.config))
    const state = textValue(row.state)
    if (!['active', 'superseded', 'invalidated'].includes(state)) throw new MemoryError('corrupt', 'Invalid knowledge state')
    const memory: KnowledgeMemory = { id: textValue(row.id) as MemoryId, revision: integer(row.revision), projectId: textValue(row.project) as ProjectId,
      operationId: textValue(row.operation_id) as OperationId, level: levelOf(row.level), knowledge: parseKnowledge(json(row.knowledge), config),
      config, createdAt: integer(row.created_at), state: state as KnowledgeMemory['state'] }
    if (validateExamined && memory.knowledge.examinedEvents !== undefined) {
      const allowed = this.ancestralEvents(memory.projectId, memory.knowledge.sources.map(source => source.ref))
      if (memory.knowledge.examinedEvents.some(ref => !allowed.has(JSON.stringify(ref)))) throw new MemoryError('source', 'Stored examined event is outside knowledge ancestry')
    }
    return memory
  }

  private ancestralEvents(project: ProjectId, refs: readonly MemoryRef[]): Set<string> {
    const allowed = new Set<string>()
    const seen = new Set<string>()
    const pending = [...refs]
    while (pending.length > 0) {
      const ref = pending.pop()!
      const key = JSON.stringify([ref.id, ref.revision])
      if (seen.has(key)) continue
      seen.add(key)
      const l1 = this.l1.getMemory(project, ref)
      if (l1 !== null) { for (const event of l1.summary.sources) allowed.add(JSON.stringify(event)); continue }
      const parent = this.db.prepare('SELECT * FROM knowledge_versions WHERE id = ? AND revision = ? AND project = ?').get(ref.id, ref.revision, project)
      if (parent === undefined) throw new MemoryError('source', 'Missing examined-event ancestry')
      pending.push(...this.decode(parent, false).knowledge.sources.map(source => source.ref))
    }
    return allowed
  }

  /** Read private history or the minimal currently authorized L3 projection.
   * @param project - requesting project.
   * @param ref - exact version.
   * @returns visible record or null without disclosing other projects' data.
   */
  getMemory(project: ProjectId, ref: MemoryRef): OwnedMemory | SharedMemory | null {
    this.assertOpen()
    const l1 = this.l1.getMemory(project, ref)
    if (l1 !== null) return l1
    const row = this.db.prepare('SELECT * FROM knowledge_versions WHERE id = ? AND revision = ?').get(ref.id, ref.revision)
    if (row === undefined) return null
    if (row.project === project) return this.decode(row)
    if (row.level !== 'L3' || row.state !== 'active' || this.db.prepare('SELECT 1 FROM knowledge_grants WHERE id = ? AND revision = ?').get(ref.id, ref.revision) === undefined) return null
    const memory = this.decode(row)
    if (memory.knowledge.evidence !== 'supported' || !this.sourcesCurrent(memory.projectId, memory)) return null
    return { id: memory.id, revision: memory.revision, projectId: memory.projectId, level: 'L3', shared: true,
      title: memory.knowledge.title, body: memory.knowledge.body,
      ...memory.knowledge.scenario === undefined ? {} : { scenario: memory.knowledge.scenario },
      ...memory.knowledge.kind === undefined ? {} : { kind: memory.knowledge.kind } }
  }

  /** Check exact source revisions recursively without rewriting historical content.
   * @param project - owning project.
   * @param ref - exact version to inspect.
   * @returns false for missing, retired, unsupported or cyclic ancestry.
   */
  sourcesCurrent(project: ProjectId, ref: MemoryRef): boolean {
    const seen = new Set<string>()
    const checked = new Set<string>()
    const visit = (reference: MemoryRef): boolean => {
      const key = JSON.stringify([reference.id, reference.revision])
      if (seen.has(key)) return false
      if (checked.has(key)) return true
      const record = this.getMemory(project, reference)
      if (record === null || 'shared' in record || record.state !== 'active') return false
      seen.add(key)
      const valid = record.level === 'L1' ? this.l1.evidenceUsable(project, reference)
        : record.knowledge.evidence === 'supported' && record.knowledge.sources.every(source => visit(source.ref))
      seen.delete(key)
      if (valid) checked.add(key)
      return valid
    }
    return visit(ref)
  }

  /** Browse current owned records including unresolved evidence, plus approved shared L3.
   * @param project - requesting project.
   * @param level - requested level.
   * @param after - exclusive memory identity.
   * @param limit - bounded page size supplied by the browser.
   * @param query - literal substring; no SQL wildcards.
   * @param filter - optional scenario and knowledge/profile selectors; apply to knowledge levels.
   * @returns visible records in identity order.
   */
  browse(project: ProjectId, level: 'L1' | KnowledgeLevel, after: string, limit: number, query: string, filter: KnowledgeFilter = {}): Array<OwnedMemory | SharedMemory> {
    this.assertOpen()
    const statement = level === 'L1'
      ? this.db.prepare(`SELECT id,revision FROM l1_memories v WHERE project = ? AND id > ?
          AND revision = (SELECT MAX(revision) FROM l1_memories latest WHERE latest.id = v.id)
          AND instr(lower(summary),lower(?)) > 0
          ORDER BY id LIMIT ?`)
      : this.db.prepare(`SELECT id,revision FROM knowledge_versions v WHERE state = 'active' AND level = ? AND id > ?
          AND (project = ? OR (level = 'L3' AND json_extract(knowledge,'$.evidence') = 'supported'
            AND EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.id = v.id AND g.revision = v.revision)))
          AND instr(lower(knowledge),lower(?)) > 0
          AND (? IS NULL OR coalesce(json_extract(knowledge,'$.kind'),'knowledge') = ?)
          AND (? IS NULL OR json_extract(knowledge,'$.scenario') = ?)
          ORDER BY id LIMIT ?`)
    const result: Array<OwnedMemory | SharedMemory> = []
    let cursor = after
    for (;;) {
      const rows = level === 'L1' ? statement.all(project, cursor, query, limit) : statement.all(level, cursor, project, query, filter.kind ?? null, filter.kind ?? null, filter.scenario ?? null, filter.scenario ?? null, limit)
      for (const row of rows) {
        const visible = this.getMemory(project, knowledgeRef(row))
        if (visible !== null) result.push(visible)
        if (result.length === limit) return result
      }
      if (rows.length < limit) return result
      cursor = textValue(rows.at(-1)?.id)
    }
  }

  /** History references never expand private sources of shared knowledge.
   * @param project - requesting project.
   * @param id - logical memory identity.
   * @param before - exclusive descending revision cursor.
   * @param limit - bounded page size supplied by the browser.
   * @returns owned version references, newest first; foreign identities return an empty page.
   */
  revisions(project: ProjectId, id: MemoryId, before: number, limit: number): MemoryRef[] {
    this.assertOpen()
    return this.db.prepare(`SELECT id,revision FROM l1_memories WHERE project = ? AND id = ? AND revision < ?
      UNION ALL SELECT id,revision FROM knowledge_versions WHERE project = ? AND id = ? AND revision < ?
      ORDER BY revision DESC LIMIT ?`).all(project, id, before, project, id, before, limit).map(row => knowledgeRef(row))
  }

  private owned(project: ProjectId, ref: MemoryRef): OwnedMemory {
    const record = this.getMemory(project, ref)
    if (record === null || 'shared' in record || record.projectId !== project) throw new MemoryError('source', 'Project-owned memory does not exist')
    return record
  }

  /** Page usable knowledge; unresolved evidence stays accessible only through owned history.
   * @param project - requesting project.
   * @param level - requested knowledge level.
   * @param after - previous stable identity, empty for the first page.
   * @param limit - positive page size.
   * @returns active supported owned or approved shared records.
   */
  listCandidates(project: ProjectId, level: 'L1' | KnowledgeLevel, after = '', limit = 100): Array<OwnedMemory | SharedMemory> {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'Candidate limit must be positive')
    if (level === 'L1') {
      const result: OwnedMemory[] = []
      let cursor = after
      for (;;) {
        const rows = this.db.prepare('SELECT id, MAX(revision) AS revision FROM l1_memories WHERE project = ? AND id > ? GROUP BY id ORDER BY id LIMIT ?').all(project, cursor, limit)
        for (const row of rows) {
          const ref = knowledgeRef(row)
          if (this.l1.evidenceUsable(project, ref)) result.push(this.owned(project, ref))
          if (result.length === limit) return result
        }
        if (rows.length < limit) return result
        cursor = textValue(rows.at(-1)!.id)
      }
    }
    const result: Array<OwnedMemory | SharedMemory> = []
    let cursor = after
    const statement = this.db.prepare(`SELECT * FROM knowledge_versions v WHERE state = 'active' AND level = ? AND id > ? AND json_extract(knowledge, '$.evidence') = 'supported'
      AND (project = ? OR (level = 'L3' AND EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.id = v.id AND g.revision = v.revision))) ORDER BY id LIMIT ?`)
    for (;;) {
      const rows = statement.all(level, cursor, project, limit)
      for (const row of rows) {
        const memory = this.decode(row)
        if (!this.sourcesCurrent(memory.projectId, memory)) continue
        const visible = this.getMemory(project, memory)
        if (visible !== null) result.push(visible)
        if (result.length === limit) return result
      }
      if (rows.length < limit) return result
      cursor = textValue(rows.at(-1)?.id)
    }
  }

  private generation(project: ProjectId, level: KnowledgeLevel): number {
    const row = this.db.prepare('SELECT generation FROM knowledge_level_generations WHERE project = ? AND level = ?').get(project, level)
    return row === undefined ? 0 : integer(row.generation)
  }

  private input(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[], config: KnowledgeSpec, recheck?: MemoryRef): KnowledgeInput {
    const unique = [...new Map(sources.map(ref => [JSON.stringify(ref), ref])).values()]
    if (unique.length === 0) throw new MemoryError('source', 'Consolidation requires source versions')
    const records = unique.map(ref => this.owned(project, ref))
    if (records.some(record => !this.sourcesCurrent(project, record) || record.level !== (level === 'L2' ? 'L1' : 'L2'))) throw new MemoryError('source', 'Invalid consolidation source level or state')
    if (this.db.prepare('SELECT ready FROM knowledge_selection_backfill WHERE singleton = 1').get()?.ready !== 1) throw new MemoryError('storage', 'Knowledge selection index is not ready; retry after initialization')
    const maxExisting = config.maxExisting ?? 64
    const selected = new Map<string, MemoryRef>()
    if (recheck !== undefined) {
      const row = this.db.prepare("SELECT id,revision FROM knowledge_versions WHERE project = ? AND level = ? AND id = ? AND revision = ? AND state = 'active'")
        .get(project, level, recheck.id, recheck.revision)
      if (row !== undefined) selected.set(recheck.id, knowledgeRef(row))
    }
    for (const source of records) {
      const linked = this.db.prepare(`SELECT s.id,s.revision FROM knowledge_selection_sources s JOIN knowledge_versions v ON v.id = s.id AND v.revision = s.revision
        WHERE s.project = ? AND s.level = ? AND s.source_id = ? AND v.state = 'active' ORDER BY s.id LIMIT ?`).all(project, level, source.id, maxExisting + 1)
      for (const row of linked) selected.set(textValue(row.id), knowledgeRef(row))
      if (selected.size > maxExisting) throw new MemoryError('budget', 'Required related knowledge exceeds maxExisting; increase the comparison budget')
    }
    const requiredExisting = [...selected.values()]
    const text = records.map(record => record.level === 'L1' ? `${record.summary.goal} ${record.summary.actions.join(' ')} ${record.summary.result}`
      : `${record.knowledge.title} ${record.knowledge.body} ${record.knowledge.scenario ?? ''}`).join(' ')
    const terms = [...new Set(selectionText(text).split(' ').filter(Boolean))].slice(0, config.maxSearchTerms ?? 64)
    if (terms.length > 0 && selected.size < maxExisting) {
      const query = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
      const rows = this.db.prepare(`SELECT id,revision FROM knowledge_selection_fts WHERE knowledge_selection_fts MATCH ? AND project = ? AND level = ? ORDER BY id LIMIT ?`)
        .all(query, project, level, maxExisting)
      for (const row of rows) {
        if (selected.size === maxExisting) break
        selected.set(textValue(row.id), knowledgeRef(row))
      }
    }
    const existing = [...selected.values()].map(ref => {
      const record = this.owned(project, ref)
      if (record.level === 'L1') throw new MemoryError('corrupt', 'Selection index contains an L1 record')
      return record
    }).sort((a, b) => a.id.localeCompare(b.id))
    return { projectId: project, level, sources: records.sort((a, b) => a.id.localeCompare(b.id)), existing,
      generation: this.generation(project, level), requiredExisting, lineage: this.lineage(project, [...records, ...existing]) }
  }

  private lineage(project: ProjectId, records: readonly OwnedMemory[]): OwnedMemory[] {
    const found = new Map<string, OwnedMemory>()
    const pending = [...records]
    while (pending.length > 0) {
      const record = pending.pop()!
      if (record.level === 'L1') continue
      for (const source of record.knowledge.sources) {
        const key = JSON.stringify(source.ref)
        if (found.has(key)) continue
        const parent = this.owned(project, source.ref)
        found.set(key, parent)
        pending.push(parent)
      }
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)
  }

  /** Freeze same-project source versions and settings; repeated equivalent enqueue is idempotent.
   * @param project - owning project.
   * @param level - L2 or L3.
   * @param sources - exact previous-level versions.
   * @param config - resolved scoring and model settings.
   * @param recheck - optional affected version; gives recovery its own idempotent operation.
   * @returns durable task identity.
   */
  enqueue(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[], config: KnowledgeSpec,
    recheck?: MemoryRef): OperationId {
    return this.transaction(() => {
      const input = this.input(project, level, sources, config, recheck)
      const operationId = l1Key(recheck === undefined ? 'knowledge' : 'knowledge-recheck', project, level,
        input.sources.map(({ id, revision }) => ({ id, revision })), config, ...recheck === undefined ? [] : [recheck]) as OperationId
      if (this.getTask(project, operationId) !== null) return operationId
      this.save({ operationId, ...recheck === undefined ? {} : { recheck }, input, config, status: 'pending', attempts: 0, calls: 0, nextRetryAt: 0, failure: null,
        candidates: null, result: null, owner: null, leaseUntil: 0 })
      return operationId
    })
  }

  /** Queue rechecking from eligible current parents; unavailable sources leave history paused.
   * @param project - owner.
   * @param level - target level.
   * @param config - resolved model settings.
   */
  enqueueRechecks(project: ProjectId, level: KnowledgeLevel, config: KnowledgeSpec): void {
    for (const row of this.db.prepare('SELECT id,revision FROM knowledge_recheck_pending WHERE project = ? AND level = ? ORDER BY id').iterate(project, level)) {
      const ref = knowledgeRef(row)
      const record = this.owned(project, ref)
      const remove = () => this.db.prepare('DELETE FROM knowledge_recheck_pending WHERE project = ? AND level = ? AND id = ? AND revision = ?').run(project, level, ref.id, ref.revision)
      if (record.level === 'L1' || record.state !== 'active' || record.knowledge.sources.every(source => this.sourcesCurrent(project, source.ref))) { remove(); continue }
      const sources = record.knowledge.sources.flatMap((source) => {
        const rows = this.db.prepare(`SELECT id,revision FROM l1_memories WHERE project = ? AND id = ?
          UNION ALL SELECT id,revision FROM knowledge_versions WHERE project = ? AND id = ? AND state = 'active'
          ORDER BY revision DESC LIMIT 1`).all(project, source.ref.id, project, source.ref.id)
        if (rows.length === 0) return []
        const current = this.owned(project, knowledgeRef(rows[0]))
        return current.level === (level === 'L2' ? 'L1' : 'L2') && this.sourcesCurrent(project, current) ? [current] : []
      })
      if (sources.length > 0) { this.enqueue(project, level, sources, config, { id: record.id, revision: record.revision }); remove() }
    }
  }

  private save(task: KnowledgeTask): void {
    const input = { ...task.input, lineage: undefined, sources: task.input.sources.map(({ id, revision }) => ({ id, revision })), existing: task.input.existing.map(({ id, revision }) => ({ id, revision })) }
    this.db.prepare('INSERT INTO knowledge_tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(task.operationId, task.input.projectId, JSON.stringify({ ...task, input }))
  }

  /** Read task state and exact input versions retained for its latest attempt.
   * @param project - owner.
   * @param operation - operation identity.
   * @returns task or null for invisible identities.
   */
  getTask(project: ProjectId, operation: OperationId): KnowledgeTask | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT body FROM knowledge_tasks WHERE project = ? AND id = ?').get(project, operation)
    if (row === undefined) return null
    const item = object(json(row.body))
    const rawInput = object(item.input)
    const snapshot = (ref: MemoryRef): OwnedMemory => ({ ...this.owned(project, ref), state: 'active' })
    const sourceRecords = refs(rawInput.sources).map(snapshot)
    const existingRecords = refs(rawInput.existing).map(snapshot)
    const input: KnowledgeInput = { lineage: this.lineage(project, [...sourceRecords, ...existingRecords]), projectId: project, level: levelOf(rawInput.level), sources: sourceRecords,
      ...rawInput.generation === undefined ? {} : { generation: integer(rawInput.generation) },
      ...rawInput.requiredExisting === undefined ? {} : { requiredExisting: refs(rawInput.requiredExisting) },
      existing: existingRecords.map(memory => {
        if (memory.level === 'L1') throw new MemoryError('corrupt', 'Invalid existing knowledge')
        return memory
      }) }
    const config = storedConfig(item.config)
    const status = textValue(item.status)
    if (!['pending', 'running', 'prepared', 'retry', 'failed', 'done'].includes(status)) throw new MemoryError('corrupt', 'Invalid task status')
    return { operationId: operation, ...item.recheck === undefined ? {} : { recheck: knowledgeRef(item.recheck) }, input, config, status: status as KnowledgeTask['status'], attempts: integer(item.attempts), calls: integer(item.calls),
      nextRetryAt: integer(item.nextRetryAt), failure: item.failure === null ? null : textValue(item.failure),
      candidates: item.candidates === null ? null : parseKnowledgeCandidates(item.candidates, input, config),
      result: item.result === null ? null : refs(item.result), owner: item.owner === null ? null : textValue(item.owner), leaseUntil: integer(item.leaseUntil) }
  }

  /** Page durable tasks in identity order.
   * @param project - owner.
   * @param after - exclusive cursor.
   * @param limit - positive page size.
   * @returns task page.
   */
  listTasks(project: ProjectId, after = '', limit = 100): KnowledgeTask[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'Task limit must be positive')
    return this.db.prepare('SELECT id FROM knowledge_tasks WHERE project = ? AND id > ? ORDER BY id LIMIT ?').all(project, after, limit)
      .map(row => this.getTask(project, textValue(row.id) as OperationId)!)
  }

  /** List failed extraction tasks without scanning completed tasks.
   * @param project - owner.
   * @param limit - positive display page size.
   * @returns failed tasks in identity order, limited for the panel.
   */
  getFailedTasks(project: ProjectId, limit = 100): KnowledgeTask[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MemoryError('config', 'Task limit must be positive')
    return this.db.prepare("SELECT id FROM knowledge_tasks WHERE project = ? AND json_extract(body, '$.status') = 'failed' ORDER BY id LIMIT ?").all(project, limit)
      .map(row => this.getTask(project, textValue(row.id) as OperationId)!)
  }

  /** Find durable work without taking a lease; a current project lease delays all other work.
   * @param project - owning project.
   * @returns next operation and earliest eligible time, or null when no work remains.
   */
  nextDue(project: ProjectId): { operationId: OperationId; at: number } | null {
    this.assertOpen()
    const row = this.db.prepare(`WITH available AS (
      SELECT id, CASE WHEN json_extract(body, '$.status') IN ('running', 'prepared')
        THEN json_extract(body, '$.leaseUntil') ELSE json_extract(body, '$.nextRetryAt') END AS due
      FROM knowledge_tasks WHERE project = ? AND json_extract(body, '$.status') IN ('pending', 'retry', 'running', 'prepared')
    ), lease AS (
      SELECT COALESCE(MAX(json_extract(body, '$.leaseUntil')), 0) AS until_at
      FROM knowledge_tasks WHERE project = ? AND json_extract(body, '$.status') IN ('running', 'prepared')
    )
    SELECT id, MAX(due, (SELECT until_at FROM lease)) AS at FROM available ORDER BY at, id LIMIT 1`).get(project, project)
    return row === undefined ? null : { operationId: textValue(row.id) as OperationId, at: integer(row.at) }
  }

  /** Claim with a project-wide lease and refresh unprepared input before model dispatch.
   * @param project - owner.
   * @param operation - task.
   * @param owner - worker identity.
   * @param now - current epoch milliseconds.
   * @returns claimed state or null when unavailable.
   */
  claim(project: ProjectId, operation: OperationId, owner: string, now: number): KnowledgeTask | null {
    return this.transaction(() => {
      const task = this.getTask(project, operation)
      if (task === null || task.status === 'done' || task.status === 'failed' || task.nextRetryAt > now || task.leaseUntil > now) return null
      const active = this.db.prepare("SELECT 1 FROM knowledge_tasks WHERE project = ? AND json_extract(body, '$.leaseUntil') > ? LIMIT 1").get(project, now)
      if (active !== undefined) return null
      if (task.input.sources.some(source => !this.sourcesCurrent(project, source))) {
        this.save({ ...task, status: 'failed', failure: 'SOURCE_CHANGED', candidates: null, owner: null, leaseUntil: 0 })
        return null
      }
      if (task.attempts >= task.config.maxAttempts) { this.save({ ...task, status: 'failed', failure: 'ATTEMPTS_EXHAUSTED', owner: null, leaseUntil: 0 }); return null }
      let input = task.input
      if (task.candidates === null) {
        try { input = this.input(project, task.input.level, task.input.sources, task.config, task.recheck) }
        catch (error) {
          if (!(error instanceof MemoryError) || error.code !== 'budget') throw error
          this.save({ ...task, status: 'failed', failure: 'budget', candidates: null, owner: null, leaseUntil: 0 })
          return null
        }
      }
      const recheck = task.recheck
      if (recheck !== undefined && !input.existing.some(record => record.id === recheck.id && record.revision === recheck.revision)) {
        this.save({ ...task, status: 'failed', failure: 'TARGET_CHANGED', candidates: null, owner: null, leaseUntil: 0 })
        return null
      }
      const claimed: KnowledgeTask = { ...task, input, status: task.candidates === null ? 'running' : 'prepared', attempts: task.attempts + 1,
        owner, leaseUntil: now + task.config.timeoutMs + task.config.retryMaxMs }
      this.save(claimed)
      return claimed
    })
  }

  private held(task: KnowledgeTask | null, owner: string): KnowledgeTask {
    if (task === null || task.owner !== owner || (task.status !== 'running' && task.status !== 'prepared')) throw new MemoryError('conflict', 'Knowledge worker no longer owns the task')
    return task
  }

  /** Charge a durable model call immediately before dispatch.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   * @param now - dispatch timestamp used to renew the lease for this call and its settlement.
   */
  reserveCall(project: ProjectId, operation: OperationId, owner: string, now = Date.now()): void {
    this.transaction(() => {
      const task = this.held(this.getTask(project, operation), owner)
      if (task.calls >= task.config.maxCalls) throw new MemoryError('budget', 'Knowledge call budget exhausted')
      this.save({ ...task, calls: task.calls + 1, leaseUntil: Math.max(task.leaseUntil, now + task.config.timeoutMs + task.config.retryMaxMs) })
    })
  }

  /** Save validated results before attempting the publication transaction.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   * @param value - untrusted model JSON.
   */
  prepare(project: ProjectId, operation: OperationId, owner: string, value: unknown): void {
    this.transaction(() => {
      const task = this.held(this.getTask(project, operation), owner)
      const candidates = parseKnowledgeCandidates(value, task.input, task.config)
      if (candidates.some(candidate => candidate.knowledge.confirmation !== undefined)) throw new MemoryError('output', 'Learning cannot establish trusted confirmation')
      this.save({ ...task, candidates, status: 'prepared' })
    })
  }

  /** Commit a whole candidate batch atomically, retaining exact operation results.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   * @param now - commit timestamp.
   * @returns immutable references, also on repeated commits.
   */
  commit(project: ProjectId, operation: OperationId, owner: string, now: number): readonly MemoryRef[] {
    return this.transaction(() => {
      const old = this.getTask(project, operation)
      if (old?.status === 'done') return old.result!
      const task = this.held(old, owner)
      if (task.candidates === null) throw new MemoryError('conflict', 'Knowledge task is not prepared')
      if (task.input.sources.some(source => !this.sourcesCurrent(project, source))) throw new MemoryError('source', 'Knowledge source revisions changed')
      if (task.input.generation !== undefined && this.generation(project, task.input.level) !== task.input.generation) throw new MemoryError('conflict', 'Knowledge revisions changed')
      for (const record of task.input.existing) {
        const current = this.owned(project, record)
        if (current.state !== 'active') throw new MemoryError('conflict', 'Knowledge revisions changed')
      }
      const result: MemoryRef[] = []
      for (const candidate of task.candidates) {
        if (candidate.action === 'skip') continue
        const threshold = task.input.level === 'L2' ? task.config.l2Threshold : task.config.l3Threshold
        if (candidate.knowledge.evidence !== 'conflict' && (candidate.knowledge.score < threshold || candidate.knowledge.category === 'temporary')) continue
        const key = knowledgeKey(candidate.knowledge)
        const duplicateRow = this.db.prepare("SELECT * FROM knowledge_versions WHERE project = ? AND level = ? AND content_key = ? AND state = 'active'").get(project, task.input.level, key)
        const duplicate = duplicateRow === undefined ? undefined : this.decode(duplicateRow)
        if (candidate.target !== null && duplicate !== undefined && duplicate.id !== candidate.target.id) throw new MemoryError('output', 'Merge target collides with another knowledge identity')
        const target = candidate.target === null ? duplicate : this.owned(project, candidate.target)
        if (target?.level === 'L1') throw new MemoryError('source', 'Cannot replace L1 with knowledge')
        const cited = candidate.knowledge.sources.flatMap(source => source.ref.id === target?.id
          ? target.knowledge.sources.filter(parent => this.sourcesCurrent(project, parent.ref)) : [source])
        if (cited.some(source => !this.sourcesCurrent(project, source.ref))) {
          throw new MemoryError('source', 'Knowledge source changed or would retire during publication')
        }
        const retained = target?.knowledge.sources.filter(source => this.sourcesCurrent(project, source.ref)) ?? []
        const sources = [...new Map([...retained, ...cited].map(source => [JSON.stringify(source.ref), source])).values()]
        const allowedEvents = candidate.knowledge.examinedEvents === undefined ? undefined : this.ancestralEvents(project, sources.map(source => source.ref))
        const examinedEvents = candidate.knowledge.examinedEvents?.filter(ref => allowedEvents!.has(JSON.stringify(ref)))
        if (examinedEvents?.length === 0) throw new MemoryError('source', 'Published knowledge requires examined events from retained ancestry')
        const knowledge = { ...candidate.knowledge, sources, ...examinedEvents === undefined ? {} : { examinedEvents } }
        if (target !== undefined && isDeepStrictEqual(target.knowledge, knowledge)) { result.push({ id: target.id, revision: target.revision }); continue }
        const ref = { id: target?.id ?? randomUUID() as MemoryId, revision: (target?.revision ?? 0) + 1 }
        if (target !== undefined) this.retire(target, 'superseded')
        this.db.prepare('INSERT INTO knowledge_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ref.id, ref.revision, project, task.input.level, operation, key, JSON.stringify(knowledge), JSON.stringify(task.config), now, 'active')
        indexSelection(this.db, this.db.prepare('SELECT * FROM knowledge_versions WHERE id = ? AND revision = ?').get(ref.id, ref.revision)!)
        result.push(ref)
      }
      this.save({ ...task, status: 'done', result, owner: null, leaseUntil: 0, failure: null })
      return result
    })
  }

  /** Confirm an exact active conclusion through a trusted adapter, retaining the previous version.
   * @param project - authoritative owner.
   * @param ref - exact supported version explicitly confirmed by the actor.
   * @param receipt - trusted user/external verification, never inferred from assistant text.
   * @returns confirmed new version; a repeated identical receipt returns its original result.
   */
  confirmEvidence(project: ProjectId, ref: MemoryRef, receipt: EvidenceConfirmation): MemoryRef {
    return this.transaction(() => {
      const operation = l1Key('evidence-confirmation', project, receipt.receiptId)
      const request = { project, ref, receipt }
      const prior = this.db.prepare('SELECT request,result FROM knowledge_operations WHERE id = ?').get(operation)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(json(prior.request), request)) throw new MemoryError('conflict', 'Confirmation receipt was reused for different evidence')
        return knowledgeRef(json(prior.result))
      }
      const target = this.owned(project, ref)
      if (target.level === 'L1' || target.state !== 'active' || !this.sourcesCurrent(project, target)) throw new MemoryError('source', 'Confirmation requires current supported knowledge')
      const knowledge = parseKnowledge({ ...target.knowledge, evidenceStatus: receipt.status, confirmation: receipt }, target.config)
      const next = { id: target.id, revision: target.revision + 1 }
      this.retire(target, 'superseded')
      this.db.prepare('INSERT INTO knowledge_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(next.id, next.revision, project, target.level,
        operation, knowledgeKey(knowledge), JSON.stringify(knowledge), JSON.stringify(target.config), receipt.occurredAt, 'active')
      indexSelection(this.db, this.db.prepare('SELECT * FROM knowledge_versions WHERE id = ? AND revision = ?').get(next.id, next.revision)!)
      this.db.prepare('INSERT INTO knowledge_operations VALUES (?, ?, ?)').run(operation, JSON.stringify(request), JSON.stringify(next))
      return next
    })
  }

  private retire(ref: MemoryRef, state: 'superseded' | 'invalidated'): void {
    this.db.prepare('UPDATE knowledge_versions SET state = ? WHERE id = ? AND revision = ?').run(state, ref.id, ref.revision)
    this.db.prepare('DELETE FROM knowledge_grants WHERE id = ? AND revision = ?').run(ref.id, ref.revision)
  }

  /** Preserve storage retries, discard stale merges, and refund cancelled attempts without refunding calls.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   * @param failure - safe diagnostic category, null for cancellation.
   * @param retryable - whether a bounded retry is allowed.
   * @param now - failure timestamp.
   */
  fail(project: ProjectId, operation: OperationId, owner: string, failure: string | null, retryable: boolean, now: number): void {
    this.transaction(() => {
      const task = this.held(this.getTask(project, operation), owner)
      let input = task.input
      let candidates = task.candidates
      if (failure === 'conflict') { input = this.input(project, task.input.level, task.input.sources, task.config, task.recheck); candidates = null }
      const attempts = failure === null ? Math.max(0, task.attempts - 1) : task.attempts
      this.save({ ...task, input, candidates, attempts,
        status: (failure === null || retryable) && attempts < task.config.maxAttempts ? 'retry' : 'failed',
        failure, owner: null, leaseUntil: 0,
        nextRetryAt: failure === null ? now : now + Math.min(task.config.retryMaxMs, task.config.retryBaseMs * 2 ** (attempts - 1)) })
    })
  }

  /** Explicitly resume a failed operation without resetting its lifetime call budget.
   * @param project - owner.
   * @param operation - task identity.
   */
  retry(project: ProjectId, operation: OperationId): void {
    this.transaction(() => {
      const task = this.getTask(project, operation)
      if (task === null || task.status !== 'failed') throw new MemoryError('conflict', 'Only failed knowledge tasks can be retried')
      this.save({ ...task, status: 'pending', attempts: 0, nextRetryAt: 0, owner: null, leaseUntil: 0 })
    })
  }

  /** Invalidate one current owned version and revoke its grant atomically.
   * @param project - owner.
   * @param ref - expected current version.
   * @param reason - explicit audit reason.
   * @param operation - idempotent user operation.
   */
  invalidateMemory(project: ProjectId, ref: MemoryRef, reason: string, operation: OperationId): void {
    this.transaction(() => {
      const request = { project, ref, reason: textValue(reason) }
      const prior = this.db.prepare('SELECT request FROM knowledge_operations WHERE id = ?').get(operation)
      if (prior !== undefined) { if (!isDeepStrictEqual(json(prior.request), request)) throw new MemoryError('conflict', 'Operation identity was reused'); return }
      const memory = this.owned(project, ref)
      if (memory.level === 'L1' || memory.state !== 'active') throw new MemoryError('conflict', 'Only current knowledge can be invalidated')
      this.retire(ref, 'invalidated')
      this.db.prepare('INSERT INTO knowledge_operations VALUES (?, ?, ?)').run(operation, JSON.stringify(request), 'null')
    })
  }

  /** Persist a grant only after an external trusted user adapter verifies the exact receipt.
   * @param action - complete exact-version user action.
   * @param verify - trusted adapter; never install a model-supplied verifier.
   * @param now - verification timestamp.
   */
  approveShare(action: ShareAction, verify: (action: ShareAction) => boolean, now: number): void {
    if (action.action !== 'approve') throw new MemoryError('source', 'Expected approval action')
    this.share(action, verify, now)
  }

  /** Revoke future visibility without rewriting any historical Session.
   * @param action - complete exact-version user action.
   * @param verify - trusted adapter verifying the receipt.
   * @param now - verification timestamp.
   */
  revokeShare(action: ShareAction, verify: (action: ShareAction) => boolean, now: number): void {
    if (action.action !== 'revoke') throw new MemoryError('source', 'Expected revocation action')
    this.share(action, verify, now)
  }

  private share(action: ShareAction, verify: (action: ShareAction) => boolean, now: number): void {
    if (!verify(action) || !action.userId.trim() || !action.receiptId.trim() || !Number.isSafeInteger(action.occurredAt)
      || !Number.isSafeInteger(action.expiresAt) || action.occurredAt > now || action.expiresAt <= now) throw new MemoryError('source', 'Invalid or expired user action receipt')
    this.transaction(() => {
      const prior = this.db.prepare('SELECT request FROM knowledge_share_actions WHERE id = ?').get(action.operationId)
      if (prior !== undefined) { if (!isDeepStrictEqual(json(prior.request), action)) throw new MemoryError('conflict', 'Share operation identity was reused'); return }
      const memory = this.owned(action.projectId, action.ref)
      if (memory.level !== 'L3' || (action.action === 'approve' && !this.sourcesCurrent(action.projectId, memory))) throw new MemoryError('source', 'Only current supported L3 can be approved')
      if (this.db.prepare('SELECT 1 FROM knowledge_share_actions WHERE receipt_id = ?').get(action.receiptId) !== undefined) throw new MemoryError('conflict', 'User receipt already consumed')
      this.db.prepare('INSERT INTO knowledge_share_actions VALUES (?, ?, ?)').run(action.operationId, action.receiptId, JSON.stringify(action))
      if (action.action === 'approve') this.db.prepare('INSERT INTO knowledge_grants VALUES (?, ?, ?) ON CONFLICT(id,revision) DO UPDATE SET action_id = excluded.action_id').run(action.ref.id, action.ref.revision, action.operationId)
      else this.db.prepare('DELETE FROM knowledge_grants WHERE id = ? AND revision = ?').run(action.ref.id, action.ref.revision)
    })
  }
}
