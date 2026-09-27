/** SQLite transactions for knowledge versions, aggregation jobs and exact-version grants. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { l1Key } from './l1-config.ts'
import type { L1Store } from './l1-store.ts'
import { integer, json, object, textValue } from './l1-validation.ts'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import type { MemoryId, MemoryRef, OperationId } from './l1-types.ts'
import type { KnowledgeInput, KnowledgeLevel, KnowledgeMemory, KnowledgeSpec, KnowledgeTask, OwnedMemory, ShareAction, SharedMemory } from './knowledge-types.ts'
import { knowledgeKey, knowledgeRef, parseKnowledge, parseKnowledgeCandidates, resolveKnowledgeConfig } from './knowledge-validation.ts'

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
  if (item.promptVersion !== 'knowledge-v1') throw new MemoryError('corrupt', 'Unsupported knowledge prompt version')
  return resolveKnowledgeConfig({ provider: textValue(item.provider), model: textValue(item.model),
    maxInputBytes: integer(item.maxInputBytes), maxOutputTokens: integer(item.maxOutputTokens), timeoutMs: integer(item.timeoutMs),
    maxCalls: integer(item.maxCalls), maxAttempts: integer(item.maxAttempts), retryBaseMs: integer(item.retryBaseMs), retryMaxMs: integer(item.retryMaxMs),
    scoreMin: integer(item.scoreMin), scoreMax: integer(item.scoreMax), l2Threshold: integer(item.l2Threshold), l3Threshold: integer(item.l3Threshold) })
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
  /** @param db - parent-owned connection.
   * @param l1 - existing L1 reader.
   * @param assertOpen - parent lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly l1: L1Store, private readonly assertOpen: () => void) {}

  private transaction<T>(run: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private decode(value: unknown): KnowledgeMemory {
    const row = object(value)
    const config = storedConfig(json(row.config))
    const state = textValue(row.state)
    if (!['active', 'superseded', 'invalidated'].includes(state)) throw new MemoryError('corrupt', 'Invalid knowledge state')
    return { id: textValue(row.id) as MemoryId, revision: integer(row.revision), projectId: textValue(row.project) as ProjectId,
      operationId: textValue(row.operation_id) as OperationId, level: levelOf(row.level), knowledge: parseKnowledge(json(row.knowledge), config),
      config, createdAt: integer(row.created_at), state: state as KnowledgeMemory['state'] }
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
    if (memory.knowledge.evidence !== 'supported') return null
    return { id: memory.id, revision: memory.revision, projectId: memory.projectId, level: 'L3', shared: true,
      title: memory.knowledge.title, body: memory.knowledge.body }
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
    const rows = this.db.prepare(`SELECT * FROM knowledge_versions v WHERE state = 'active' AND level = ? AND id > ?
      AND (project = ? OR (level = 'L3' AND EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.id = v.id AND g.revision = v.revision))) ORDER BY id`).all(level, after, project)
    return rows.flatMap(row => {
      const memory = this.decode(row)
      if (memory.knowledge.evidence !== 'supported') return []
      const visible = this.getMemory(project, memory)
      return visible === null ? [] : [visible]
    }).slice(0, limit)
  }

  private input(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[]): KnowledgeInput {
    const unique = [...new Map(sources.map(ref => [JSON.stringify(ref), ref])).values()]
    if (unique.length === 0) throw new MemoryError('source', 'Consolidation requires source versions')
    const records = unique.map(ref => this.owned(project, ref))
    if (records.some(record => record.state !== 'active' || record.level !== (level === 'L2' ? 'L1' : 'L2')
      || (level === 'L3' && record.level !== 'L1' && record.knowledge.evidence !== 'supported'))) throw new MemoryError('source', 'Invalid consolidation source level or state')
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

  /** Freeze same-project sources and settings; repeated equivalent enqueue is idempotent.
   * @param project - owning project.
   * @param level - L2 or L3.
   * @param sources - exact previous-level versions.
   * @param config - resolved scoring and model settings.
   * @returns durable task identity.
   */
  enqueue(project: ProjectId, level: KnowledgeLevel, sources: readonly MemoryRef[], config: KnowledgeSpec): OperationId {
    return this.transaction(() => {
      const input = this.input(project, level, sources)
      const operationId = l1Key('knowledge', project, level, input.sources.map(({ id, revision }) => ({ id, revision })), config) as OperationId
      if (this.getTask(project, operationId) !== null) return operationId
      this.save({ operationId, input, config, status: 'pending', attempts: 0, calls: 0, nextRetryAt: 0, failure: null,
        candidates: null, result: null, owner: null, leaseUntil: 0 })
      return operationId
    })
  }

  private save(task: KnowledgeTask): void {
    const input = { ...task.input, lineage: undefined, sources: task.input.sources.map(({ id, revision }) => ({ id, revision })), existing: task.input.existing.map(({ id, revision }) => ({ id, revision })) }
    this.db.prepare('INSERT INTO knowledge_tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(task.operationId, task.input.projectId, JSON.stringify({ ...task, input }))
  }

  /** Read task state and the immutable input contents retained by source versions.
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
    const input: KnowledgeInput = { lineage: this.lineage(project, [...sourceRecords, ...existingRecords]), projectId: project, level: levelOf(rawInput.level), sources: refs(rawInput.sources).map(snapshot),
      existing: refs(rawInput.existing).map(ref => {
        const memory = snapshot(ref)
        if (memory.level === 'L1') throw new MemoryError('corrupt', 'Invalid existing knowledge')
        return memory
      }) }
    const config = storedConfig(item.config)
    const status = textValue(item.status)
    if (!['pending', 'running', 'prepared', 'retry', 'failed', 'done'].includes(status)) throw new MemoryError('corrupt', 'Invalid task status')
    return { operationId: operation, input, config, status: status as KnowledgeTask['status'], attempts: integer(item.attempts), calls: integer(item.calls),
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

  /** Claim one task with a project-wide lease, including across SQLite connections.
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
      if (task.attempts >= task.config.maxAttempts) { this.save({ ...task, status: 'failed', failure: 'ATTEMPTS_EXHAUSTED', owner: null, leaseUntil: 0 }); return null }
      const claimed: KnowledgeTask = { ...task, status: task.candidates === null ? 'running' : 'prepared', attempts: task.attempts + 1,
        owner, leaseUntil: now + task.config.timeoutMs + task.config.retryMaxMs }
      this.save(claimed)
      return claimed
    })
  }

  private held(project: ProjectId, operation: OperationId, owner: string): KnowledgeTask {
    const task = this.getTask(project, operation)
    if (task === null || task.owner !== owner || (task.status !== 'running' && task.status !== 'prepared')) throw new MemoryError('conflict', 'Knowledge worker no longer owns the task')
    return task
  }

  /** Charge a durable model call immediately before dispatch.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   */
  reserveCall(project: ProjectId, operation: OperationId, owner: string): void {
    this.transaction(() => {
      const task = this.held(project, operation, owner)
      if (task.calls >= task.config.maxCalls) throw new MemoryError('budget', 'Knowledge call budget exhausted')
      this.save({ ...task, calls: task.calls + 1 })
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
      const task = this.held(project, operation, owner)
      this.save({ ...task, candidates: parseKnowledgeCandidates(value, task.input, task.config), status: 'prepared' })
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
      const task = this.held(project, operation, owner)
      if (task.candidates === null) throw new MemoryError('conflict', 'Knowledge task is not prepared')
      const fresh = this.input(project, task.input.level, task.input.sources)
      if (!isDeepStrictEqual(fresh.existing.map(({ id, revision }) => ({ id, revision })), task.input.existing.map(({ id, revision }) => ({ id, revision })))) throw new MemoryError('conflict', 'Knowledge revisions changed')
      const result: MemoryRef[] = []
      for (const candidate of task.candidates) {
        const threshold = task.input.level === 'L2' ? task.config.l2Threshold : task.config.l3Threshold
        if (candidate.knowledge.evidence !== 'conflict' && (candidate.knowledge.score < threshold || candidate.knowledge.category === 'temporary')) continue
        const key = knowledgeKey(candidate.knowledge)
        const duplicate = this.current(project, task.input.level).find(record => knowledgeKey(record.knowledge) === key)
        if (candidate.target !== null && duplicate !== undefined && duplicate.id !== candidate.target.id) throw new MemoryError('output', 'Merge target collides with another knowledge identity')
        const target = candidate.target === null ? duplicate : this.owned(project, candidate.target)
        if (target?.level === 'L1') throw new MemoryError('source', 'Cannot replace L1 with knowledge')
        const sources = [...new Map([...(target?.knowledge.sources ?? []), ...candidate.knowledge.sources].map(source => [JSON.stringify(source.ref), source])).values()]
        const knowledge = { ...candidate.knowledge, sources }
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

  private retire(ref: MemoryRef, state: 'superseded' | 'invalidated'): void {
    this.db.prepare('UPDATE knowledge_versions SET state = ? WHERE id = ? AND revision = ?').run(state, ref.id, ref.revision)
    this.db.prepare('DELETE FROM knowledge_grants WHERE id = ? AND revision = ?').run(ref.id, ref.revision)
  }

  /** Preserve candidates on storage failures; discard stale merges on revision conflicts.
   * @param project - owner.
   * @param operation - task.
   * @param owner - lease identity.
   * @param failure - safe diagnostic category, null for cancellation.
   * @param retryable - whether a bounded retry is allowed.
   * @param now - failure timestamp.
   */
  fail(project: ProjectId, operation: OperationId, owner: string, failure: string | null, retryable: boolean, now: number): void {
    this.transaction(() => {
      const task = this.held(project, operation, owner)
      let input = task.input
      let candidates = task.candidates
      if (failure === 'conflict') { input = this.input(project, task.input.level, task.input.sources); candidates = null }
      this.save({ ...task, input, candidates, status: (failure === null || retryable) && task.attempts < task.config.maxAttempts ? 'retry' : 'failed',
        failure, owner: null, leaseUntil: 0, nextRetryAt: now + Math.min(task.config.retryMaxMs, task.config.retryBaseMs * 2 ** (task.attempts - 1)) })
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
      if (memory.level !== 'L3' || (action.action === 'approve' && (memory.state !== 'active' || memory.knowledge.evidence !== 'supported'))) throw new MemoryError('source', 'Only current supported L3 can be approved')
      if (this.db.prepare('SELECT 1 FROM knowledge_share_actions WHERE receipt_id = ?').get(action.receiptId) !== undefined) throw new MemoryError('conflict', 'User receipt already consumed')
      this.db.prepare('INSERT INTO knowledge_share_actions VALUES (?, ?, ?)').run(action.operationId, action.receiptId, JSON.stringify(action))
      if (action.action === 'approve') this.db.prepare('INSERT INTO knowledge_grants VALUES (?, ?, ?) ON CONFLICT(id,revision) DO UPDATE SET action_id = excluded.action_id').run(action.ref.id, action.ref.revision, action.operationId)
      else this.db.prepare('DELETE FROM knowledge_grants WHERE id = ? AND revision = ?').run(action.ref.id, action.ref.revision)
    })
  }
}
