/** Durable request guards and result-commit failure preserve recoverable extraction work. */
import { expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { MemoryRequestJournal } from '../src/request-journal.ts'
import { L1Extractor } from '../src/l1-extractor.ts'
import { L1Worker } from '../src/l1-worker.ts'
import type { L1Request } from '../src/l1-extractor.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import type { ProjectId } from '../src/types.ts'
import { batch, fixture, header } from './helpers.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'

async function* response(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

it('rejects unrecorded or modified calls, accepts the exact recorded call once, and isolates its owner', async () => {
  const item = await fixture()
  try {
    const provider = await item.open()
    await provider.appendRaw(batch(item.spec, turnEvents()))
    provider.scanTurns(item.spec.projectId, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.listTasks(item.spec.projectId, '', 10)[0]!
    const calls = vi.fn(() => response('[]'))
    const journal = new MemoryRequestJournal(provider, { stream: calls })
    const request: L1Request = { provider: 'test', model: 'test', system: 'prompt', messages: [{ role: 'user', content: [{ type: 'text', text: 'source' }] }],
      maxTokens: 100, sessionId: header().id }
    const drain = async (input = request) => { for await (const _chunk of journal.stream(input)) { /* Consume the bounded fixture stream. */ } }
    await expect(drain()).rejects.toThrow('recorded before dispatch')
    await journal.recordL1(task, request, new AbortController().signal)
    await expect(drain({ ...request, system: 'changed' })).rejects.toThrow('changed after recording')
    request.system = 'mutated after commit'
    await expect(drain()).rejects.toThrow('changed after recording')
    request.system = 'prompt'
    expect(calls).not.toHaveBeenCalled()
    await drain()
    expect(calls).toHaveBeenCalledTimes(1)
    await expect(drain()).rejects.toThrow('recorded before dispatch')
    const sessions = provider.listSessions(item.spec.projectId).filter(session => session.header.id !== header().id)
    expect(sessions).toHaveLength(1)
    expect(provider.listSessions('foreign' as ProjectId)).toEqual([])
    const requestSession = sessions[0]!
    const foreign = await provider.readRaw({ projectId: 'foreign' as ProjectId, sessionId: requestSession.header.id,
      from: SessionLogOffset(0), to: requestSession.committedTo, limit: 10 })
    expect(foreign.found).toBe(false)
    expect(foreign.events).toEqual([])
  } finally { await item.close() }
})

it('retains a retryable task and unknown request outcome when the result transaction fails', async () => {
  const item = await fixture()
  let worker: L1Worker | undefined
  try {
    const provider = await item.open()
    const project = item.spec.projectId
    await provider.appendRaw(batch(item.spec, turnEvents()))
    provider.scanTurns(project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = provider.l1.listTasks(project, '', 10)[0]!
    const calls = vi.fn(() => response(JSON.stringify(candidate(task))))
    const journal = new MemoryRequestJournal(provider, { stream: calls })
    worker = new L1Worker(provider, new L1Extractor(journal, journal.recordL1), project, 2, () => {})
    const append = provider.appendRaw.bind(provider)
    const fault = vi.spyOn(provider, 'appendRaw').mockImplementation(request => request.events[0]?.type === 'memory/extraction-result'
      ? Promise.reject(new Error('injected disk failure')) : append(request))
    await worker.flush(task.sessionId)
    fault.mockRestore()
    expect(provider.l1.getTask(project, task.operationId)?.status).toBe('retry')
    expect(provider.l1.byOperation(project, task.operationId)).toBeNull()
    const auxiliary = provider.listSessions(project).find(session => session.header.id !== header().id)!
    expect(auxiliary.committedTo).toBe(1)
    provider.l1.rerun(project, task.operationId, 'retry', task.config)
    await worker.flush(task.sessionId)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(provider.l1.getTask(project, task.operationId)?.status).toBe('done')
    expect(provider.listSessions(project).filter(session => session.header.id !== header().id).map(session => session.committedTo).sort()).toEqual([1, 2])
  } finally { await worker?.close(); await item.close() }
})
