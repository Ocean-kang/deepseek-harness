/** Library composition for recoverable L0-to-L3 learning without registering an agent plugin. */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Spec } from './config.ts'
import type { SqliteMemory } from './sqlite.ts'
import type { AppendRawRequest, AppendRawResult, ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import { L1Extractor } from './l1-extractor.ts'
import { L1Worker } from './l1-worker.ts'
import { KnowledgeExtractor } from './knowledge-extractor.ts'
import { KnowledgeWorker } from './knowledge-worker.ts'
import { enqueueCandidates } from './knowledge-store.ts'
import { MemoryRequestJournal } from './request-journal.ts'
import type { MemorySearch, RetrievalRequest, RetrievalResult } from './retrieval.ts'

/** Shared counters and waiters for all databases owned by one plugin instance. */
export class LearningBudget {
  /** Currently executing project drains across all attached pipelines. */
  active = 0
  /** Queued and executing drains across all attached pipelines. */
  drains = 0
  /** FIFO execution waiters; cancelled entries are removed by their owner. */
  readonly waiting: Array<{ start: () => void }> = []
  /** Pipeline callbacks notified after queued capacity becomes available. */
  readonly available = new Set<() => void>()
}

/** Serializes learning per project and bounds concurrent drains across projects. */
export class MemoryPipeline {
  private readonly journal: MemoryRequestJournal
  private readonly knowledge: KnowledgeWorker
  private readonly workers = new Map<ProjectId, L1Worker>()
  private readonly tails = new Map<ProjectId, Promise<void>>()
  private readonly watched = new Set<ProjectId>()
  private readonly dirty = new Set<ProjectId>()
  private readonly timers = new Map<ProjectId, ReturnType<typeof setTimeout>>()
  private readonly overloaded = new Set<ProjectId>()
  private readonly unsubscribe: () => void
  private readonly abort = new AbortController()
  private closing = false

  /** @param memory - caller-owned open database, closed after this pipeline.
   * @param spec - resolved model, paging and concurrency settings; both model configurations are required.
   * @param llm - existing configured model service.
   * @param report - nonthrowing observer for retained task failures.
   * @param retriever - optional caller-owned index on the same provider.
   * @param budget - shared counters for all databases belonging to one plugin instance.
   */
  constructor(private readonly memory: SqliteMemory, private readonly spec: Pick<Spec, 'l1' | 'knowledge' | 'pageSize' | 'learningConcurrency' | 'learningQueueCapacity'>,
    llm: Pick<LlmRuntime, 'stream'>, private readonly report: (error: MemoryError) => void, private readonly retriever?: MemorySearch, private readonly budget = new LearningBudget()) {
    if (spec.l1 === undefined || spec.knowledge === undefined) throw new MemoryError('config', 'Independent learning requires L1 and knowledge model configurations')
    this.journal = new MemoryRequestJournal(memory, llm)
    const extractor = new KnowledgeExtractor(this.journal, this.journal.recordKnowledge, SessionId('memory-knowledge'))
    this.knowledge = new KnowledgeWorker(memory.knowledge, extractor)
    this.budget.available.add(this.resumeOverloaded)
    this.unsubscribe = memory.onMemoryChange(() => {
      for (const project of this.watched) {
        if (this.tails.has(project)) this.dirty.add(project)
        else this.schedule(project, Date.now())
      }
    })
  }

  private readonly resumeOverloaded = () => {
    for (const project of this.overloaded) this.schedule(project, Date.now())
    this.overloaded.clear()
  }

  /** Capture complete source events and process presently due learning tasks.
   * @param request - project-owned source batch; inherited events remain source data.
   * @returns durable L0 result after current learning work settles; inspect task states for model failures.
   */
  async learn(request: AppendRawRequest): Promise<AppendRawResult> {
    this.assertOpen()
    const result = await this.memory.appendRaw(request)
    await this.flush(request.projectId, request.signal)
    return result
  }

  /** Recover committed L0 and execute each currently due L1/L2/L3 task once.
   * @param project - owner to recover; no live source Session is required.
   * @param signal - caller cancellation; committed L0 and unfinished tasks are retained.
   * @returns settlement of due work and any attached index; rejects with backpressure when capacity is full.
   */
  flush(project: ProjectId, signal?: AbortSignal): Promise<void> {
    this.assertOpen()
    if (this.budget.drains - this.budget.active >= this.spec.learningQueueCapacity) {
      if (this.watched.has(project)) this.overloaded.add(project)
      throw new MemoryError('backpressure', 'Learning queue is full; committed L0 remains available for recovery')
    }
    const timer = this.timers.get(project)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(project)
    const drainSignal = AbortSignal.any([this.abort.signal, ...signal === undefined ? [] : [signal]])
    this.budget.drains++
    const previous = this.tails.get(project) ?? Promise.resolve()
    const work = this.waitForProject(previous, drainSignal).then(async () => {
      const release = await this.acquire(drainSignal)
      try { await this.process(project, drainSignal) } finally { release() }
    })
    const finished = work.catch(() => undefined)
    const settled = Promise.all([previous, finished]).then(() => undefined)
    this.tails.set(project, settled)
    void finished.then(() => {
      this.budget.drains--
      for (const available of this.budget.available) available()
    })
    void settled.then(() => {
      if (this.tails.get(project) !== settled) return
      this.tails.delete(project)
      if (this.dirty.delete(project)) this.schedule(project, Date.now())
      else this.arm(project)
    }).catch(error => this.reportScheduler(error))
    return work
  }

  private async waitForProject(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener('abort', cancel)
        // AbortSignal.reason is ambient any; keep it out of the typed pipeline.
        const reason: unknown = signal.reason
        reject(reason)
      }
      signal.addEventListener('abort', cancel, { once: true })
      void previous.then(() => {
        signal.removeEventListener('abort', cancel)
        resolve()
      })
    })
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const entry = { start: () => {
        signal.removeEventListener('abort', cancel)
        this.budget.active++
        resolve(() => { this.budget.active--; this.budget.waiting.shift()?.start() })
      } }
      const cancel = () => {
        const index = this.budget.waiting.indexOf(entry)
        if (index !== -1) this.budget.waiting.splice(index, 1)
        // AbortSignal.reason is ambient any; keep it out of the typed pipeline.
        const reason: unknown = signal.reason
        reject(reason)
      }
      if (this.budget.active < this.spec.learningConcurrency) entry.start()
      else { this.budget.waiting.push(entry); signal.addEventListener('abort', cancel, { once: true }) }
    })
  }

  /** Recover a project and automatically schedule its durable retries and later memory commits.
   * @param project - owner whose provider remains available.
   * @returns settlement of startup recovery; newly imported L0 still enters through learn or flush.
   */
  watch(project: ProjectId): Promise<void> {
    this.assertOpen()
    this.watched.add(project)
    return this.flush(project)
  }

  /** Coalesce committed source notifications without awaiting a model request.
   * @param project - source owner; enables retry watching for this project.
   */
  wake(project: ProjectId): void {
    this.assertOpen()
    this.watched.add(project)
    if (this.tails.has(project)) this.dirty.add(project)
    else this.schedule(project, Date.now())
  }

  /** Stop background work for one project and await its currently queued drains.
   * @param project - owner to stop watching; explicit later learn/flush calls remain available.
   * @returns settlement of the drains queued before this call.
   */
  async retire(project: ProjectId): Promise<void> {
    this.watched.delete(project)
    this.overloaded.delete(project)
    this.dirty.delete(project)
    const timer = this.timers.get(project)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(project)
    await this.tails.get(project)
  }

  private reportScheduler(error: unknown): void {
    if (!this.closing) this.report(error instanceof MemoryError ? error : new MemoryError('storage', 'Independent learning scheduler failed', error))
  }

  private schedule(project: ProjectId, at: number): void {
    if (this.closing || !this.watched.has(project)) return
    const timer = this.timers.get(project)
    if (timer !== undefined) clearTimeout(timer)
    const next = setTimeout(() => {
      this.timers.delete(project)
      if (this.closing || !this.watched.has(project)) return
      void Promise.resolve().then(() => this.flush(project)).catch(error => this.reportScheduler(error))
    }, Math.min(2147483647, Math.max(1, at - Date.now())))
    next.unref()
    this.timers.set(project, next)
  }

  private arm(project: ProjectId): void {
    if (this.closing || !this.watched.has(project) || this.tails.has(project)) return
    let at = this.memory.knowledge.nextDue(project)?.at
    for (const session of this.sourceSessions(project)) {
      const due = this.memory.l1.nextDue(project, session)
      if (due !== null) at = at === undefined ? due.at : Math.min(at, due.at)
    }
    const timer = this.timers.get(project)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(project)
    if (at !== undefined) this.schedule(project, at)
  }

  private assertOpen(): void { if (this.closing) throw new MemoryError('closed', 'Independent memory pipeline is closing') }

  private sourceSessions(project: ProjectId): Set<SessionId> {
    let after = ''
    const sessions = new Set<SessionId>()
    for (;;) {
      const tasks = this.memory.l1.listTasks(project, after, this.spec.pageSize)
      for (const task of tasks) sessions.add(task.sessionId)
      if (tasks.length < this.spec.pageSize) return sessions
      after = tasks.at(-1)!.operationId
    }
  }

  private async process(project: ProjectId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const l1 = this.spec.l1!
    this.memory.scanTurns(project, l1, this.spec.pageSize)
    let worker = this.workers.get(project)
    if (worker === undefined) {
      worker = new L1Worker(this.memory, new L1Extractor(this.journal, this.journal.recordL1), project, this.spec.pageSize,
        (_operation, failure) => this.report(new MemoryError('model', `L1 task failed (${failure.code})`)))
      this.workers.set(project, worker)
    }
    for (const session of this.sourceSessions(project)) { await worker.flush(session, signal); signal.throwIfAborted() }
    for (const target of ['L2', 'L3'] as const) {
      enqueueCandidates(this.memory.knowledge, project, target, this.spec.knowledge!, this.spec.pageSize)
      let after = ''
      for (;;) {
        const tasks = this.memory.knowledge.listTasks(project, after, this.spec.pageSize)
        for (const task of tasks) {
          if (task.input.level !== target) continue
          await this.knowledge.run(project, task.operationId, signal)
          signal.throwIfAborted()
          const current = this.memory.knowledge.getTask(project, task.operationId)
          if (current?.failure !== null && current?.failure !== undefined) this.report(new MemoryError('model', `${target} task failed (${current.failure})`))
        }
        if (tasks.length < this.spec.pageSize) break
        after = tasks.at(-1)!.operationId
      }
    }
    this.retriever?.schedule()
    await this.retriever?.flush()
  }

  /** Search current learned versions using the optional configured retriever.
   * @param request - query and owner.
   * @returns authorized, budgeted references, or rejects when no retriever is attached.
   */
  retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    this.assertOpen()
    if (this.retriever === undefined) throw new MemoryError('config', 'Independent search requires a configured retriever')
    return this.retriever.retrieve(request)
  }

  /** Cancel model calls and await queued work before the caller releases its database.
   * @returns completion after all learning and request-journal writes settle; does not close caller-owned resources.
   */
  async close(): Promise<void> {
    this.closing = true
    this.unsubscribe()
    this.budget.available.delete(this.resumeOverloaded)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.watched.clear()
    this.overloaded.clear()
    this.dirty.clear()
    this.abort.abort(new Error('Independent memory pipeline closed'))
    await Promise.all([this.knowledge.close(), ...[...this.workers.values()].map(worker => worker.close())])
    await Promise.allSettled([...this.tails.values()])
  }
}
