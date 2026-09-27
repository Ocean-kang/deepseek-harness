/** Opt-in integration component; production registration awaits persistence declarations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRef } from './l1-types.ts'
import type { MemoryRetriever } from './retrieval.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-recall': { readonly kind: 'memory-recall'; readonly form: 'recall'; readonly turn: number;
      readonly memories: readonly { readonly ref: MemoryRef; readonly projectId: ProjectId; readonly shared: boolean }[] }
  }
}

/** Install a lifecycle-owned pre-step listener without waking an Agent.
 * Production callers must first register and acknowledge the persisted memory-recall source.
 * @param ctx - owning Cordis context.
 * @param retriever - owned retriever, closed separately after this listener drains.
 * @param projectOf - authoritative Session project resolver.
 * @param report - nonthrowing diagnostic sink.
 * @returns asynchronous disposer which waits for in-flight listeners.
 */
export function installMemoryInjector(ctx: Context, retriever: MemoryRetriever, projectOf: (agent: Agent) => Promise<ProjectId>, report: (error: MemoryError) => void): () => Promise<void> {
  const abort = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const attempted = new WeakMap<Agent, number>()
  const stop = ctx.on('agent/pre-step', (payload, next) => {
    const work = (async () => {
      const decision = await next()
      if (decision.kind !== 'enter' || !decision.messages.length || abort.signal.aborted) return decision
      const { agent, turn } = payload
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
      if (!text) return decision
      attempted.set(agent, turn)
      const signal = AbortSignal.any([payload.signal, abort.signal])
      try {
        signal.throwIfAborted()
        const project = await projectOf(agent)
        const result = await retriever.retrieve({ projectId: project, text, signal })
        signal.throwIfAborted()
        const checked = retriever.revalidate(project, result)
        if (!checked.hits.length) return decision
        const recall = createUserMessage({ content: [{ type: 'text', text: checked.text }], source: {
          kind: 'memory-recall', form: 'recall', turn,
          memories: checked.hits.map(hit => ({ ref: hit.ref, projectId: hit.projectId, shared: hit.shared })),
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
  const dispose = async () => { stop(); abort.abort(); await Promise.allSettled(pending) }
  ctx.effect(() => dispose, 'memory.injector')
  return dispose
}
