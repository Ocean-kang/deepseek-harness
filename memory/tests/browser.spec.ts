/** Real SQLite browsing, receipt durability and private-source isolation. */
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MemoryBrowser, resolveBrowserConfig } from '../src/browser.ts'
import type { ProjectId, ReadRawRequest } from '../src/types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { OperationId } from '../src/l1-types.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup() {
  const item = await knowledgeFixture()
  cleanup.push(() => item.close())
  return { ...item, browser: new MemoryBrowser(item.provider, resolveBrowserConfig({ pageSize: 1, limit: 2 })) }
}

it('browses every level with stable pages, literal search and owned source detail', async () => {
  const item = await setup()
  const refs = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'ESM one'), knowledgeCandidate(item.source, 'ESM two')])
  const l3 = commitKnowledge(item, 'L3', [refs[0]!], [knowledgeCandidate(refs[0]!, 'Long-term ESM')])[0]!
  const raw = await item.browser.browse(item.project, 'L0')
  expect(raw.items[0]?.level).toBe('L0')
  expect(raw.next).not.toBeNull()
  expect((await item.browser.browse(item.project, 'L0', '', raw.next)).items).not.toEqual(raw.items)
  expect((await item.browser.browse(item.project, 'L0', '%'))).toEqual({ items: [], next: null })
  expect((await item.browser.browse(item.project, 'L1')).items[0]).toMatchObject({ id: item.source.id, summary: { sources: expect.any(Array) } })
  expect((await item.browser.browse(item.project, 'L1', 'no such goal')).items).toEqual([])
  const page = await item.browser.browse(item.project, 'L2', 'esm')
  expect(page.items).toHaveLength(1)
  expect((await item.browser.browse(item.project, 'L2', 'esm', page.next)).items).toHaveLength(1)
  expect((await item.browser.browse(item.project, 'L3')).items[0]).toMatchObject(l3)
  expect((await item.browser.detail(item.project, l3))).toMatchObject({ knowledge: { sources: [{ ref: refs[0] }] } })
  const foreign = 'other' as ProjectId
  for (const level of ['L0', 'L1', 'L2', 'L3'] as const) expect((await item.browser.browse(foreign, level)).items).toEqual([])
})

it('finds failed knowledge extraction beyond the first page of completed or pending tasks', async () => {
  const item = await setup()
  const store = item.provider.knowledge
  const operations = Array.from({ length: 101 }, (_, index) => store.enqueue(item.project, 'L2', [item.source], { ...item.config, model: `failure-list-${index}` }))
  const failed = operations.sort().at(-1)!
  expect(store.claim(item.project, failed, 'failure-list-worker', 10)).not.toBeNull()
  store.fail(item.project, failed, 'failure-list-worker', 'Synthetic permanent failure', false, 10)
  expect(store.listTasks(item.project).some(task => task.status === 'failed')).toBe(false)
  expect(store.getFailedTasks(item.project, 1)).toMatchObject([{ operationId: failed, status: 'failed' }])
  expect(store.getFailedTasks('foreign' as ProjectId, 1)).toEqual([])
})

it('shows owned historical revisions and rejects them for injection after replacement', async () => {
  const item = await setup()
  const old = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'CommonJS')])[0]!
  const current = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'ESM'), target: old }], 'updated')[0]!
  expect((await item.browser.history(item.project, old.id))).toEqual([current])
  expect((await item.browser.history(item.project, old.id, current.revision))).toEqual([old])
  expect((await item.browser.detail(item.project, old))).toMatchObject({ state: 'superseded' })
  await expect(item.browser.manual(item.project, [old])).rejects.toThrow(/changed/)
  await expect(item.browser.manual(item.project, [item.source])).rejects.toThrow(/L2\/L3/)
  expect((await item.browser.history('foreign' as ProjectId, old.id))).toEqual([])
  await expect(item.browser.select('foreign' as ProjectId, header().id, [current], false)).rejects.toThrow()
})

