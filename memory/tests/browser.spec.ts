/** Real SQLite browsing, receipt durability and private-source isolation. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MemoryBrowser, resolveBrowserConfig } from '../src/browser.ts'
import type { ProjectId } from '../src/types.ts'
import { commitKnowledge, knowledgeCandidate, knowledgeFixture } from './knowledge-fixtures.ts'
import { header } from './helpers.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
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
  const raw = item.browser.browse(item.project, 'L0')
  expect(raw.items[0]?.level).toBe('L0')
  expect(raw.next).not.toBeNull()
  expect(item.browser.browse(item.project, 'L0', '', raw.next).items).not.toEqual(raw.items)
  expect(item.browser.browse(item.project, 'L0', '%')).toEqual({ items: [], next: null })
  expect(item.browser.browse(item.project, 'L1').items[0]).toMatchObject({ id: item.source.id, summary: { sources: expect.any(Array) } })
  expect(item.browser.browse(item.project, 'L1', 'no such goal').items).toEqual([])
  const page = item.browser.browse(item.project, 'L2', 'esm')
  expect(page.items).toHaveLength(1)
  expect(item.browser.browse(item.project, 'L2', 'esm', page.next).items).toHaveLength(1)
  expect(item.browser.browse(item.project, 'L3').items[0]).toMatchObject(l3)
  expect(item.browser.detail(item.project, l3)).toMatchObject({ knowledge: { sources: [{ ref: refs[0] }] } })
  const foreign = 'other' as ProjectId
  for (const level of ['L0', 'L1', 'L2', 'L3'] as const) expect(item.browser.browse(foreign, level).items).toEqual([])
})

it('shows owned historical revisions and rejects them for injection after replacement', async () => {
  const item = await setup()
  const old = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'CommonJS')])[0]!
  const current = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'ESM'), target: old }], 'updated')[0]!
  expect(item.browser.history(item.project, old.id)).toEqual([current])
  expect(item.browser.history(item.project, old.id, current.revision)).toEqual([old])
  expect(item.browser.detail(item.project, old)).toMatchObject({ state: 'superseded' })
  expect(() => item.browser.manual(item.project, [old])).toThrow(/changed/)
  expect(() => item.browser.manual(item.project, [item.source])).toThrow(/L2\/L3/)
  expect(item.browser.history('foreign' as ProjectId, old.id)).toEqual([])
  expect(() => item.browser.select('foreign' as ProjectId, header().id, [current], false)).toThrow()
})

it('persists pending selections and preferences; old receipts cannot consume a newer choice', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const first = item.browser.select(item.project, header().id, [ref, ref], true)
  const reopened = await item.open()
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [ref], automatic: true })
  const newer = item.browser.select(item.project, header().id, [ref], false)
  const event = { type: 'user/message' as const, seq: SessionSeq(100), time: 100, surfaceOp: 'append' as const, data: createUserMessage({
    content: [{ type: 'text' as const, text: 'Historical text' }], source: { kind: 'memory-recall' as const, form: 'recall' as const,
      turn: 1, selectionId: first.token, memories: [] },
  }) }
  item.browser.committed(item.project, header().id, event)
  expect(reopened.selections.get(item.project, header().id)).toEqual(newer)
  item.browser.committed(item.project, header().id, { ...event, data: { ...event.data, source: { ...event.data.source, selectionId: newer.token } } })
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [], automatic: false })
})

it('disables automatic recall with stale selections and retains their original consumption receipt', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const receipt = item.browser.select(item.project, header().id, [ref], true)
  item.provider.knowledge.invalidateMemory(item.project, ref, 'Withdrawn', 'toggle-invalidated' as OperationId)
  expect(() => item.browser.select(item.project, header().id, [ref], false)).toThrow(/eligible/)
  expect(item.browser.setAutomatic(item.project, header().id, false)).toEqual({ ...receipt, automatic: false })
  const reopened = await item.open()
  expect(reopened.selections.get(item.project, header().id)).toEqual({ ...receipt, automatic: false })
  reopened.selections.consume(item.project, header().id, receipt.token)
  expect(reopened.selections.get(item.project, header().id)).toMatchObject({ refs: [], automatic: false })
  expect(() => item.browser.setAutomatic('foreign' as ProjectId, header().id, true)).toThrow(/project/)
})

it('enforces the exact rendered byte budget and leaves prior choices on validation failure', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, '多字节正文')])[0]!
  const browser = new MemoryBrowser(item.provider, resolveBrowserConfig({ maxBytes: 1, maxQueryBytes: 1 }))
  expect(() => browser.select(item.project, header().id, [ref], false)).toThrow(/byte budget/)
  expect(item.provider.selections.get(item.project, header().id)).toBeNull()
  expect(() => browser.browse(item.project, 'L2', '中文')).toThrow(/query/)
  expect(() => item.browser.browse(item.project, 'L2', '', { level: 'L0', sessionId: header().id, seq: 0 })).toThrow(/another level/)
})

it('upgrades a version-four database without rewriting existing memory rows', async () => {
  const item = await setup()
  const ref = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const before = item.browser.detail(item.project, ref)
  await item.provider.close()
  const db = new DatabaseSync(item.spec.databasePath)
  try { db.exec('DROP TABLE memory_selections; PRAGMA user_version = 4') } finally { db.close() }
  const reopened = await item.open()
  expect(reopened.knowledge.getMemory(item.project, ref)).toEqual(before)
  expect(reopened.selections.get(item.project, header().id)).toBeNull()
})
