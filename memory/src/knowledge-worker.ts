/** Explicit consolidation execution; SQLite leases serialize work for each project. */
import { randomUUID } from 'node:crypto'
import { MemoryError } from './types.ts'
import type { ProjectId } from './types.ts'
import type { OperationId } from './l1-types.ts'
import { L1ModelError } from './l1-extractor.ts'
import type { KnowledgeExtractor } from './knowledge-extractor.ts'
import type { KnowledgeStore } from './knowledge-store.ts'

/** No production worker is installed until a genuine request recorder is available. */
export class KnowledgeWorker {
  private readonly owner = randomUUID()
  private readonly controller = new AbortController()
  private readonly active = new Set<Promise<void>>()
  /** @param store - parent-owned knowledge store.
   * @param extractor - extractor with a mandatory Session recorder.
   * @param now - epoch clock for deterministic recovery tests.
   */
  constructor(private readonly store: KnowledgeStore, private readonly extractor: Pick<KnowledgeExtractor, 'consolidate'>, private readonly now: () => number = Date.now) {}

  /** Execute a due task once; subsequent retries are explicit and respect stored backoff.
   * @param project - owning project.
   * @param operation - task identity.
   * @param signal - caller cancellation.
   * @returns settlement after all model and database work finishes.
   */
  run(project: ProjectId, operation: OperationId, signal: AbortSignal): Promise<void> {
    if (this.controller.signal.aborted) return Promise.reject(new MemoryError('closed', 'Knowledge worker is closed'))
    const work = this.execute(project, operation, AbortSignal.any([signal, this.controller.signal]))
    this.active.add(work)
    void work.finally(() => this.active.delete(work)).catch(() => undefined)
    return work
  }

  private async execute(project: ProjectId, operation: OperationId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const task = this.store.claim(project, operation, this.owner, this.now())
    if (task === null) return
    try {
      if (task.candidates === null) {
        const candidates = await this.extractor.consolidate(task, signal, () => this.store.reserveCall(project, operation, this.owner))
        signal.throwIfAborted()
        this.store.prepare(project, operation, this.owner, candidates)
      }
      signal.throwIfAborted()
      this.store.commit(project, operation, this.owner, this.now())
    } catch (error) {
      const current = this.store.getTask(project, operation)
      if (current?.status === 'done' || current?.owner !== this.owner) return
      const sqliteBusy = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255)
      const code = signal.aborted ? null : error instanceof L1ModelError ? error.failureCode : error instanceof MemoryError ? error.code : sqliteBusy ? 'SQLITE_BUSY' : 'UNCLASSIFIED'
      const retryable = signal.aborted || sqliteBusy || (error instanceof L1ModelError && error.retryable) || (error instanceof MemoryError && ['storage', 'conflict'].includes(error.code))
      this.store.fail(project, operation, this.owner, code, retryable, this.now())
    }
  }

  /** Abort and await all in-flight work before the owning database is closed.
   * @returns completion at quiescence.
   */
  async close(): Promise<void> {
    this.controller.abort(new Error('Knowledge worker closed'))
    await Promise.allSettled([...this.active])
  }
}
