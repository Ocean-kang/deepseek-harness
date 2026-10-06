/** Logged recall through the public merge-extensible message-source and pre-step APIs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRef, OperationId } from './l1-types.ts'
import type { MemorySearch, RetrievalHit, RetrievalResult } from './retrieval.ts'
import { renderRecall } from './retrieval.ts'
import type { MemoryBrowser } from './browser.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-recall': { readonly kind: 'memory-recall'; readonly form: 'recall'; readonly turn: number;
      readonly selectionId?: OperationId;
      readonly memories: readonly { readonly ref: MemoryRef; readonly projectId: ProjectId; readonly shared: boolean; readonly selected?: boolean }[] }
  }
}

/** Install a lifecycle-owned pre-step listener without waking an Agent.
 * The plugin owns the memory-recall source; its fields survive generic Session readers.
 * @param ctx - owning Cordis context.
 * @param retriever - owned retriever, closed separately after this listener drains.
 * @param projectOf - authoritative Session project resolver.
 * @param report - nonthrowing diagnostic sink.
 * @param browser - optional durable manual selection and combined admission policy; automatic recall defaults off in this mode.
 * @param accepts - Session admission policy, evaluated before capture or retrieval.
 * @returns asynchronous disposer which waits for in-flight listeners.
 */
export function installMemoryInjector(ctx: Context, retriever: Pick<MemorySearch, 'retrieve' | 'revalidate'>, projectOf: (agent: Agent) => Promise<ProjectId>, report: (error: MemoryError) => void, browser?: MemoryBrowser, accepts: (agent: Agent) => boolean = () => true): () => Promise<void> {
  const abort = new AbortController()
  const detachBrowser = browser?.attachInjector()
  const pending = new Set<Promise<unknown>>()
  const attempted = new WeakMap<Agent, number>()
  const owners = new Map<SessionId, ProjectId>()
  const committed = ctx.on('session/event', (session, event) => {
    const project = owners.get(session.id)
    if (project === undefined || browser === undefined) return
    try { browser.committed(project, session.id, event) } catch (error) {
      report(new MemoryError('storage', 'Recall committed; pending selection will reconcile from the Session log', error))
    }
  })
  const retired = ctx.on('session/disposed', session => { owners.delete(session.id) })
  const stop = ctx.on('agent/pre-step', (payload, next) => {
    const work = (async () => {
      const decision = await next()
      if (decision.kind !== 'enter' || !decision.messages.length || abort.signal.aborted) return decision
      const { agent, turn } = payload
      if (!accepts(agent)) return decision
      let inTurn = false
      let requested = false
      for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'turn/start') inTurn = event.data.turn === turn
        if (!inTurn) continue
        if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'assistant/attempt'
          || event.type === 'request/header' || event.type === 'request/context') requested = true
      }
      if (requested || attempted.get(agent) === turn) return decision
      const text = decision.messages.filter(message => message.source.kind === 'user')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n').trim()
      if (!text && browser === undefined) return decision
      attempted.set(agent, turn)
      const signal = AbortSignal.any([payload.signal, abort.signal])
      try {
        signal.throwIfAborted()
        const project = await projectOf(agent)
        owners.set(agent.session.id, project)
        const selection = browser?.selection(project, agent.session)
        let selected: RetrievalHit[] = []
        let selectionValid = true
        if (browser !== undefined && selection !== null && selection !== undefined) {
          try { selected = browser.manual(project, selection.refs) } catch (error) {
            selectionValid = false
            report(error instanceof MemoryError ? error : new MemoryError('storage', 'Selected memories could not be read'))
          }
        }
        let result: RetrievalResult | undefined
        if (text && (browser === undefined || selection?.automatic === true)) {
          try {
            result = await retriever.retrieve({ projectId: project, text, signal, levels: ['L3'],
              ...(browser === undefined ? {} : { limit: browser.spec.limit, maxBytes: browser.spec.maxBytes }) })
          } catch (error) {
            signal.throwIfAborted()
            report(error instanceof MemoryError ? error : new MemoryError('storage', 'Automatic memory retrieval failed; selected memories remain available'))
          }
        }
        signal.throwIfAborted()
        if (browser !== undefined && selectionValid && selection !== null && selection !== undefined) {
          // Version and grant checks follow asynchronous automatic retrieval.
          try { selected = browser.manual(project, selection.refs) } catch (error) {
            selected = []
            selectionValid = false
            report(error instanceof MemoryError ? error : new MemoryError('storage', 'Selected memories could not be rechecked'))
          }
        }
        const automatic = result === undefined ? [] : retriever.revalidate(project, result).hits
        const hits = [...selected]
        const keys = new Set(hits.map(hit => JSON.stringify(hit.ref)))
        for (const hit of automatic) {
          const key = JSON.stringify(hit.ref)
          if (keys.has(key)) continue
          if (browser !== undefined && (hits.length >= browser.spec.limit || Buffer.byteLength(renderRecall([...hits, hit]), 'utf8') > browser.spec.maxBytes)) continue
          hits.push(hit)
          keys.add(key)
        }
        if (!hits.length) return decision
        const selectedKeys = new Set(selected.map(hit => JSON.stringify(hit.ref)))
        const recall = createUserMessage({ content: [{ type: 'text', text: renderRecall(hits) }], source: {
          kind: 'memory-recall', form: 'recall', turn,
          ...(selectionValid && selected.length > 0 && selection !== undefined && selection !== null ? { selectionId: selection.token } : {}),
          memories: hits.map(hit => ({ ref: hit.ref, projectId: hit.projectId, shared: hit.shared,
            ...(browser === undefined ? {} : { selected: selectedKeys.has(JSON.stringify(hit.ref)) }) })),
        } })
        return { ...decision, messages: [...decision.messages, recall] }
      } catch (error) {
        payload.signal.throwIfAborted()
        if (!abort.signal.aborted) report(error instanceof MemoryError ? error : new MemoryError('storage', 'memory retrieval failed; task continues without recall'))
        return decision
      }
    })()
    pending.add(work)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    return work
  })
  const dispose = async () => { stop(); committed(); retired(); detachBrowser?.(); abort.abort(); await Promise.allSettled(pending); owners.clear() }
  ctx.effect(() => dispose, 'memory.injector')
  return dispose
}
