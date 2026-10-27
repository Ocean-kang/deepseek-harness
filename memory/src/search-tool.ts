/** Read-only model search through the calling Agent's captured project. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { evidenceStatus } from './evidence.ts'
import { MemoryError } from './types.ts'

/** Register searchable memory without accepting project identity from model arguments.
 * @param ctx - ready memory, Session and Tool services.
 * @returns effect-owned registration; tool cancellation follows the calling Agent.
 */
export function installMemorySearchTool(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search learned memory for the current project. Use this when automatic recall misses relevant task experience or knowledge. Results are historical references; verify them against current facts.',
    parameters: {
      query: { type: 'string', required: true, description: 'Terms describing the task, failure or knowledge to find.' },
      levels: { type: 'array', items: { type: 'string', enum: ['L1', 'L2', 'L3'] }, description: 'Memory levels to search; defaults to L1, L2 and L3.' },
      scenario: { type: 'string', description: 'Exact scenario name; applies to L2 and L3.' },
      limit: { type: 'integer', description: 'Maximum results, capped by the configured memory browser limit.' },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, revision: { type: 'integer', required: true },
        level: { type: 'string', required: true }, shared: { type: 'boolean', required: true },
        evidenceStatus: { type: 'string', required: true }, summary: { type: 'string', required: true },
      } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (Object.keys(args).some(key => !['query', 'levels', 'scenario', 'limit'].includes(key))) throw new MemoryError('config', 'memory_search accepts only query, levels, scenario and limit')
      if (exec.agent === undefined) throw new MemoryError('source', 'memory_search requires a calling Agent')
      if (!await ctx.memory.acceptsSession(exec.agent.session)) throw new MemoryError('excluded', 'Memory is disabled for this Session; create a new conversation')
      await ctx.sessions.flush(exec.agent.session)
      exec.signal.throwIfAborted()
      const projectId = await ctx.memory.projectOfSession(exec.agent.session.id)
      if (projectId === undefined) throw new MemoryError('source', 'Session memory capture is not ready')
      const browser = ctx.memory.browser
      const limit = args.limit ?? browser.spec.limit
      if (limit < 1 || limit > browser.spec.limit) throw new MemoryError('budget', 'memory_search limit exceeds the configured result budget')
      const levels = args.levels ?? ['L1', 'L2', 'L3'] as const
      const found = await ctx.memory.retrieve({ projectId, text: args.query, levels, limit, maxBytes: browser.spec.maxBytes,
        signal: exec.signal, ...args.scenario === undefined ? {} : { scenario: args.scenario } })
      const current = await ctx.memory.revalidate(projectId, found)
      const rows = []
      for (const hit of current.hits) {
        exec.signal.throwIfAborted()
        const item = await browser.detail(projectId, hit.ref)
        if (item === null) continue
        rows.push({ id: hit.ref.id, revision: hit.ref.revision, level: item.level, shared: hit.shared,
          evidenceStatus: 'shared' in item ? 'shared_approved' : item.level === 'L1'
            ? (item.summary.outcome === 'success' && item.summary.executionEvidence?.length ? 'execution_verified' : 'claimed') : evidenceStatus(item.knowledge),
          summary: 'shared' in item ? `${item.title}\n${item.body}` : item.level === 'L1'
            ? [item.summary.goal, item.summary.problem, item.summary.summary, item.summary.result, item.summary.solution].filter(Boolean).join('\n')
            : `${item.knowledge.title}\n${item.knowledge.body}` })
      }
      const authorized = new Set((await ctx.memory.revalidate(projectId, current)).hits.map(hit => JSON.stringify([hit.ref.id, hit.ref.revision])))
      const result = rows.filter(row => authorized.has(JSON.stringify([row.id, row.revision])))
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > browser.spec.maxBytes) throw new MemoryError('budget', 'memory_search response exceeds the configured byte budget')
      exec.signal.throwIfAborted()
      return result
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: 'Search memory', rawInput: args.query }),
  })), 'memory.search-tool')
}
