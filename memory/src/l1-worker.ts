/** Single-worker extraction with durable candidate recovery and bounded due-work flushes. */
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import type { L1Failure, L1Task } from './l1-types.ts'
import type { SqliteMemory } from './sqlite.ts'
import { L1ModelError } from './l1-extractor.ts'
import type { L1Extractor } from './l1-extractor.ts'

/** Owns in-flight cancellation; the caller retains the SQLite provider until close settles. */
export class L1Worker {
  private readonly owner = randomUUID()
  private readonly controller = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly watched = new Set<SessionId>()
  private readonly sources = new Map<SessionId, AbortController>()

  /**
   * @param memory - open provider, closed only after this worker.
   * @param extractor - requires a durable Session request recorder.
   * @param project - owning project.
   * @param pageSize - maximum L0 events per read.
   * @param report - body-free failure observer that must not throw.
   * @param now - epoch clock, replaceable for deterministic retry tests.
   */
  constructor(private readonly memory: SqliteMemory, private readonly extractor: Pick<L1Extractor, 'extractTurn'>,
    private readonly project: ProjectId, private readonly pageSize: number,
    private readonly report: (operation: L1Task['operationId'], failure: L1Failure) => void,
    private readonly now: () => number = Date.now) {}

  /**
   * Process each due operation at most once; future retry times are not awaited.
   * @param session - a source Session whose durable recorder is available.
   * @returns settlement of currently executable work for this Session.
   */
  flush(session: SessionId): Promise<void> {
    if (this.closing) return Promise.reject(new MemoryError('closed', 'L1 worker is closing'))
    let local = this.sources.get(session)
    if (local === undefined) { local = new AbortController(); this.sources.set(session, local) }
    const signal = AbortSignal.any([this.controller.signal, local.signal])
    const work = this.tail.then(async () => {
      const cutoff = this.now()
      for (;;) {
        if (signal.aborted) return
        const task = this.memory.l1.claim(this.project, session, this.owner, cutoff)
        if (task === null) return
        await this.run(task, signal)
      }
    })
    this.tail = work.catch(() => undefined)
    return work.then(() => this.arm())
  }

  /**
   * Schedule due work while this source Session can durably record requests.
   * @param session - available writable source Session; call retire before releasing it.
   */
  watch(session: SessionId): void {
    if (this.closing) throw new MemoryError('closed', 'L1 worker is closing')
    this.watched.add(session)
    this.arm()
  }

  /**
   * Stop scheduled retries and settle calls before a source Session is released.
   * @param session - departing source Session.
   * @returns settlement of queued and active worker operations.
   */
  async retire(session: SessionId): Promise<void> {
    this.sources.get(session)?.abort(new Error('L1 source Session retired'))
    this.sources.delete(session)
    this.watched.delete(session)
    this.arm()
    await this.tail
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closing) return
    const next = [...this.watched.keys()].flatMap(session => {
      const due = this.memory.l1.nextDue(this.project, session)
      return due === null ? [] : [{ ...due, session }]
    }).sort((a, b) => a.at - b.at)[0]
    if (next === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush(next.session).catch(error => this.report(next.operationId, classify(error)))
    }, Math.min(2147483647, Math.max(1, next.at - this.now())))
    this.timer.unref()
  }

  /**
   * Cancel and await all owned work, preserving unfinished tasks for recovery.
   * @returns completion only after model calls and writes have settled.
   */
  async close(): Promise<void> {
    this.closing = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.watched.clear()
    this.sources.clear()
    this.controller.abort(new Error('L1 worker closed'))
    await this.tail
  }

  private async run(task: L1Task, signal: AbortSignal): Promise<void> {
    try {
      const existing = this.memory.l1.byOperation(this.project, task.operationId)
      if (existing !== null) return
      if (task.candidate === null) {
        const events = []
        let cursor = task.from
        do {
          const page = await this.memory.readRaw({ projectId: this.project, sessionId: task.sessionId,
            from: task.from, to: task.to, cursor, limit: this.pageSize, signal })
          if (!page.found || page.missing.length > 0) throw new MemoryError('gap', 'L1 source interval is not fully committed')
          events.push(...page.events)
          if (page.nextCursor === null) break
          cursor = page.nextCursor
        } while (true)
        const candidate = await this.extractor.extractTurn(task, events, signal, () => this.memory.l1.reserveCall(this.project, task.operationId, this.owner))
        signal.throwIfAborted()
        this.memory.l1.prepare(this.project, task.operationId, this.owner, candidate)
      }
      signal.throwIfAborted()
      this.memory.l1.commitMemory(this.project, task.operationId, this.owner, this.now())
    } catch (error) {
      // A transport can report failure after COMMIT; never redo an already committed operation.
      if (this.memory.l1.byOperation(this.project, task.operationId) !== null || this.memory.l1.getTask(this.project, task.operationId)?.status === 'empty') return
      const failure = signal.aborted ? null : classify(error)
      this.memory.l1.fail(this.project, task.operationId, this.owner, failure, this.now())
      if (failure !== null) this.report(task.operationId, failure)
    }
  }
}

function classify(error: unknown): L1Failure {
  if (error instanceof L1ModelError) return { code: error.failureCode, retryable: error.retryable }
  if (error instanceof MemoryError) return { code: error.code, retryable: error.code === 'storage' }
  // Only SQLite contention is automatically retried; programming errors fail visibly.
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255)) return { code: 'SQLITE_BUSY', retryable: true }
  return { code: 'UNCLASSIFIED', retryable: false }
}
