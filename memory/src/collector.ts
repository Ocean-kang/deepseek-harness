/** Bounded live capture with explicit asynchronous recovery from the canonical log. */
import { isDeepStrictEqual } from 'node:util'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Spec } from './config.ts'
import { MemoryError } from './types.ts'
import type { RawMemory } from './types.ts'

interface Capture {
  readonly session: Session
  readonly buffered: Map<number, SessionEvent>
  target: number
  dirty: boolean
  retired: boolean
  failure: unknown
  backpressure: boolean
}

/** Collects only adopted Sessions; the source log owns crash recovery, not the RAM queue. */
export class RawCollector {
  private readonly states = new Set<Capture>()
  private readonly adopted = new WeakMap<Session, Capture>()
  private tail: Promise<void> = Promise.resolve()
  private scheduled = false
  private bufferedCount = 0
  private closing = false
  private closePromise: Promise<void> | undefined

  /**
   * @param memory - durable transaction provider; remains open until close resolves.
   * @param source - canonical Session storage with an independent flush barrier.
   * @param spec - resolved limits and project identity.
   * @param report - body-free operational diagnostics; must not throw.
   * @param committed - notification after a complete L0 target commits; must not throw.
   */
  constructor(
    private readonly memory: RawMemory,
    private readonly source: Pick<SessionPersistence, 'flush' | 'open'>,
    private readonly spec: Spec,
    private readonly report: (error: MemoryError) => void,
    private readonly committed: () => void = () => {},
  ) {}

  /**
   * Adopt each exact Session instance at most once.
   * @param session - a newly published or already-live Session to recover and follow.
   */
  adopt(session: Session): void {
    if (this.closing || this.adopted.has(session)) return
    const state: Capture = { session, buffered: new Map(), target: session.seq, dirty: true, retired: false, failure: undefined, backpressure: false }
    this.adopted.set(session, state)
    this.states.add(state)
    this.schedule()
  }

  /**
   * Buffer an accepted event or retain its recovery target on overflow.
   * @param session - event owner.
   * @param event - exact accepted event, detached before deferred I/O.
   */
  capture(session: Session, event: SessionEvent): void {
    if (this.closing) return
    this.adopt(session)
    const state = this.adopted.get(session)!
    if (state.retired) return
    state.target = Math.max(state.target, event.seq + 1)
    if (state.failure !== undefined) return
    if (this.bufferedCount < this.spec.queueCapacity) {
      if (!state.buffered.has(event.seq)) {
        state.buffered.set(event.seq, materializeAppendBatch([event])[0]!)
        this.bufferedCount++
      }
    } else if (!state.backpressure) {
      state.backpressure = true
      this.report(new MemoryError('backpressure', `Session ${session.id}: queue full; canonical-log recovery required`))
    }
    state.dirty = true
    this.schedule()
  }

  /**
   * Retry failures and wait for the Session prefix captured at invocation.
   * @param session - live Session requesting a durability checkpoint.
   * @returns resolution only after the target prefix commits.
   */
  flush(session: Session): Promise<void> {
    if (this.closing) return Promise.reject(new MemoryError('closed', 'memory collector is closing'))
    this.adopt(session)
    const state = this.adopted.get(session)!
    return this.barrier(state, session.seq)
  }

  /**
   * Stop capture and release a departed Session after its final flush.
   * @param session - departed Session.
   * @returns completion of its final durable prefix.
   */
  retire(session: Session): Promise<void> {
    const state = this.adopted.get(session)
    if (state === undefined || this.closing) return Promise.resolve()
    state.retired = true
    return this.barrier(state, session.seq).then(() => this.release(state))
  }

  /**
   * Stop capture, drain accepted targets and release all retained event values.
   * @returns resolution after owned work settles; failed targets reject with diagnostics.
   */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    const targets = [...this.states].map(state => ({ state, target: Math.max(state.target, state.session.seq) }))
    this.closePromise = this.serialize(async () => {
      const failures: unknown[] = []
      for (const { state, target } of targets) {
        try {
          await this.synchronize(state, target)
        } catch (error) {
          failures.push(this.failure(state, target, error))
        } finally {
          this.release(state)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'memory final flush failed')
    })
    return this.closePromise
  }

