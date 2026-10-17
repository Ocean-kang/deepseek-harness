/** Async facade over the plugin-owned SQLite worker. */
import { getEnvironmentData, Worker } from 'node:worker_threads'
import { serialize } from 'node:v8'
import type { SqliteMemory as Backend } from './sqlite-backend.ts'
import type { L1Store } from './l1-store.ts'
import type { KnowledgeStore } from './knowledge-store.ts'
import type { SelectionStore } from './selection-store.ts'
import type { MaintenanceStore } from './maintenance-store.ts'
import type { VectorStore, VectorDocument } from './vector-store.ts'
import type { Spec } from './config.ts'
import type { ProjectId, AppendRawRequest, ReadRawRequest } from './types.ts'
import { MemoryError } from './types.ts'
import { storageResponse } from './storage-protocol.ts'
import type { storageMethods } from './storage-protocol.ts'
import type { RetrievalRequest, RetrievalResult } from './retrieval.ts'
import type { TextSearchSpec } from './text-retrieval.ts'
import type { ShareAction } from './knowledge-types.ts'
export { SCHEMA_VERSION } from './sqlite-backend.ts'

/** Synchronous stores are supported only by isolated backend unit fixtures. */
export type AwaitableStore<S> = { [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<Awaited<R>> : S[K] }
type AsyncStore<S> = { [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : S[K] }
/** Shared consumer capability for production async storage and synchronous unit fixtures. */
export type MemoryDatabase = Omit<AwaitableStore<Backend>, 'vectors' | 'l1' | 'knowledge' | 'selections' | 'maintenance' | 'onMemoryChange'> & {
  onMemoryChange(listener: () => void): () => void;
  readonly l1: AwaitableStore<L1Store>; readonly knowledge: AwaitableStore<KnowledgeStore>;
  readonly selections: AwaitableStore<SelectionStore>; readonly maintenance: AwaitableStore<MaintenanceStore>;
  readonly vectors: Omit<AwaitableStore<VectorStore>, 'documents'> & { documents(project: ProjectId, size: number): Iterable<VectorDocument> | AsyncIterable<VectorDocument> };
}
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly bytes: number; readonly detach: () => void }

/** Shared owner of all memory connections belonging to one plugin instance. */
export class StorageWorker {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<number, Set<() => void>>()
  private serial = 0
  private databaseSerial = 0
  private bytes = 0
  private closed = false
  private readonly ready: Promise<void>
  private readonly exited: Promise<void>
  private rejectReady!: (error: Error) => void
  /** @param spec - resolved request queue bounds. */
  constructor(private readonly spec: Pick<Spec, 'storageQueueCapacity' | 'storageQueueMaxBytes'>) {
    const source = import.meta.url.endsWith('.ts')
    const execArgv = source ? ['--import', 'tsx/esm'] : []
    if (getEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution') !== undefined) {
      execArgv.unshift('--import', import.meta.resolve('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap'))
    }
    this.worker = new Worker(new URL(source ? './storage-worker.ts' : './storage-worker.mjs', import.meta.url), {
      name: 'memory-storage', execArgv,
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    this.rejectReady = rejectReady
    this.exited = new Promise(resolve => this.worker.once('exit', () => resolve()))
    this.worker.on('message', (value: unknown) => {
      const parsed = storageResponse.safeParse(value)
      if (!parsed.success) { this.fail(new MemoryError('unknown-outcome', 'Invalid storage response; reopen and inspect committed operations')); return }
      const response = parsed.data
      if (response.kind === 'ready') { resolveReady(); return }
      if (response.kind === 'change') { for (const listener of this.listeners.get(response.database) ?? []) listener(); return }
      const pending = this.pending.get(response.id)
      if (pending === undefined) return
      this.pending.delete(response.id); this.bytes -= pending.bytes
      pending.detach()
      if (response.kind === 'result') pending.resolve(response.value)
      else {
        const error = new MemoryError(response.failure.code, response.failure.message)
        if (response.failure.errcode !== undefined) Object.assign(error, { errcode: response.failure.errcode })
        pending.reject(error)
      }
    })
    this.worker.on('error', error => { rejectReady(error); this.fail(new MemoryError('unknown-outcome', 'Storage worker failed; reopen and inspect committed operations', error)) })
    this.worker.on('exit', code => {
      if (!this.closed || this.pending.size > 0) {
        const error = new MemoryError('unknown-outcome', `Storage worker exited (${code}); reopen and inspect committed operations`)
        rejectReady(error); this.fail(error)
      }
    })
  }
  private fail(error: Error): void {
    this.closed = true
    this.rejectReady(error)
    for (const item of this.pending.values()) { item.detach(); item.reject(error) }
    this.pending.clear(); this.bytes = 0
    void this.worker.terminate().catch(() => undefined)
  }
  /** @returns whether this worker can still accept new databases. */
  isAvailable(): boolean { return !this.closed }
  /** @param spec - validated database configuration. @returns initialized worker-local identity. */
  async open(spec: Spec): Promise<number> {
    await this.ready
    const id = ++this.databaseSerial
    await this.call(id, 'open', 'open', [spec])
    return id
  }
  /** @param database - worker-local owner. @param scope - public storage capability.
   * @param method - operation name. @param args - structured-clone inputs.
   * @returns settled result; worker loss reports an unknown commit outcome.
   */
  async call<T>(database: number, scope: keyof typeof storageMethods | 'open', method: string, args: readonly unknown[]): Promise<T> {
    await this.ready
    if (this.closed) throw new MemoryError('closed', 'Storage worker is closed')
    const signals: AbortSignal[] = []
    const signalArgs: number[] = []
    const copied = args.map((value, index) => {
      if (typeof value === 'object' && value !== null && 'signal' in value) {
        const { signal, ...rest } = value
        if (signal instanceof AbortSignal) { signal.throwIfAborted(); signals.push(signal); signalArgs.push(index) }
        return rest
      }
      return value
    })
    const request = { id: ++this.serial, database, scope, method, args: copied, signalArgs }
    const bytes = serialize(request).byteLength
    // One oversized event may occupy an otherwise empty channel without truncation.
    // Closing control messages follow accepted writes even when the data queue is full.
    const closing = scope === 'database' && method === 'close'
    if (!closing && (this.pending.size >= this.spec.storageQueueCapacity || (this.pending.size > 0 && this.bytes + bytes > this.spec.storageQueueMaxBytes))) throw new MemoryError('backpressure', 'Storage queue is full; source logs remain available for retry')
    const result = new Promise<unknown>((resolve, reject) => {
      const cancel = () => { if (!this.closed) this.worker.postMessage({ kind: 'cancel', id: request.id }) }
      for (const signal of signals) signal.addEventListener('abort', cancel, { once: true })
      const detach = () => { for (const signal of signals) signal.removeEventListener('abort', cancel) }
      this.pending.set(request.id, { resolve, reject, bytes, detach }); this.bytes += bytes
      try { this.worker.postMessage(request) } catch (error) {
        this.pending.delete(request.id); this.bytes -= bytes; detach()
        reject(new MemoryError('integration', 'Storage request could not be sent; no operation was dispatched', error))
      }
    })
    return await result as T
  }
  /** @param database - initialized owner. @param listener - nonthrowing commit notification. @returns disposer. */
  onChange(database: number, listener: () => void): () => void {
    let set = this.listeners.get(database)
    if (set === undefined) { set = new Set(); this.listeners.set(database, set) }
    set.add(listener)
    return () => { set.delete(listener) }
  }
  /** Await worker exit after the owning databases and dependent operations close. */
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; await this.worker.terminate() }
    await this.exited
  }
}

/** Bounded worker owner; different active databases are placed on the least loaded worker. */
export class StoragePool {
  private readonly slots: Array<{ worker: StorageWorker; databases: number }> = []
  private readonly routes = new Map<number, { slot: { worker: StorageWorker; databases: number }; local: number }>()
  private serial = 0
  private closed = false
  /** @param spec - plugin-wide worker count and per-worker queue bounds. */
  constructor(private readonly spec: Pick<Spec, 'storageQueueCapacity' | 'storageQueueMaxBytes' | 'storageWorkers'>) {}
  /** @param spec - database paths and limits. @returns pool-local database identity. */
  async open(spec: Spec): Promise<number> {
    if (this.closed) throw new MemoryError('closed', 'Storage pool is closed')
    for (const failed of this.slots.filter(slot => !slot.worker.isAvailable())) {
      await failed.worker.close()
      const index = this.slots.indexOf(failed)
      if (index >= 0) this.slots.splice(index, 1)
      for (const [id, route] of this.routes) if (route.slot === failed) this.routes.delete(id)
    }
    if (this.closed) throw new MemoryError('closed', 'Storage pool is closed')
    let slot = [...this.slots].sort((a, b) => a.databases - b.databases)[0]
    if (slot === undefined || (slot.databases > 0 && this.slots.length < this.spec.storageWorkers)) {
      slot = { worker: new StorageWorker(this.spec), databases: 0 }; this.slots.push(slot)
    }
    slot.databases++
    try {
      const local = await slot.worker.open(spec)
      if (this.closed) throw new MemoryError('closed', 'Storage pool closed while opening the database')
      const id = ++this.serial
      this.routes.set(id, { slot, local })
      return id
    } catch (error) { slot.databases--; throw error }
  }
  /** @param database - pool identity. @param scope - capability. @param method - operation. @param args - validated inputs.
   * @returns settled result; worker failures retain their unknown-outcome classification.
   */
  async call<T>(database: number, scope: keyof typeof storageMethods | 'open', method: string, args: readonly unknown[]): Promise<T> {
    const route = this.routes.get(database)
    if (route === undefined || this.closed) throw new MemoryError('closed', 'Storage database is unavailable')
    const result = await route.slot.worker.call<T>(route.local, scope, method, args)
    if (scope === 'database' && method === 'close') { this.routes.delete(database); route.slot.databases-- }
    return result
  }
  /** @param database - pool identity. @param listener - nonthrowing observer. @returns disposer. */
  onChange(database: number, listener: () => void): () => void {
    const route = this.routes.get(database)
    if (route === undefined) throw new MemoryError('closed', 'Storage database is unavailable')
    return route.slot.worker.onChange(route.local, listener)
  }
  /** @returns completion after every owned worker exits. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.slots.map(slot => slot.worker.close()))
    this.routes.clear()
  }
}

/** Public async provider; capabilities share the same database lifetime and queue order. */
export class SqliteMemory {
  readonly l1: AsyncStore<L1Store>
  readonly knowledge: AsyncStore<KnowledgeStore>
  readonly vectors: Omit<AsyncStore<VectorStore>, 'documents'> & { documents(project: ProjectId, size: number): AsyncIterable<VectorDocument> }
  readonly selections: AsyncStore<SelectionStore>
  readonly maintenance: AsyncStore<MaintenanceStore>
  private closed = false
  private closing: Promise<void> | undefined
  private constructor(private readonly worker: StorageWorker | StoragePool, private readonly id: number, private readonly spec: Spec, private readonly ownsWorker: boolean) {
    this.l1 = this.store<L1Store>('l1'); this.knowledge = this.store<KnowledgeStore>('knowledge')
    this.selections = this.store<SelectionStore>('selections'); this.maintenance = this.store<MaintenanceStore>('maintenance')
    const vectors = this.store<Omit<VectorStore, 'documents'>>('vectors')
    this.vectors = Object.assign(vectors, { documents: (project: ProjectId, size: number) => this.documents(project, size) })
  }
  private store<S>(scope: keyof typeof storageMethods): AsyncStore<S> {
    return new Proxy({} as AsyncStore<S>, { get: (target, name) => {
      if (Reflect.has(target, name)) return Reflect.get(target, name)
      if (typeof name !== 'string' || name === 'then') return undefined
      return (...args: unknown[]) => {
        if (scope === 'knowledge' && ['approveShare', 'revokeShare'].includes(name)) {
          const [action, verify] = args as [ShareAction, (action: ShareAction) => boolean]
          args[1] = verify(action)
        }
        return this.call(scope, name, args)
      }
    } })
  }
  private call<T>(scope: keyof typeof storageMethods, method: string, args: readonly unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new MemoryError('closed', 'memory database is closed'))
    return this.worker.call<T>(this.id, scope, method, args)
  }
  private async *documents(project: ProjectId, size: number): AsyncIterable<VectorDocument> {
    for (const level of ['L1', 'L2', 'L3'] as const) {
      let after = ''
      for (;;) {
        const page = await this.vectors.documentPage(project, level, after, size)
        for (const document of page) yield document
        if (page.length < size) break
        after = page.at(-1)!.memory.id
      }
    }
  }
  /** @param spec - resolved paths and limits. @param worker - optional shared Workspace owner. @returns ready provider. */
  static async open(spec: Spec, worker?: StorageWorker | StoragePool): Promise<SqliteMemory> {
    const owner = worker ?? new StorageWorker(spec)
    try { return new SqliteMemory(owner, await owner.open(spec), spec, worker === undefined) }
    catch (error) { if (worker === undefined) await owner.close(); throw error }
  }
  /** @param listener - nonthrowing commit notification. @returns disposer. */
  onMemoryChange(listener: () => void): () => void { return this.worker.onChange(this.id, listener) }
  /** @param args - source identity. @returns stored owner. */
  getSessionProject(...args: Parameters<Backend['getSessionProject']>) { return this.call<ReturnType<Backend['getSessionProject']>>('database', 'getSessionProject', args) }
  /** @returns stored project identities. */
  listProjects() { return this.call<ReturnType<Backend['listProjects']>>('database', 'listProjects', []) }
  /** @param args - owner. @returns persisted learning counters. */
  learningStatus(...args: Parameters<Backend['learningStatus']>) { return this.call<ReturnType<Backend['learningStatus']>>('database', 'learningStatus', args) }
  /** @param args - owner and identity page. @returns source metadata page. */
  listSessions(...args: Parameters<Backend['listSessions']>) { return this.call<ReturnType<Backend['listSessions']>>('database', 'listSessions', args) }
  /** @param args - project, cursor, size and literal query. @returns raw event page. */
  browseRaw(...args: Parameters<Backend['browseRaw']>) { return this.call<ReturnType<Backend['browseRaw']>>('database', 'browseRaw', args) }
  /** @param request - ordered source events. @returns durable prefix after COMMIT. */
  appendRaw(request: AppendRawRequest) { return this.call<Awaited<ReturnType<Backend['appendRaw']>>>('database', 'appendRaw', [request]) }
  /** @param request - exact interval. @returns byte-bounded page and missing ranges. */
  readRaw(request: ReadRawRequest) { return this.call<Awaited<ReturnType<Backend['readRaw']>>>('database', 'readRaw', [{ ...request, maxBytes: request.maxBytes ?? this.spec.pageMaxBytes }]) }
  /** @param args - project, frozen extraction settings and page size. @returns newly enqueued turns. */
  async scanTurns(...args: Parameters<Backend['scanTurns']>): Promise<number> {
    let created = 0
    for (;;) {
      const page = await this.call<{ created: number; pending: boolean }>('database', 'scanTurnsPage', args)
      created += page.created
      if (!page.pending) return created
    }
  }
  /** @param args - owner, extraction settings and page bound. @returns one committed scan page. */
  scanTurnsPage(...args: Parameters<Backend['scanTurnsPage']>) { return this.call<Awaited<ReturnType<Backend['scanTurnsPage']>>>('database', 'scanTurnsPage', args) }
  /** @param spec - text limits. @param request - authorized query. @returns transient FTS result. */
  textQuery(spec: TextSearchSpec, request: RetrievalRequest): Promise<{ result: RetrievalResult; matched: boolean; fingerprint: string; candidates: number }> { return this.call('database', 'textQuery', [spec, request]) }
  /** @param spec - corpus scan limits. @param request - owner and filters. @returns exact authorized-version digest. */
  textSnapshot(spec: TextSearchSpec, request: RetrievalRequest): Promise<string> { return this.call('database', 'textSnapshot', [spec, request]) }
  /** @param spec - text limits. @param project - owner. @returns candidate completeness. */
  textStatus(spec: TextSearchSpec, project: ProjectId): Promise<{ method: 'bm25'; candidates: number; truncated: boolean; ready: boolean }> { return this.call('database', 'textStatus', [spec, project]) }
  /** @returns completion after discarding derived text corpora for a subsequent rebuild. */
  rebuildTextIndex(): Promise<void> { return this.call('database', 'rebuildTextIndex', []) }
  /** Drain dependents first; shared workers remain available to other databases. */
  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.closing = (async () => {
      try { await this.worker.call(this.id, 'database', 'close', []) }
      finally { if (this.ownsWorker) await this.worker.close() }
    })()
    return this.closing
  }
}
