/** Independent extraction Sessions retain exact requests and stream settlements in L0. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { GenerateOptions, LlmRuntime, StreamChunk, AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { L1Request } from './l1-extractor.ts'
import type { L1Task, OperationId } from './l1-types.ts'
import type { KnowledgeTask } from './knowledge-types.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import type { SqliteMemory } from './sqlite.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact auxiliary call, outside the ordinary agent history; omission does not change that history. */
    'memory/extraction-request': {
      operationId: OperationId
      projectId: ProjectId
      level: 'L1' | 'L2' | 'L3'
      request: L1Request
    }
    /** Settled auxiliary stream; absence after a crash means its outcome is unknown. */
    'memory/extraction-result': {
      operationId: OperationId
      outcome: 'returned' | 'cancelled' | 'threw'
      stream: readonly AssistantStreamRecord[]
    }
  }
}

interface PendingRequest {
  readonly header: SessionHeader
  readonly event: SessionEvent<'memory/extraction-request'>
}

/** Records each call before dispatch; callers keep the provider open until streams settle. */
export class MemoryRequestJournal implements Pick<LlmRuntime, 'stream'> {
  private readonly pending = new WeakMap<L1Request['messages'], PendingRequest>()

  /** @param memory - owning L0 provider.
   * @param llm - existing provider-neutral model service.
   */
  constructor(private readonly memory: SqliteMemory, private readonly llm: Pick<LlmRuntime, 'stream'>) {}

  /** Persist one L1 request in its own auxiliary Session.
   * @param task - immutable source task.
   * @param request - exact request passed to stream.
   * @param signal - request cancellation.
   * @returns completion after the L0 transaction commits.
   */
  recordL1 = (task: L1Task, request: L1Request, signal: AbortSignal): Promise<void> =>
    this.record(task.projectId, task.operationId, 'L1', request, signal)

  /** Persist one knowledge request in its own auxiliary Session.
   * @param task - immutable consolidation task.
   * @param request - exact request passed to stream.
   * @param signal - request cancellation.
   * @returns completion after the L0 transaction commits.
   */
  recordKnowledge = (task: KnowledgeTask, request: L1Request, signal: AbortSignal): Promise<void> =>
    this.record(task.input.projectId, task.operationId, task.input.level, request, signal)

  private async record(project: ProjectId, operation: OperationId, level: 'L1' | 'L2' | 'L3', request: L1Request, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const header: SessionHeader = { id: SessionId(`memory-request-${operation}-${randomUUID()}`),
      version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }
    const event: SessionEvent<'memory/extraction-request'> = { type: 'memory/extraction-request',
      seq: SessionSeq(0), time: header.createdAt, ignorable: true,
      data: { operationId: operation, projectId: project, level, request: deepFreeze(structuredClone(request)) } }
    await this.persist(project, header, [event], signal)
    this.pending.set(request.messages, { header, event })
  }

  private async persist(project: ProjectId, header: SessionHeader, events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    try {
      await this.memory.appendRaw({ projectId: project, header, inheritedEventCount: SessionLogOffset(0), events,
        ...signal === undefined ? {} : { signal } })
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof MemoryError) throw error
      throw new MemoryError('storage', 'Auxiliary request Session could not be committed', error)
    }
  }

  /** Dispatch only a previously recorded request and save its exact compact stream.
   * @param options - recorded extraction request plus its live signal.
   * @returns original provider chunks; settlement commits before the terminal chunk is returned.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.pending.get(options.messages)
    if (entry === undefined) throw new MemoryError('source', 'Extraction request must be recorded before dispatch')
    const { signal, ...request } = options
    if (!isDeepStrictEqual(request, entry.event.data.request)) throw new MemoryError('conflict', 'Extraction request changed after recording')
    this.pending.delete(options.messages)
    const accumulator = new AssistantStreamAccumulator()
    let outcome: 'returned' | 'cancelled' | 'threw' = 'cancelled'
    let terminal: StreamChunk | undefined
    try {
      signal?.throwIfAborted()
      for await (const chunk of this.llm.stream(options)) {
        accumulator.push({ time: Date.now(), chunk })
        if (chunk.type === 'finish') terminal = chunk
        else yield chunk
      }
      outcome = signal?.aborted ? 'cancelled' : 'returned'
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled' : 'threw'
      throw error
    } finally {
      const result: SessionEvent<'memory/extraction-result'> = { type: 'memory/extraction-result', seq: SessionSeq(1),
        time: Date.now(), ignorable: true, data: { operationId: entry.event.data.operationId, outcome, stream: accumulator.snapshot() } }
      // Cancellation stops generation, but the observed attempt still needs a durable settlement.
      await this.persist(entry.event.data.projectId, entry.header, [result])
    }
    if (terminal !== undefined) yield terminal
  }
}