  private barrier(state: Capture, target: number): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.synchronize(state, target)
        state.failure = undefined
        if (state.target > target && !state.retired) {
          state.dirty = true
          this.schedule()
        }
      } catch (error) {
        state.failure = error
        throw this.failure(state, target, error)
      }
    })
  }

  private schedule(): void {
    if (this.scheduled || this.closing) return
    this.scheduled = true
    const work = this.serialize(async () => {
      for (const state of this.states) {
        if (!state.dirty || state.retired || state.failure !== undefined) continue
        state.dirty = false
        const target = state.target
        try {
          await this.synchronize(state, target)
        } catch (error) {
          state.failure = error
          this.failure(state, target, error)
        }
      }
    })
    void work.finally(() => {
      this.scheduled = false
      if ([...this.states].some(state => state.dirty && !state.retired && state.failure === undefined)) this.schedule()
    }).catch(error => this.report(new MemoryError('storage', 'memory capture worker failed', error)))
  }

  private serialize(run: () => Promise<void>): Promise<void> {
    const work = this.tail.then(run)
    // A failed caller observes work; serialization must remain usable for explicit retry.
    this.tail = work.catch(() => undefined)
    return work
  }

  private async synchronize(state: Capture, target: number): Promise<void> {
    const request = {
      projectId: this.spec.projectId, header: state.session.header,
      inheritedEventCount: state.session.inheritedEventCount,
    }
    let position = (await this.memory.appendRaw({ ...request, events: [] })).committedTo
    if (position > state.session.seq) throw new MemoryError('conflict', `Session ${state.session.id}: source ends before the committed prefix`)
    for (const [seq, event] of state.buffered) {
      if (seq < position) await this.memory.appendRaw({ ...request, events: [event] })
    }
    this.discard(state, position)
    let handle: SessionHandle | undefined
    try {
      while (position < target) {
        const batch: SessionEvent[] = []
        for (let seq = position; seq < Math.min(target, position + this.spec.batchSize); seq++) {
          const event = state.buffered.get(seq)
          if (event === undefined) break
          batch.push(event)
        }
        if (batch.length === 0) {
          if (handle === undefined) {
            // This is the source service barrier, not the SessionStore dispatch.
            // Calling SessionStore.flush here would recursively invoke this collector.
            try {
              await this.source.flush()
              handle = await this.source.open(state.session.id, 'read')
            } catch (error) {
              throw new MemoryError('source', `Session ${state.session.id}: canonical log unavailable`, error)
            }
          }
          const count = Math.min(this.spec.pageSize, this.spec.batchSize, target - position)
          const page = await handle.read(position, count)
          if (page.events.length === 0 || page.events.length > count || page.events[0]?.seq !== Number(position)) {
            throw new MemoryError('source', `Session ${state.session.id}: source missing range [${position}, ${target})`)
          }
          batch.push(...page.events)
          // A feed value overlapping a recovery page must match that page.
          for (const event of batch) {
            const captured = state.buffered.get(event.seq)
            if (captured !== undefined) {
              if (!isDeepStrictEqual(captured, event)) throw new MemoryError('conflict', `Session ${state.session.id}: feed/source conflict at seq ${event.seq}`)
            }
          }
        }
        position = (await this.memory.appendRaw({ ...request, events: batch })).committedTo
        this.discard(state, position)
      }
      state.backpressure = false
      this.committed()
    } finally {
      await handle?.close()
    }
  }

  private discard(state: Capture, position: number): void {
    for (const seq of state.buffered.keys()) {
      if (seq < position) {
        state.buffered.delete(seq)
        this.bufferedCount--
      }
    }
  }

  private release(state: Capture): void {
    this.bufferedCount -= state.buffered.size
    state.buffered.clear()
    this.states.delete(state)
  }

  private failure(state: Capture, target: number, error: unknown): MemoryError {
    const code = error instanceof MemoryError ? error.code : 'storage'
    const failure = new MemoryError(code, `Session ${state.session.id}: L0 did not confirm prefix [0, ${target}); committed position is unchanged by the failed transaction`, error)
    this.report(failure)
    return failure
  }
}
