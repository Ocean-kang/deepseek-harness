/** Opt-in live extraction fixture, loaded only through the supported headless profile. */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Config, MemoryPipeline, SqliteMemory, resolveConfig } from '../../lib/index.mjs'

export { Config }
export const name = 'memory-learning-live'
export const inject = ['llm', 'agentDefaultModel']

/** Mount one bounded real-provider learning run; the launcher owns process exit. */
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('Live learning requires the supported dsh launcher')
  let pipeline
  let memory
  let work
  ctx.effect(() => async () => {
    await pipeline?.close()
    await work?.catch(() => undefined)
    await memory?.close()
  }, 'memory.live-learning-fixture')
  const run = async () => {
    await ctx.get('loader')?.await()
    const spec = await resolveConfig(config)
    memory = await SqliteMemory.open(spec)
    const failures = []
    pipeline = new MemoryPipeline(memory, spec, ctx.llm, error => failures.push(error.code))
    try {
      const source = Session.create(SessionId(`memory-live-source-${randomUUID()}`))
      source.append('turn/start', { turn: 1 })
      source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
        text: 'Standing project policy: all new code must use strict TypeScript and ESM. This is an explicit long-term decision. Record it as a project constraint. No implementation or test execution has occurred.' }] }), { surfaceOp: 'append' })
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await pipeline.learn({ projectId: spec.projectId, header: source.header, inheritedEventCount: source.inheritedEventCount, events: source.snapshotEvents() })
      const l1Tasks = []
      const knowledgeTasks = []
      let after = ''
      for (;;) {
        const tasks = memory.l1.listTasks(spec.projectId, after, spec.pageSize)
        l1Tasks.push(...tasks.filter(task => task.sessionId === source.id))
        if (tasks.length < spec.pageSize) break
        after = tasks.at(-1).operationId
      }
      after = ''
      for (;;) {
        const tasks = memory.knowledge.listTasks(spec.projectId, after, spec.pageSize)
        knowledgeTasks.push(...tasks)
        if (tasks.length < spec.pageSize) break
        after = tasks.at(-1).operationId
      }
      const l1 = l1Tasks[0]
      const l1Memory = l1 === undefined ? null : memory.l1.byOperation(spec.projectId, l1.operationId)
      const l2 = l1Memory === null ? [] : knowledgeTasks.filter(task => task.input.level === 'L2'
        && task.input.sources.some(record => record.id === l1Memory.id && record.revision === l1Memory.revision))
      const l2Refs = l2.flatMap(task => task.result ?? [])
      const l3 = knowledgeTasks.filter(task => task.input.level === 'L3'
        && task.input.sources.some(record => l2Refs.some(ref => ref.id === record.id && ref.revision === record.revision)))
      const report = {
        provider: spec.l1.provider, model: spec.l1.model, database: spec.databasePath,
        sourceSession: source.id,
        l1: l1 === undefined ? null : { status: l1.status, calls: l1.calls, failure: l1.failure?.code ?? null },
        l2: l2.map(task => ({ status: task.status, calls: task.calls, count: task.result?.length ?? 0, failure: task.failure })),
        l3: l3.map(task => ({ status: task.status, calls: task.calls, count: task.result?.length ?? 0, failure: task.failure })),
        failures,
      }
      return { ...report, passed: l1?.status === 'done' && l2.some(task => task.status === 'done' && task.result?.length)
        && l3.some(task => task.status === 'done' && task.result?.length) && failures.length === 0 }
    } finally {
      await pipeline.close()
      await memory.close()
    }
  }
  work = run()
  void work.then(report => { console.log(JSON.stringify(report)); exit(report.passed ? 0 : 1) }, () => {
    console.error('memory: live learning fixture failed; no completion claimed')
    exit(1)
  })
}
