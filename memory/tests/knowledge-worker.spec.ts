/** Recorded LLM requests and durable worker failure handling using the Harness LLM service. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { KnowledgeExtractor } from '../src/knowledge-extractor.ts'
import { KnowledgeWorker } from '../src/knowledge-worker.ts'
import { L1ModelError } from '../src/l1-extractor.ts'
import type { L1Request } from '../src/l1-extractor.ts'
import { MemoryError } from '../src/types.ts'
import { knowledgeFixture, knowledgeCandidate, commitKnowledge } from './knowledge-fixtures.ts'
import type { KnowledgeConfig, KnowledgeSpec } from '../src/knowledge-types.ts'
import type { MemoryRef, OperationId } from '../src/l1-types.ts'
import { resolveL1Config } from '../src/l1-config.ts'
import { candidate, turnEvents } from './l1-fixtures.ts'
import { header } from './helpers.ts'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { json, object } from '../src/l1-validation.ts'

function requestInput(request: L1Request): Record<string, unknown> {
  const block = request.messages[0]?.content[0]
  if (block?.type !== 'text') throw new Error('Expected a recorded text input')
  return object(json(block.text))
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
class Adapter extends LlmAdapter {
  constructor(private readonly run: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.run(options) }
}
async function* response(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function setup(overrides: Partial<KnowledgeConfig> = {}, promptVersion: KnowledgeSpec['promptVersion'] = 'knowledge-v2') {
  const item = await knowledgeFixture(overrides)
  cleanups.push(item.close)
  const store = item.provider.knowledge
  const config = { ...item.config, promptVersion }
  const operation = store.enqueue(item.project, 'L2', [item.source], config)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: L1Request[] = []
  const extractor = new KnowledgeExtractor(ctx.llm, async (_task, request, signal) => { signal.throwIfAborted(); records.push(request) }, SessionId('auxiliary'),
    (project, ref) => store.sourcesCurrent(project, ref), async (project, ref, signal) => {
      const page = await item.provider.readRaw({ projectId: project, sessionId: ref.sessionId, from: SessionLogOffset(ref.seq),
        to: SessionLogOffset(ref.seq + 1), limit: 1, signal })
      if (page.events[0] === undefined) throw new MemoryError('source', 'Missing test source event')
      return page.events[0]
    })
  const worker = new KnowledgeWorker(store, extractor)
  cleanups.push(() => worker.close())
  return { ...item, config, store, operation, ctx, extractor, records, worker }
}

async function largeSources(item: Awaited<ReturnType<typeof setup>>, details = 180): Promise<MemoryRef[]> {
  const sources: MemoryRef[] = []
  for (let index = 0; index < 3; index++) {
    const sourceHeader = header(`large-source-${index}`)
    await item.provider.appendRaw({ projectId: item.project, header: sourceHeader, inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
    item.provider.scanTurns(item.project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = item.provider.l1.claim(item.project, sourceHeader.id, 'fixture', 1)!
    const value = candidate(task)
    if (value.kind !== 'memory') throw new Error('Expected source summary')
    item.provider.l1.prepare(item.project, task.operationId, 'fixture', { ...value, summary: { ...value.summary, result: `Result ${index}: ${'source detail '.repeat(details)}` } })
    sources.push(item.provider.l1.commitMemory(item.project, task.operationId, 'fixture', 2)!)
  }
  return sources
}

async function multipleOriginals(item: Awaited<ReturnType<typeof setup>>) {
  const sourceHeader = header('many-original-events')
  // The UI failure cited eleven complete events totaling 69,833 bytes, with no individually oversized event.
  const sizes = [338, 26234, 12287, 22030, 6338, 1417, 130, 77, 109, 797, 76]
  const originals: SessionEvent[] = sizes.map((size, index) => ({ type: 'user/message', seq: SessionSeq(index + 1), time: index + 2,
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: index === 0
      ? 'Project policy: use strict TypeScript and ESM. No implementation or test execution has occurred.'
      : `Reference context ${index}: ${'x'.repeat(size)}` }] }), surfaceOp: 'append' }))
  const events: SessionEvent[] = [turnEvents()[0]!, ...originals,
    { type: 'turn/end', seq: SessionSeq(12), time: 13, data: { turn: 1, reason: { kind: 'completed' } } }]
  await item.provider.appendRaw({ projectId: item.project, header: sourceHeader, inheritedEventCount: SessionLogOffset(0), events })
  item.provider.scanTurns(item.project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
  const task = item.provider.l1.claim(item.project, sourceHeader.id, 'fixture', 1)!
  const value = candidate(task)
  if (value.kind !== 'memory') throw new Error('Expected source summary')
  const refs = originals.map(event => ({ sessionId: sourceHeader.id, seq: event.seq }))
  item.provider.l1.prepare(item.project, task.operationId, 'fixture', { ...value, summary: { ...value.summary,
    goal: 'Record project language and module constraints', result: 'A project policy was stated; no successful execution is claimed.', sources: refs } })
  return { source: item.provider.l1.commitMemory(item.project, task.operationId, 'fixture', 2)!, refs, originals }
}

it('records the frozen exact request before calling the real LLM service and commits once', async () => {
  const item = await setup()
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(options => {
    calls++
    expect(item.records).toHaveLength(1)
    expect(options.messages).toEqual(item.records[0]?.messages)
    expect(Object.isFrozen(item.records[0]?.messages)).toBe(true)
    expect(options.sessionId).toBe('auxiliary')
    expect(options.system).toContain('input.lineage is ancestry evidence only')
    return response(JSON.stringify([knowledgeCandidate(item.source)]))
  }))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).toBe(1)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'done', calls: 1, attempts: 1 })
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(1)
})

it.each(['L2', 'L3'] as const)('learns four independent %s tasks in four model calls from one queued batch', async (level) => {
  const item = await setup()
  const sources = [item.source]
  for (let index = 1; index < 4; index++) {
    const sourceHeader = header(`batch-${index}`)
    await item.provider.appendRaw({ projectId: item.project, header: sourceHeader, inheritedEventCount: SessionLogOffset(0), events: turnEvents() })
    item.provider.scanTurns(item.project, resolveL1Config({ provider: 'test', model: 'test' }), 10)
    const task = item.provider.l1.claim(item.project, sourceHeader.id, 'fixture', 1)!
    item.provider.l1.prepare(item.project, task.operationId, 'fixture', candidate(task))
    sources.push(item.provider.l1.commitMemory(item.project, task.operationId, 'fixture', 2)!)
  }
  const parents = level === 'L2' ? sources : sources.map((source, index) =>
    commitKnowledge(item, 'L2', [source], [knowledgeCandidate(source, `Parent ${index}`)])[0]!)
  const operations = parents.map(source => item.store.enqueue(item.project, level, [source], item.config))
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter((options) => {
    const task = item.store.getTask(item.project, operations[calls]!)!
    expect(task.input.existing).toHaveLength(calls)
    expect(options.messages).toEqual(item.records[calls]!.messages)
    return response(JSON.stringify([knowledgeCandidate(parents[calls]!, `Independent constraint ${calls++}`)]))
  }))
  for (const operation of operations) await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).toBe(4)
  expect(item.store.listCandidates(item.project, level)).toHaveLength(4)
  for (const operation of operations) expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: 1, attempts: 1 })
})

it.each([false, true])('resumes after unload with one allowed attempt and model dispatched=%s', async (dispatched) => {
  const item = await setup({ maxAttempts: 1 })
  const started = Promise.withResolvers<undefined>()
  const cancelled = new KnowledgeWorker(item.store, { consolidate: async (_task, signal, charge) => {
    const aborted = Promise.withResolvers<undefined>()
    signal.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
    if (dispatched) charge()
    started.resolve(undefined)
    await aborted.promise
    signal.throwIfAborted()
    return []
  } }, () => 10)
  cleanups.push(() => cancelled.close())
  const running = cancelled.run(item.project, item.operation, new AbortController().signal)
  await started.promise
  await cancelled.close()
  await running
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', failure: null, attempts: 0, calls: dispatched ? 1 : 0, nextRetryAt: 10 })
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(JSON.stringify([knowledgeCandidate(item.source)]))))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'done', attempts: 1, calls: dispatched ? 2 : 1 })
})

it('preserves saved legacy prompt settings when reading and executing an existing task', async () => {
  const item = await setup()
  const operation = item.store.enqueue(item.project, 'L2', [item.source], { ...item.config, promptVersion: 'knowledge-v1' })
  const reopened = await item.open()
  expect(reopened.knowledge.getTask(item.project, operation)?.config.promptVersion).toBe('knowledge-v1')
  item.ctx.llm.registerAdapter(['test'], new Adapter(options => {
    expect(options.system).not.toContain('input.lineage is ancestry evidence only')
    return response(JSON.stringify([knowledgeCandidate(item.source)]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(item.store.getTask(item.project, operation)?.status).toBe('done')
  const memory = item.store.listCandidates(item.project, 'L2')[0]
  if (memory === undefined || 'shared' in memory || memory.level === 'L1') throw new Error('expected owned knowledge')
  expect(memory.config.promptVersion).toBe('knowledge-v1')
})

it('records obsolete targets and current sources before dispatching their recheck', async () => {
  const item = await setup()
  const parent = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const obsolete = commitKnowledge(item, 'L3', [parent], [knowledgeCandidate(parent)])[0]!
  const current = commitKnowledge(item, 'L2', [item.source], [
    { ...knowledgeCandidate(item.source, 'Updated project constraint'), target: parent },
  ], 'updated')[0]!
  item.store.enqueueRechecks(item.project, 'L3', item.config)
  const task = item.store.listTasks(item.project).find(task => task.status === 'pending' && task.input.level === 'L3')!
  const recorded: L1Request[] = []
  const extractor = new KnowledgeExtractor(item.ctx.llm, async (_task, request) => { recorded.push(request) },
    SessionId('auxiliary'), (project, ref) => item.store.sourcesCurrent(project, ref))
  const worker = new KnowledgeWorker(item.store, extractor)
  cleanups.push(() => worker.close())
  const called = vi.fn((options: GenerateOptions) => {
    expect(recorded).toHaveLength(1)
    expect(options.messages).toEqual(recorded[0]!.messages)
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('Expected recorded recheck text')
    const payload: unknown = JSON.parse(block.text)
    expect(payload).toMatchObject({
      input: { sources: [current], existing: [obsolete] },
      recheck: { outdated: [obsolete], instruction: expect.stringContaining('Do not use outdated text as supporting evidence') },
    })
    return response(JSON.stringify([{ ...knowledgeCandidate(current, 'Updated stable constraint'), target: obsolete }]))
  })
  item.ctx.llm.registerAdapter(['test'], new Adapter(called))
  await worker.run(item.project, task.operationId, new AbortController().signal)
  expect(called).toHaveBeenCalledTimes(1)
  expect(item.store.getTask(item.project, task.operationId)).toMatchObject({ status: 'done', calls: 1 })
  expect(item.store.listCandidates(item.project, 'L3')).toMatchObject([{ id: obsolete.id, revision: 2 }])
  expect(item.store.sourcesCurrent(item.project, { id: obsolete.id, revision: 2 })).toBe(true)
})

it('rejects model results when a source is invalidated during extraction', async () => {
  const item = await setup()
  const parent = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const operation = item.store.enqueue(item.project, 'L3', [parent], item.config)
  const called = vi.fn(() => {
    item.store.invalidateMemory(item.project, parent, 'Constraint withdrawn', 'during-extraction' as OperationId)
    return response(JSON.stringify([knowledgeCandidate(parent)]))
  })
  item.ctx.llm.registerAdapter(['test'], new Adapter(called))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(called).toHaveBeenCalledTimes(1)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'failed', failure: 'source', calls: 1 })
  expect(item.store.browse(item.project, 'L3', '', 10, '')).toEqual([])
  expect(item.store.getMemory(item.project, parent)).toMatchObject({ state: 'invalidated' })
})

it('schedules pending work and a durable retry without a manual run', async () => {
  const item = await setup({ retryBaseMs: 1000, retryMaxMs: 1000 })
  vi.useFakeTimers()
  vi.setSystemTime(10)
  let calls = 0
  const reports: unknown[] = []
  const worker = new KnowledgeWorker(item.store, { consolidate: async () => {
    calls++
    if (calls === 1) throw new L1ModelError('TRANSIENT', true)
    return [knowledgeCandidate(item.source)]
  } })
  cleanups.push(() => worker.close())
  worker.watch(item.project, error => { reports.push(error) })
  await vi.advanceTimersByTimeAsync(1)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', nextRetryAt: 1011 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'done', attempts: 2 })
  expect(calls).toBe(2)
  expect(reports).toEqual([])
})

it.each(['not JSON', '{}', '[{"approved":true}]'])('rejects invalid output %s without publishing knowledge', async text => {
  const item = await setup()
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(text)))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', failure: 'output' })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})

it('does not call the model when request recording fails', async () => {
  const item = await setup()
  const called = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(called))
  const extractor = new KnowledgeExtractor(item.ctx.llm, async () => { throw new MemoryError('integration', 'Recorder unavailable') }, SessionId('auxiliary'))
  const worker = new KnowledgeWorker(item.store, extractor)
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(called).not.toHaveBeenCalled()
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'integration' })
})

it('rejects oversized complete input before recording or dispatch', async () => {
  const item = await setup({ maxInputBytes: 10 })
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.records).toEqual([])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'budget' })
})

it.each([{ level: 'L2', version: 'knowledge-v3' }, { level: 'L3', version: 'knowledge-v2' }] as const)('bounds existing context and resumes a previously budget-failed task after 80 $level versions with $version', async ({ level, version }) => {
  const item = await setup({}, version)
  const source = level === 'L2' ? item.source : commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Current parent')])[0]!
  const operation = level === 'L2' ? item.operation : item.store.enqueue(item.project, level, [source], item.config)
  const candidates = Array.from({ length: 80 }, (_, index) => knowledgeCandidate(source, `Constraint ${index}: ${'stored knowledge '.repeat(90)}`))
  commitKnowledge(item, level, [source], candidates, 'seed-80')
  const full = item.store.claim(item.project, operation, 'old-worker', 0)!
  expect(Buffer.byteLength(JSON.stringify(full.input))).toBeGreaterThan(120 * 1024)
  item.store.fail(item.project, operation, 'old-worker', 'budget', false, 0)
  item.store.retry(item.project, operation)
  const calls = vi.fn(() => response(requestInput(item.records.at(-1)!).stage === 'visualize'
    ? JSON.stringify({ description: 'A new constraint after existing knowledge grows.' })
    : JSON.stringify([knowledgeCandidate(source, 'A new constraint after growth')])))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await item.worker.run(item.project, operation, new AbortController().signal)
  const expectedCalls = version === 'knowledge-v3' ? 2 : 1
  expect(calls).toHaveBeenCalledTimes(expectedCalls)
  const recorded = item.records[0]!
  const selection = object(requestInput(recorded).selection)
  expect(selection.existingAvailable).toBe(80)
  expect(selection.existingOmitted).toBeGreaterThan(0)
  const text = recorded.messages[0]!.content[0]!
  if (text.type !== 'text') throw new Error('Expected text input')
  expect(Buffer.byteLength(recorded.system ?? '') + Buffer.byteLength(text.text)).toBeLessThanOrEqual(item.config.maxInputBytes)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: expectedCalls })
  expect(item.store.listCandidates(item.project, level)).toHaveLength(81)
})

it('verifies eleven whole original events exceeding 64 KiB through L2 and L3 before atomic merge and description', async () => {
  const item = await setup({}, 'knowledge-v3')
  const many = await multipleOriginals(item)
  expect(Buffer.byteLength(JSON.stringify(many.originals))).toBeGreaterThan(65536)
  expect(many.originals.every(event => Buffer.byteLength(JSON.stringify(event)) < 65536)).toBe(true)
  const observed = new Map<string, SessionEvent[]>()
  let operation = item.store.enqueue(item.project, 'L2', [many.source], item.config)
  let parent: MemoryRef = many.source
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const request = item.records.at(-1)!
    const payload = requestInput(request)
    const block = request.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('Expected recorded text')
    expect(Buffer.byteLength(request.system ?? '') + Buffer.byteLength(block.text)).toBeLessThanOrEqual(65536)
    expect(item.store.getTask(item.project, operation)?.result).toBeNull()
    if (payload.stage === 'visualize') return response(JSON.stringify({ description: 'The project requires strict TypeScript and ESM.' }))
    if (payload.stage === 'merge-evidence') {
      expect(payload.evidence).toBeUndefined()
      expect(request.system).toContain('do not derive additional facts or stronger confidence')
      return response(JSON.stringify([knowledgeCandidate(parent, 'Use strict TypeScript and ESM')]))
    }
    expect(request.system).toContain('memory summaries cannot fill gaps in unseen original events')
    const evidence = payload.evidence
    if (!Array.isArray(evidence)) throw new Error('Expected original-event group')
    const task = item.store.getTask(item.project, operation)!
    const events = evidence.map(value => object(value).event as SessionEvent)
    for (const event of events) expect(event).toEqual(many.originals.find(original => original.seq === event.seq))
    observed.set(task.input.level, [...observed.get(task.input.level) ?? [], ...events])
    return response(JSON.stringify(events.some(event => JSON.stringify(event).includes('strict TypeScript'))
      ? [knowledgeCandidate(parent, 'Use strict TypeScript and ESM')] : []))
  }))
  for (const level of ['L2', 'L3'] as const) {
    if (level === 'L3') operation = item.store.enqueue(item.project, level, [parent], item.config)
    await item.worker.run(item.project, operation, new AbortController().signal)
    const task = item.store.getTask(item.project, operation)!
    expect(task.status).toBe('done')
    expect(task.calls).toBeGreaterThanOrEqual(4)
    expect(observed.get(level)).toEqual(many.originals)
    parent = task.result![0]!
    const reopened = await item.open()
    expect(reopened.knowledge.getMemory(item.project, parent)).toMatchObject({ knowledge: {
      description: 'The project requires strict TypeScript and ESM.', examinedEvents: many.refs,
      sources: [{ kind: 'memory', ref: { id: task.input.sources[0]!.id, revision: task.input.sources[0]!.revision } }] } })
  }
})

it('does not publish inspected evidence when a later original-event group fails', async () => {
  const item = await setup({}, 'knowledge-v3')
  const many = await multipleOriginals(item)
  const operation = item.store.enqueue(item.project, 'L2', [many.source], item.config)
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(++calls === 1 ? JSON.stringify([knowledgeCandidate(many.source)]) : 'invalid JSON')))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).toBe(2)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'failed', failure: 'output', candidates: null, result: null })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})

it('merges checked candidates in bounded stages when their combined content exceeds 64 KiB', async () => {
  const item = await setup({}, 'knowledge-v3')
  const many = await multipleOriginals(item)
  const operation = item.store.enqueue(item.project, 'L2', [many.source], item.config)
  let verifications = 0
  let merges = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const request = item.records.at(-1)!
    const payload = requestInput(request)
    const block = request.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('Expected text input')
    expect(Buffer.byteLength(request.system ?? '') + Buffer.byteLength(block.text)).toBeLessThanOrEqual(65536)
    if (payload.stage === 'visualize') return response(JSON.stringify({ description: 'The project uses strict TypeScript.' }))
    if (payload.stage === 'merge-evidence') {
      merges++
      expect(JSON.stringify(payload)).not.toContain('examinedEvents')
      return response(JSON.stringify([knowledgeCandidate(many.source, 'A merged TypeScript constraint')]))
    }
    verifications++
    return response(JSON.stringify(Array.from({ length: 3 }, (_, index) => knowledgeCandidate(many.source,
      `Group ${verifications} candidate ${index}: ${'checked detail '.repeat(1500)}`))))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(verifications).toBeGreaterThan(1)
  expect(merges).toBeGreaterThan(1)
  const task = item.store.getTask(item.project, operation)!
  expect(task.status).toBe('done')
  expect(task.calls).toBe(verifications + merges + 1)
  expect(item.store.getMemory(item.project, task.result![0]!)).toMatchObject({ knowledge: { examinedEvents: many.refs } })
})

it('projects direct content after a long active ancestry exceeds the input budget', async () => {
  const item = await setup({}, 'knowledge-v3')
  let parent: MemoryRef | undefined
  for (let index = 0; index < 18; index++) {
    const value = knowledgeCandidate(item.source, `Constraint ${index}: ${'long recorded constraint '.repeat(220)}`)
    parent = commitKnowledge(item, 'L2', [item.source], [{ ...value, knowledge: { ...value.knowledge,
      sources: [...value.knowledge.sources, ...parent === undefined ? [] : [{ kind: 'memory' as const, ref: parent }]] } }], `active-chain-${index}`)[0]!
  }
  const operation = item.store.enqueue(item.project, 'L3', [parent!], item.config)
  const queued = item.store.getTask(item.project, operation)!
  expect(Buffer.byteLength(JSON.stringify(queued.input.lineage))).toBeGreaterThan(65536)
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const payload = requestInput(item.records.at(-1)!)
    if (payload.stage === 'visualize') return response(JSON.stringify({ description: 'The project uses strict TypeScript.' }))
    expect(object(payload.input).lineage).toEqual([])
    expect(object(payload.input).lineageOmitted).toBe(18)
    expect(payload.evidence).toHaveLength(1)
    return response(JSON.stringify([knowledgeCandidate(parent!)]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: 2 })
})

it('rejects model-owned examined-event metadata even when it names a supplied original event', async () => {
  const item = await setup({}, 'knowledge-v3')
  const value = knowledgeCandidate(item.source)
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(JSON.stringify([{ ...value, knowledge: { ...value.knowledge,
    examinedEvents: [{ sessionId: header().id, seq: 1 }] } }]))))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', failure: 'output', calls: 1 })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})

it('retains only current ancestry inspection records when a recheck drops an invalidated parent', async () => {
  const item = await setup({}, 'knowledge-v3')
  const oldParent = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const target = commitKnowledge(item, 'L3', [oldParent], [knowledgeCandidate(oldParent)])[0]!
  item.store.invalidateMemory(item.project, oldParent, 'Constraint withdrawn', 'drop-old-parent' as OperationId)
  const source = (await largeSources(item, 1))[0]!
  const current = commitKnowledge(item, 'L2', [source], [knowledgeCandidate(source, 'Current project constraint')], 'current-parent')[0]!
  const operation = item.store.enqueue(item.project, 'L3', [current], item.config, target)
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const payload = requestInput(item.records.at(-1)!)
    if (payload.stage === 'visualize') return response(JSON.stringify({ description: 'The current source confirms a TypeScript constraint.' }))
    expect(payload.evidence).toHaveLength(2)
    const value = knowledgeCandidate(current)
    return response(JSON.stringify([{ ...value, target, knowledge: { ...value.knowledge,
      sources: [...value.knowledge.sources, { kind: 'memory', ref: target }] } }]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  const task = item.store.getTask(item.project, operation)!
  expect(task).toMatchObject({ status: 'done', calls: 2 })
  const updated = task.result![0]!
  const original = item.store.getMemory(item.project, source)
  if (original === null || original.level !== 'L1') throw new Error('Expected source summary')
  const reopened = await item.open()
  expect(reopened.knowledge.getMemory(item.project, updated)).toMatchObject({ knowledge: { examinedEvents: original.summary.sources,
    sources: [{ kind: 'memory', ref: current }] } })
})

it.each(['L2', 'L3'] as const)('records original L0 evidence before extracting and describing %s', async level => {
  const item = await setup({}, 'knowledge-v3')
  const source = level === 'L2' ? item.source : commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source)])[0]!
  const operation = level === 'L2' ? item.operation : item.store.enqueue(item.project, level, [source], item.config)
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(options => {
    const recorded = item.records.at(-1)!
    expect(recorded.messages).toEqual(options.messages)
    const input = requestInput(recorded)
    calls++
    if (input.stage === 'visualize') {
      expect(input.content).toContain('Use strict TypeScript')
      expect(input.content).not.toContain('"event"')
      return response(JSON.stringify({ description: 'A stable TypeScript constraint supported by the recorded source.' }))
    }
    expect(input.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: expect.objectContaining({ sessionId: header().id }),
      event: expect.objectContaining({ type: 'user/message' }) })]))
    expect(recorded.system).toContain('original evidence.event')
    return response(JSON.stringify([knowledgeCandidate(source)]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).toBe(2)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: 2,
    candidates: [{ knowledge: { description: 'A stable TypeScript constraint supported by the recorded source.' } }] })
  const reopened = await item.open()
  expect(reopened.knowledge.listCandidates(item.project, level).at(-1)).toMatchObject({ knowledge: { description: expect.any(String) } })
})

it('groups complete preceding-level sources without publishing a partial batch', async () => {
  const item = await setup({ maxInputBytes: 6500 })
  const sources = await largeSources(item)
  const operation = item.store.enqueue(item.project, 'L2', sources, item.config)
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
    const input = object(requestInput(item.records.at(-1)!).input)
    if (!Array.isArray(input.sources) || input.sources.length !== 1) throw new Error('Expected one complete source per batch')
    const source = object(input.sources[0])
    const ref = sources.find(ref => ref.id === source.id)!
    return response(JSON.stringify([knowledgeCandidate(ref, `Independent result ${calls++}`)]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).toBe(3)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: 3 })
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(3)
})

it.each(['knowledge-v2', 'knowledge-v3'] as const)('reconciles repeated merge targets across source groups before one atomic %s publication', async version => {
  const item = await setup({ maxInputBytes: 10000 }, version)
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Original constraint')])[0]!
  const sources = await largeSources(item, 240)
  const operation = item.store.enqueue(item.project, 'L2', sources, item.config)
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const payload = requestInput(item.records.at(-1)!)
    calls++
    if (payload.stage === 'visualize') return response(JSON.stringify({ description: 'Three source details form one recorded constraint.' }))
    const input = object(payload.input)
    const batch = input.sources
    if (!Array.isArray(batch)) throw new Error('Expected supplied sources')
    expect(item.store.getMemory(item.project, target)).toMatchObject({ state: 'active', revision: 1 })
    if (payload.stage === 'merge-target') {
      expect(payload.variants).toHaveLength(3)
      if (version === 'knowledge-v3') expect(payload.evidence).toHaveLength(4)
      return response(JSON.stringify([{ ...knowledgeCandidate(sources[0]!, 'All three supported details'), target,
        knowledge: { ...knowledgeCandidate(sources[0]!, 'All three supported details').knowledge,
          sources: sources.map(ref => ({ kind: 'memory', ref })) } }]))
    }
    expect(batch).toHaveLength(1)
    const source = sources.find(ref => ref.id === object(batch[0]).id)!
    return response(JSON.stringify([{ ...knowledgeCandidate(source, `Source detail ${calls}`), target }]))
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  const expectedCalls = version === 'knowledge-v3' ? 5 : 4
  expect(calls).toBe(expectedCalls)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'done', calls: expectedCalls, result: [{ id: target.id, revision: 2 }] })
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(1)
  expect(item.store.getMemory(item.project, { id: target.id, revision: 2 })).toMatchObject({ knowledge: { body: 'All three supported details' } })
})

it('rejects a recheck whose exact target was replaced before dispatch', async () => {
  const item = await setup()
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'Original constraint')], 'original-target')[0]!
  const operation = item.store.enqueue(item.project, 'L2', [item.source], item.config, target)
  const replacement = commitKnowledge(item, 'L2', [item.source], [{ ...knowledgeCandidate(item.source, 'Updated constraint'), target }], 'replacement-target')[0]!
  const calls = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).not.toHaveBeenCalled()
  expect(item.store.getTask(item.project, operation)).toMatchObject({ recheck: target, status: 'failed', failure: 'TARGET_CHANGED', calls: 0 })
  expect(item.store.getMemory(item.project, replacement)).toMatchObject({ state: 'active', revision: 2 })
})

it('fails an oversized mandatory recheck target instead of silently omitting it', async () => {
  const item = await setup({ maxInputBytes: 6500 })
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'old detail '.repeat(1000))])[0]!
  const operation = item.store.enqueue(item.project, 'L2', [item.source], item.config, target)
  const calls = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).not.toHaveBeenCalled()
  expect(item.store.getTask(item.project, operation)).toMatchObject({ recheck: target, status: 'failed', calls: 0, failure: 'budget' })
  expect(item.store.getMemory(item.project, target)).toMatchObject({ state: 'active', revision: 1 })
})

it.each([1, 2])('reserves complete description capacity with a %s-call v3 budget', async maxCalls => {
  const item = await setup({ maxCalls }, 'knowledge-v3')
  const calls = vi.fn(() => response(JSON.stringify([knowledgeCandidate(item.source, 'Constraint one'), knowledgeCandidate(item.source, 'Constraint two')])))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).toHaveBeenCalledTimes(maxCalls - 1)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: maxCalls - 1, failure: 'budget' })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
  expect(item.records.every(request => requestInput(request).stage !== 'visualize')).toBe(true)
})

it('rejects an oversized original L0 event before recording any partial evidence', async () => {
  const item = await setup({ maxInputBytes: 6500 }, 'knowledge-v3')
  const original = turnEvents({ kind: 'completed' }, 'original evidence '.repeat(1000))[1]!
  const extractor = new KnowledgeExtractor(item.ctx.llm, async (_task, request) => { item.records.push(request) }, SessionId('auxiliary'), undefined,
    async () => original)
  const worker = new KnowledgeWorker(item.store, extractor)
  cleanups.push(() => worker.close())
  const calls = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).not.toHaveBeenCalled()
  expect(item.records).toEqual([])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'budget' })
})

it('refuses mismatched original evidence instead of using an ancestor summary', async () => {
  const item = await setup({}, 'knowledge-v3')
  const extractor = new KnowledgeExtractor(item.ctx.llm, async (_task, request) => { item.records.push(request) }, SessionId('auxiliary'), undefined,
    async () => turnEvents()[0]!)
  const worker = new KnowledgeWorker(item.store, extractor)
  cleanups.push(() => worker.close())
  const calls = vi.fn(() => response('[]'))
  item.ctx.llm.registerAdapter(['test'], new Adapter(calls))
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).not.toHaveBeenCalled()
  expect(item.records).toEqual([])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 0, failure: 'source' })
})

it('keeps validated extraction private when its separate display description fails', async () => {
  const item = await setup({}, 'knowledge-v3')
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => response(++calls === 1 ? JSON.stringify([knowledgeCandidate(item.source)]) : '{}')))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(calls).toBe(2)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 2, failure: 'output', candidates: null })
  expect(item.store.browse(item.project, 'L2', '', 10, '')).toEqual([])
})

it('publishes no source groups when a later model batch fails', async () => {
  const item = await setup({ maxInputBytes: 6500 })
  const sources = await largeSources(item)
  const operation = item.store.enqueue(item.project, 'L2', sources, item.config)
  let calls = 0
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    const batch = object(requestInput(item.records.at(-1)!).input).sources
    if (!Array.isArray(batch)) throw new Error('Expected supplied sources')
    const source = sources.find(ref => ref.id === object(batch[0]).id)!
    return response(++calls === 1 ? JSON.stringify([knowledgeCandidate(source)]) : 'invalid JSON')
  }))
  await item.worker.run(item.project, operation, new AbortController().signal)
  expect(calls).toBe(2)
  expect(item.store.getTask(item.project, operation)).toMatchObject({ status: 'failed', calls: 2, failure: 'output', candidates: null })
  expect(item.store.browse(item.project, 'L2', '', 10, '')).toEqual([])
})

it('rejects a merge target excluded from the bounded model input', async () => {
  const item = await setup({ maxInputBytes: 6500 })
  const target = commitKnowledge(item, 'L2', [item.source], [knowledgeCandidate(item.source, 'large existing record '.repeat(1000))], 'oversized-seed')[0]!
  item.ctx.llm.registerAdapter(['test'], new Adapter(() => {
    expect(object(requestInput(item.records.at(-1)!).input).existing).toEqual([])
    return response(JSON.stringify([{ ...knowledgeCandidate(item.source, 'A forged replacement of omitted context'), target }]))
  }))
  await item.worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 1, failure: 'output' })
  expect(item.store.getMemory(item.project, target)).toMatchObject({ state: 'active', revision: 1 })
})

it('preserves a prepared candidate on storage failure and retries without another model call', async () => {
  const item = await setup()
  let now = 10
  const generate = vi.fn(async () => [knowledgeCandidate(item.source)])
  const worker = new KnowledgeWorker(item.store, { consolidate: generate }, () => now)
  cleanups.push(() => worker.close())
  const original = item.store.commit.bind(item.store)
  vi.spyOn(item.store, 'commit').mockImplementationOnce(() => { throw new MemoryError('storage', 'Unavailable') }).mockImplementation(original)
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', candidates: [knowledgeCandidate(item.source)] })
  now = 1011
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(item.store.getTask(item.project, item.operation)?.status).toBe('done')
})

it('renews a multi-step task lease at dispatch without extending idle crash recovery to the whole call budget', async () => {
  const item = await setup()
  let now = 100
  const worker = new KnowledgeWorker(item.store, { consolidate: async (_task, _signal, charge) => {
    charge()
    const first = item.store.getTask(item.project, item.operation)!
    expect(first.leaseUntil).toBe(100 + item.config.timeoutMs + item.config.retryMaxMs)
    now = first.leaseUntil - 1
    charge()
    const renewed = item.store.getTask(item.project, item.operation)!
    expect(renewed.leaseUntil).toBe(now + item.config.timeoutMs + item.config.retryMaxMs)
    expect(item.store.claim(item.project, item.operation, 'competing-worker', first.leaseUntil + 1)).toBeNull()
    return [knowledgeCandidate(item.source)]
  } }, () => now)
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'done', calls: 2, leaseUntil: 0 })
})

it('recognizes a successful commit even when its acknowledgement fails', async () => {
  const item = await setup()
  const original = item.store.commit.bind(item.store)
  vi.spyOn(item.store, 'commit').mockImplementation((...args) => { original(...args); throw new MemoryError('storage', 'Acknowledgement lost') })
  const worker = new KnowledgeWorker(item.store, { consolidate: async () => [knowledgeCandidate(item.source)] })
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)?.status).toBe('done')
  expect(item.store.listCandidates(item.project, 'L2')).toHaveLength(1)
})

it('honors backoff and lifetime call budgets across explicit retries', async () => {
  const item = await setup({ maxAttempts: 1, maxCalls: 1 })
  let now = 10
  const worker = new KnowledgeWorker(item.store, { consolidate: async (_task, _signal, charge) => { charge(); throw new L1ModelError('TRANSIENT', true) } }, () => now)
  cleanups.push(() => worker.close())
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 1 })
  item.store.retry(item.project, item.operation)
  now = 1011
  await worker.run(item.project, item.operation, new AbortController().signal)
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'failed', calls: 1, failure: 'budget' })
})

it('cancels in-flight work and waits for settlement without committing a late candidate', async () => {
  const item = await setup()
  const started = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const worker = new KnowledgeWorker(item.store, { consolidate: async (_task, signal) => {
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    await settled.promise
    return [knowledgeCandidate(item.source)]
  } })
  cleanups.push(async () => { settled.resolve(); await worker.close() })
  const run = worker.run(item.project, item.operation, new AbortController().signal)
  await started.promise
  let closed = false
  const closing = worker.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  settled.resolve()
  await Promise.all([run, closing])
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', candidates: null })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
  await expect(worker.run(item.project, item.operation, new AbortController().signal)).rejects.toMatchObject({ code: 'closed' })
})

it('classifies a model deadline as retryable and does not publish partial output', async () => {
  const item = await setup({ timeoutMs: 20 })
  vi.useFakeTimers()
  const started = Promise.withResolvers<void>()
  item.ctx.llm.registerAdapter(['test'], new Adapter(async function* (options) {
    const aborted = Promise.withResolvers<void>()
    options.signal!.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    options.signal!.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const run = item.worker.run(item.project, item.operation, new AbortController().signal)
  await started.promise
  await vi.advanceTimersByTimeAsync(21)
  await run
  expect(item.store.getTask(item.project, item.operation)).toMatchObject({ status: 'retry', failure: 'MEMORY_KNOWLEDGE_TIMEOUT' })
  expect(item.store.listCandidates(item.project, 'L2')).toEqual([])
})
