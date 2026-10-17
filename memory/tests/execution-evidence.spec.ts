/** Contradictory durable tool settlements cannot authorize successful execution. */
import { expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { executionSucceeded } from '../src/evidence.ts'
import { EXECUTION_POLICY } from '../src/l1-store.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { batch, fixture, header } from './helpers.ts'
import { turnEvents } from './l1-fixtures.ts'
import { DatabaseSync } from 'node:sqlite'
import { knowledgeFixture } from './knowledge-fixtures.ts'

function settlement(value: unknown): [SessionEvent<'tool/call'>, SessionEvent<'tool/result'>] {
  const callId = ToolCallId('evidence-check')
  return [{ type: 'tool/call', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1, callId, name: 'test_runner', arguments: '{}' } },
    { type: 'tool/result', seq: SessionSeq(3), time: 4, surfaceOp: 'append', data: { turn: 1, step: 1,
      message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }) } }]
}

it.each([
  [{ success: true, exitCode: 1 }, false], [{ success: false, exitCode: 0 }, false],
  [{ success: true }, true], [{ exitCode: 0 }, true], [{ success: true, exitCode: 0 }, true],
  [{ success: 1, exitCode: 0 }, false], [{ success: 'true' }, false], [{ success: null, exitCode: 0 }, false],
  [{ success: true, exitCode: '0' }, false], [{ success: true, exitCode: null }, false],
  [{ exitCode: 0.5 }, false], [{}, false], [[], false], [null, false],
  [{ success: true, timedOut: true }, false], [{ success: true, aborted: true }, false],
  [{ exitCode: 0, signal: 'SIGTERM' }, false], [{ success: true, kind: 'background' }, false],
])('accepts only consistent explicit status %j', (value, success) => {
  expect(executionSucceeded(...settlement(value))).toBe(success)
})

it.each([{ success: true, exitCode: 1 }, { success: false, exitCode: 0 }])('rejects contradictory evidence at the L1 storage admission: %j', async value => {
  const item = await fixture()
  try {
    const provider = await item.open()
    const events = turnEvents()
    await provider.appendRaw(batch(item.spec, [events[0]!, events[1]!, ...settlement(value), { ...events[2]!, seq: SessionSeq(4) }]))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(item.spec.projectId, header().id, 'test', 1)!
    expect(() => provider.l1.prepare(item.spec.projectId, task.operationId, 'test', { kind: 'memory', summary: {
      goal: 'Run test', actions: [], outcome: 'success', result: 'Reported success', solution: 'Test',
      sources: [{ sessionId: task.sessionId, seq: SessionSeq(3) }], executionEvidence: [{ sessionId: task.sessionId, seq: SessionSeq(3) }],
    } })).toThrow('Invalid program-owned execution evidence')
    expect(provider.l1.byOperation(item.spec.projectId, task.operationId)).toBeNull()
  } finally { await item.close() }
})

it('audits historical contradictory successes without rewriting summaries and resumes from saved verdicts', async () => {
  const item = await fixture()
  try {
    const provider = await item.open()
    const events = turnEvents()
    await provider.appendRaw(batch(item.spec, [events[0]!, events[1]!, ...settlement({ success: true, exitCode: 1 }), { ...events[2]!, seq: SessionSeq(4) }]))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(item.spec.projectId, header().id, 'test', 1)!
    provider.l1.prepare(item.spec.projectId, task.operationId, 'test', { kind: 'memory', summary: {
      goal: 'Run test', actions: [], outcome: 'unknown', result: 'No verified success', solution: null,
      sources: [{ sessionId: task.sessionId, seq: SessionSeq(3) }],
    } })
    const memory = provider.l1.commitMemory(item.spec.projectId, task.operationId, 'test', 2)!
    const db = new DatabaseSync(item.spec.databasePath)
    try {
      const old = { ...memory.summary, outcome: 'success', executionEvidence: [{ sessionId: task.sessionId, seq: 3 }] }
      db.prepare('UPDATE l1_memories SET summary=? WHERE id=?').run(JSON.stringify(old), memory.id)
      db.prepare('UPDATE l1_summary_projections SET summary=? WHERE memory_id=?').run(JSON.stringify(old), memory.id)
      expect(provider.l1.executionAudit(item.spec.projectId, memory).status).toBe('pending')
      expect(provider.knowledge.sourcesCurrent(item.spec.projectId, memory)).toBe(false)
      expect(provider.l1.auditEvidencePage(1)).toEqual({ checked: 1, pending: true })
      expect(provider.l1.executionAudit(item.spec.projectId, memory).status).toBe('invalid')
      expect(provider.l1.auditEvidencePage(1)).toEqual({ checked: 0, pending: false })
      expect(provider.l1.getMemory(item.spec.projectId, memory)?.summary).toEqual(old)
      expect(db.prepare('SELECT policy FROM memory_execution_audits WHERE memory_id=?').get(memory.id)?.policy).toBe(EXECUTION_POLICY)
    } finally { db.close() }
    await provider.close()
    const reopened = await item.open()
    expect(reopened.l1.executionAudit(item.spec.projectId, memory).status).toBe('invalid')
  } finally { await item.close() }
})

