/** Version-5 frozen task snapshots are compacted without changing immutable versions or model journals. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SqliteMemory } from '../src/sqlite.ts'
import { knowledgeFixture, knowledgeCandidate } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'
import type { KnowledgeTask } from '../src/knowledge-types.ts'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

it('migrates large legacy task input traces before get, failed-list, claim and prepared resume', async () => {
  const item = await knowledgeFixture()
  resources.push(() => item.close())
  const { provider, project, source, config } = item
  const trace = { actions: [], commands: [], files: ['🧪'.repeat(32768)], errors: [] }
  const legacySource = { ...source, summary: { ...source.summary, trace } }
  const originalSummary = JSON.stringify(legacySource.summary)
  const pendingId = provider.knowledge.enqueue(project, 'L2', [source], { ...config, model: 'legacy-pending' })
  const preparedId = provider.knowledge.enqueue(project, 'L2', [source], { ...config, model: 'legacy-prepared' })
  provider.knowledge.claim(project, preparedId, 'old-owner', 10)
  provider.knowledge.prepare(project, preparedId, 'old-owner', [knowledgeCandidate(source)])
  const failedId = provider.knowledge.enqueue(project, 'L2', [source], { ...config, model: 'legacy-failed' })
  const frozen = (task: KnowledgeTask): KnowledgeTask => ({ ...task,
    input: { ...task.input, sources: [legacySource], lineage: [legacySource] } })
  const originals = new Map([
    [pendingId, frozen(provider.knowledge.getTask(project, pendingId)!)],
    [preparedId, frozen(provider.knowledge.getTask(project, preparedId)!)],
    [failedId, { ...frozen(provider.knowledge.getTask(project, failedId)!), status: 'failed' as const, failure: 'budget' }],
  ])
  const journalHeader = header('legacy-journal')
  const request: SessionEvent<'memory/extraction-request'> = { type: 'memory/extraction-request', ignorable: true,
    seq: SessionSeq(0), time: 20, data: { operationId: preparedId, projectId: project, level: 'L2',
      request: { provider: config.provider, model: config.model, sessionId: SessionId(journalHeader.id), system: 'Recorded legacy request',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ input: originals.get(preparedId)!.input }) }] })],
        maxTokens: 128 } } }
  await provider.appendRaw({ projectId: project, header: journalHeader, inheritedEventCount: SessionLogOffset(0), events: [request] })
  await provider.close()
  const legacy = new DatabaseSync(item.spec.databasePath)
  let journalBody: unknown
  try {
    legacy.prepare('UPDATE l1_memories SET summary = ? WHERE id = ? AND revision = ?').run(originalSummary, source.id, source.revision)
    for (const [id, task] of originals) legacy.prepare('UPDATE knowledge_tasks SET body = ? WHERE id = ?').run(JSON.stringify(task), id)
    journalBody = legacy.prepare('SELECT body FROM events WHERE session_id = ? AND seq = 0').get(journalHeader.id)?.body
    legacy.exec('DROP TABLE l1_trace_chunks; DROP TABLE l1_summary_projections; DROP TABLE l1_candidate_projections; DROP TABLE memory_imports; DROP TABLE memory_admissions; DROP TABLE memory_cleanup_runs; PRAGMA user_version = 5')
  } finally { legacy.close() }
  const memory = await SqliteMemory.open(item.spec)
  resources.push(() => memory.close())
  const migrated = new DatabaseSync(item.spec.databasePath)
  try {
    for (const [id, original] of originals) {
      const row = migrated.prepare('SELECT body FROM knowledge_tasks WHERE id = ?').get(id)!
      expect(typeof row.body).toBe('string')
      expect(Buffer.byteLength(String(row.body))).toBeLessThan(8192)
      const { trace: _trace, ...summary } = legacySource.summary
      const expected = { ...original, input: { ...original.input,
        sources: [{ ...legacySource, summary }], lineage: [{ ...legacySource, summary }] } }
      expect(JSON.parse(String(row.body))).toEqual(expected)
    }
    expect(migrated.prepare('SELECT summary FROM l1_memories WHERE id = ? AND revision = ?').get(source.id, source.revision)?.summary).toBe(originalSummary)
    expect(migrated.prepare('SELECT body FROM events WHERE session_id = ? AND seq = 0').get(journalHeader.id)?.body).toBe(journalBody)
  } finally { migrated.close() }
  expect((await memory.knowledge.getTask(project, pendingId))?.input.sources[0]).toMatchObject({ id: source.id, revision: source.revision })
  expect((await memory.knowledge.getTask(project, pendingId))?.input.sources[0]?.level).toBe('L1')
  expect((await memory.knowledge.listTasks(project)).every(task => task.input.sources.every(record => record.level !== 'L1' || record.summary.trace === undefined))).toBe(true)
  expect((await memory.knowledge.getFailedTasks(project)).map(task => task.operationId)).toEqual([failedId])
  const prepared = await memory.knowledge.claim(project, preparedId, 'resumed', Date.now())
  expect(prepared).toMatchObject({ status: 'prepared', candidates: [knowledgeCandidate(source)] })
  expect((await memory.knowledge.commit(project, preparedId, 'resumed', Date.now())).length).toBe(1)
  const inspect = new DatabaseSync(item.spec.databasePath)
  try { expect(inspect.prepare('SELECT body FROM events WHERE session_id = ? AND seq = 0').get(journalHeader.id)?.body).toBe(journalBody) }
  finally { inspect.close() }
})
