/** Keyless model fixture mounted through a DSH profile; all memories are explicitly synthetic. */
import { isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    async *stream(options) {
      let text = 'Independent memory package test response.'
      if (options.system?.startsWith('Expand the supplied search query')) {
        text = JSON.stringify(['ESM'])
      } else if (options.system?.startsWith('Write one short sentence')) {
        text = JSON.stringify({ description: '[安装验收样例] 该项目要求使用 ESM 模块。' })
      } else if (options.system?.startsWith('Summarize')) {
        const input = JSON.parse(options.messages[0].content[0].text)
        text = JSON.stringify({ kind: 'memory', summary: {
          title: '[安装验收样例] Portable ESM constraint', problem: 'Synthetic policy, no execution', summary: 'Synthetic fixture: use ESM.', description: '[安装验收样例] 该项目要求使用 ESM 模块。',
          goal: '[安装验收样例] Portable ESM constraint', actions: [], outcome: 'unknown',
          result: 'Synthetic fixture: use ESM.', solution: null,
          sources: input.input.flatMap(piece => piece.sources),
        } })
      } else if (options.system?.startsWith('Extract project knowledge') || options.system?.startsWith('Consolidate immutable execution episodes')) {
        const input = JSON.parse(options.messages[0].content[0].text)
        text = JSON.stringify([{ action: 'store', target: null, knowledge: {
          scenario: 'Synthetic module policy', conclusion: 'Use ESM modules', reason: 'Explicit synthetic policy', whenToUse: ['Project modules'],
          recommendedAction: 'Use ESM', limitations: ['Synthetic acceptance only'], kind: 'knowledge', conflicts: [], description: '[安装验收样例] 该项目要求使用 ESM 模块。',
          title: '[安装验收样例] Portable ESM', body: 'Synthetic fixture: use ESM.',
          category: 'constraint', score: 4, rationale: 'Synthetic acceptance fixture', evidence: 'supported',
          sources: input.input.sources.map(ref => ({ kind: 'memory', ref: { id: ref.id, revision: ref.revision } })),
        } }])
      } else if (isAgentLoopRequest(options) && options.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text.startsWith('[安装验收长原文样例]')))) {
        text = 'Synthetic ESM response evidence. '.repeat(600)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-smoke'], new Adapter()), 'memory.smoke-model')
}