it('rechecks a previously prepared checkpoint before publishing a success version', async () => {
  const item = await fixture()
  try {
    const provider = await item.open()
    const events = turnEvents()
    await provider.appendRaw(batch(item.spec, [events[0]!, events[1]!, ...settlement({ success: false, exitCode: 0 }), { ...events[2]!, seq: SessionSeq(4) }]))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(item.spec.projectId, header().id, 'test', 1)!
    const stored = { kind: 'memory', summary: { goal: 'Run test', actions: [], outcome: 'success', result: 'Old checkpoint claims success',
      solution: 'Test', sources: [{ sessionId: task.sessionId, seq: 3 }], executionEvidence: [{ sessionId: task.sessionId, seq: 3 }] } }
    const db = new DatabaseSync(item.spec.databasePath)
    try {
      db.prepare("UPDATE l1_tasks SET candidate=?,status='prepared' WHERE id=?").run(JSON.stringify(stored), task.operationId)
    } finally { db.close() }
    expect(() => provider.l1.commitMemory(item.spec.projectId, task.operationId, 'test', 2)).toThrow('Invalid program-owned execution evidence')
    expect(provider.l1.byOperation(item.spec.projectId, task.operationId)).toBeNull()
  } finally { await item.close() }
})

it.each(['missing-result', 'invalid-json', 'invalid-payload', 'missing-call', 'invalid-call-json'])('quarantines unavailable historical evidence after %s while reopening other memories', async defect => {
  const item = await knowledgeFixture()
  try {
    const provider = item.provider
    const session = header('audit-isolation')
    const events = turnEvents()
    await provider.appendRaw({ projectId: item.project, header: session, inheritedEventCount: SessionLogOffset(0),
      events: [events[0]!, events[1]!, ...settlement({ success: true, exitCode: 0 }), { ...events[2]!, seq: SessionSeq(4) }] })
    provider.scanTurns(item.project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.claim(item.project, session.id, 'audit', 1)!
    const evidence = { sessionId: session.id, seq: SessionSeq(3) }
    provider.l1.prepare(item.project, task.operationId, 'audit', { kind: 'memory', summary: {
      goal: 'Run test', actions: [], outcome: 'unknown', result: 'No verified success', solution: null, sources: [evidence],
    } })
    const memory = provider.l1.commitMemory(item.project, task.operationId, 'audit', 2)!
    await provider.close()
    const database = new DatabaseSync(item.spec.databasePath)
    const historical = { ...memory.summary, outcome: 'success', executionEvidence: [evidence] }
    try {
      database.prepare('UPDATE l1_memories SET summary=? WHERE id=?').run(JSON.stringify(historical), memory.id)
      database.prepare('UPDATE l1_summary_projections SET summary=? WHERE memory_id=?').run(JSON.stringify(historical), memory.id)
      if (defect === 'missing-result') database.prepare('DELETE FROM events WHERE session_id=? AND seq=3').run(session.id)
      if (defect === 'invalid-json') database.prepare('UPDATE events SET body=? WHERE session_id=? AND seq=3').run('{', session.id)
      if (defect === 'invalid-payload') database.prepare('UPDATE events SET body=? WHERE session_id=? AND seq=3')
        .run(JSON.stringify({ type: 'tool/result', seq: 3, time: 4, data: { message: null } }), session.id)
      if (defect === 'missing-call') database.prepare('DELETE FROM events WHERE session_id=? AND seq=2').run(session.id)
      if (defect === 'invalid-call-json') database.prepare('UPDATE events SET body=? WHERE session_id=? AND seq=2').run('{', session.id)
    } finally { database.close() }
    const reopened = await item.open()
    expect(reopened.l1.executionAudit(item.project, memory).status).toBe('unavailable')
    expect(reopened.l1.getMemory(item.project, memory)?.summary).toEqual(historical)
    expect(reopened.l1.getMemory(item.project, item.source)).toEqual(item.source)
    expect(reopened.knowledge.sourcesCurrent(item.project, memory)).toBe(false)
  } finally { await item.close() }
})
