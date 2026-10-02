/** Keyless model fixture mounted through a DSH profile; all memories are explicitly synthetic. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    async *stream(options) {
      let text = 'Independent memory package test response.'
      if (options.system?.startsWith('Summarize')) {
        const input = JSON.parse(options.messages[0].content[0].text)
        text = JSON.stringify({ kind: 'memory', summary: {
          goal: '[安装验收样例] Portable ESM constraint', actions: [], outcome: 'unknown',
          result: 'Synthetic fixture: use ESM.', solution: null,
          sources: input.input.flatMap(piece => piece.sources),
        } })
      } else if (options.system?.startsWith('Extract project knowledge')) {
        const input = JSON.parse(options.messages[0].content[0].text)
        text = JSON.stringify([{ target: null, knowledge: {
          title: '[安装验收样例] Portable ESM', body: 'Synthetic fixture: use ESM.',
          category: 'constraint', score: 4, rationale: 'Synthetic acceptance fixture', evidence: 'supported',
          sources: input.input.sources.map(ref => ({ kind: 'memory', ref: { id: ref.id, revision: ref.revision } })),
        } }])
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-smoke'], new Adapter()), 'memory.smoke-model')
}
