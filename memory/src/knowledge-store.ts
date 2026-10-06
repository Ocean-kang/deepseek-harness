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

function storedConfig(value: unknown): KnowledgeSpec {
  const item = object(value)
  if (!['knowledge-v1', 'knowledge-v2', 'knowledge-v3', 'knowledge-v4'].includes(textValue(item.promptVersion))) throw new MemoryError('corrupt', 'Unsupported knowledge prompt version')
  return { ...resolveKnowledgeConfig({ provider: textValue(item.provider), model: textValue(item.model),
    maxInputBytes: integer(item.maxInputBytes), maxOutputTokens: integer(item.maxOutputTokens), timeoutMs: integer(item.timeoutMs),
    maxCalls: integer(item.maxCalls), maxAttempts: integer(item.maxAttempts), retryBaseMs: integer(item.retryBaseMs), retryMaxMs: integer(item.retryMaxMs),
    scoreMin: integer(item.scoreMin), scoreMax: integer(item.scoreMax), l2Threshold: integer(item.l2Threshold), l3Threshold: integer(item.l3Threshold) }), promptVersion: item.promptVersion as KnowledgeSpec['promptVersion'] }
}

function refs(value: unknown): MemoryRef[] {
  if (!Array.isArray(value)) throw new MemoryError('corrupt', 'Expected reference list')
  return value.map(knowledgeRef)
}

function levelOf(value: unknown): KnowledgeLevel {
  if (value !== 'L2' && value !== 'L3') throw new MemoryError('corrupt', 'Invalid knowledge level')
  return value
}

/** Queue all current preceding-level versions without dispatching model work.
 * @param store - open project knowledge store.
 * @param project - source owner.
 * @param level - target consolidation level.
 * @param config - resolved settings retained by each task.
 * @param pageSize - positive maximum candidates per page.
 */
export function enqueueCandidates(store: KnowledgeStore, project: ProjectId, level: KnowledgeLevel, config: KnowledgeSpec, pageSize: number): void {
  let after = ''
  for (;;) {
    const records = store.listCandidates(project, level === 'L2' ? 'L1' : 'L2', after, pageSize)
    for (const record of records) store.enqueue(project, level, [record], config)
    if (records.length < pageSize) break
    after = records.at(-1)!.id
  }
  store.enqueueRechecks(project, level, config)
}

/** Internal store; no model tools or user approval adapter are installed by this class. */
export class KnowledgeStore {
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
      const valid = record.level === 'L1' || (record.knowledge.evidence === 'supported' && record.knowledge.sources.every(source => visit(source.ref)))
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

  private current(project: ProjectId, level: KnowledgeLevel): KnowledgeMemory[] {
    this.assertOpen()
    return this.db.prepare("SELECT * FROM knowledge_versions WHERE project = ? AND level = ? AND state = 'active' ORDER BY id").all(project, level).map(row => this.decode(row))
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
      return this.db.prepare('SELECT id, MAX(revision) AS revision FROM l1_memories WHERE project = ? AND id > ? GROUP BY id ORDER BY id LIMIT ?').all(project, after, limit)
        .map(row => this.owned(project, knowledgeRef(row)))
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

  private input(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[]): KnowledgeInput {
    const unique = [...new Map(sources.map(ref => [JSON.stringify(ref), ref])).values()]
    if (unique.length === 0) throw new MemoryError('source', 'Consolidation requires source versions')
    const records = unique.map(ref => this.owned(project, ref))
    if (records.some(record => !this.sourcesCurrent(project, record) || record.level !== (level === 'L2' ? 'L1' : 'L2'))) throw new MemoryError('source', 'Invalid consolidation source level or state')
    const existing = this.current(project, level)
    return { projectId: project, level, sources: records.sort((a, b) => a.id.localeCompare(b.id)), existing, lineage: this.lineage(project, [...records, ...existing]) }
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
      const input = this.input(project, level, sources)
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
    for (const record of this.current(project, level)) {
      if (record.knowledge.sources.every(source => this.sourcesCurrent(project, source.ref))) continue
      const sources = record.knowledge.sources.flatMap((source) => {
        const rows = this.db.prepare(`SELECT id,revision FROM l1_memories WHERE project = ? AND id = ?
          UNION ALL SELECT id,revision FROM knowledge_versions WHERE project = ? AND id = ? AND state = 'active'
          ORDER BY revision DESC LIMIT 1`).all(project, source.ref.id, project, source.ref.id)
        if (rows.length === 0) return []
        const current = this.owned(project, knowledgeRef(rows[0]))
        return current.level === (level === 'L2' ? 'L1' : 'L2') && this.sourcesCurrent(project, current) ? [current] : []
      })
      if (sources.length > 0) this.enqueue(project, level, sources, config, { id: record.id, revision: record.revision })
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
      const input = task.candidates === null ? this.input(project, task.input.level, task.input.sources) : task.input
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
      const fresh = this.input(project, task.input.level, task.input.sources)
      if (!isDeepStrictEqual(fresh.existing.map(({ id, revision }) => ({ id, revision })), task.input.existing.map(({ id, revision }) => ({ id, revision })))) throw new MemoryError('conflict', 'Knowledge revisions changed')
      const result: MemoryRef[] = []
      for (const candidate of task.candidates) {
        if (candidate.action === 'skip') continue
        const threshold = task.input.level === 'L2' ? task.config.l2Threshold : task.config.l3Threshold
        if (candidate.knowledge.evidence !== 'conflict' && (candidate.knowledge.score < threshold || candidate.knowledge.category === 'temporary')) continue
        const key = knowledgeKey(candidate.knowledge)
        const duplicate = this.current(project, task.input.level).find(record => knowledgeKey(record.knowledge) === key)
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
      if (failure === 'conflict') { input = this.input(project, task.input.level, task.input.sources); candidates = null }
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