it('persists pending selections and preferences; old receipts cannot consume a newer choice', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const first = await item.browser.select(item.project, header().id, [ref, ref], true)
  const reopened = await item.open()
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [ref], automatic: true })
  const newer = await item.browser.select(item.project, header().id, [ref], false)
  const event = { type: 'user/message' as const, seq: SessionSeq(100), time: 100, surfaceOp: 'append' as const, data: createUserMessage({
    content: [{ type: 'text' as const, text: 'Historical text' }], source: { kind: 'memory-recall' as const, form: 'recall' as const,
      turn: 1, selectionId: first.token, memories: [] },
  }) }
  await item.browser.committed(item.project, header().id, event)
  expect(reopened.selections.get(item.project, header().id)).toEqual(newer)
  await item.browser.committed(item.project, header().id, { ...event, data: { ...event.data, source: { ...event.data.source, selectionId: newer.token } } })
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [], automatic: false })
})

it('recovers a committed receipt from bounded captured pages without copying the loaded Session log', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const session = Session.create(SessionId('paged-selection-recovery'))
  await item.provider.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events: [] })
  const receipt = await item.browser.select(item.project, session.id, [ref], true)
  for (let index = 0; index < 5; index++) session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original user text' }] }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'memory-recall', form: 'recall', turn: 1, selectionId: receipt.token, memories: [] }, content: [{ type: 'text', text: 'Admitted memory' }] }), { surfaceOp: 'append' })
  await item.provider.appendRaw({ projectId: item.project, header: session.header, inheritedEventCount: SessionLogOffset(0), events: session.snapshotEvents() })
  const copied = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('Must not copy a complete loaded log') })
  const reads = vi.spyOn(item.provider, 'readRaw')
  try {
    expect(await item.browser.selection(item.project, session)).toMatchObject({ refs: [], automatic: true })
    expect(copied).not.toHaveBeenCalled()
    expect(reads.mock.calls.slice(1).every(([request]: [ReadRawRequest]) => request.limit === 1)).toBe(true)
    expect(reads.mock.calls.slice(1)).toHaveLength(6)
  } finally { copied.mockRestore(); reads.mockRestore() }
})

it('disables automatic recall with stale selections and retains their original consumption receipt', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const receipt = await item.browser.select(item.project, header().id, [ref], true)
  item.provider.knowledge.invalidateMemory(item.project, ref, 'Withdrawn', 'toggle-invalidated' as OperationId)
  await expect(item.browser.select(item.project, header().id, [ref], false)).rejects.toThrow(/eligible/)
  expect((await item.browser.setAutomatic(item.project, header().id, false))).toEqual({ ...receipt, automatic: false })
  const reopened = await item.open()
  expect(reopened.selections.get(item.project, header().id)).toEqual({ ...receipt, automatic: false })
  reopened.selections.consume(item.project, header().id, receipt.token)
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [], automatic: false })
  await expect(item.browser.setAutomatic('foreign' as ProjectId, header().id, true)).rejects.toThrow(/project/)
})

it('enforces the exact rendered byte budget and leaves prior choices on validation failure', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '多字节正文')])[0]!
  const browser = new MemoryBrowser(item.provider, resolveBrowserConfig({ maxBytes: 1, maxQueryBytes: 1 }))
  await expect(browser.select(item.project, header().id, [ref], false)).rejects.toThrow(/byte budget/)
  expect(item.provider.selections.get(item.project, header().id)).toBeNull()
  await expect(browser.browse(item.project, 'L2', '中文')).rejects.toThrow(/query/)
  await expect(item.browser.browse(item.project, 'L2', '', { level: 'L0', sessionId: header().id, seq: 0 })).rejects.toThrow(/another level/)
})

it('upgrades a version-four database without rewriting existing memory rows', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const before = await item.browser.detail(item.project, ref)
  await item.provider.close()
  const db = new DatabaseSync(item.spec.databasePath)
  try { db.exec('DROP TABLE memory_selections; DROP TABLE memory_imports; DROP TABLE memory_admissions; DROP TABLE memory_cleanup_runs; DROP TABLE l1_trace_chunks; DROP TABLE l1_summary_projections; DROP TABLE l1_candidate_projections; PRAGMA user_version = 4') } finally { db.close() }
  const reopened = await item.open()
  expect(reopened.knowledge.getMemory(item.project, ref)).toEqual(before)
  expect(reopened.selections.get(item.project, header().id)).toBeNull()
})
