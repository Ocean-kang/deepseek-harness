/** New synthetic historical sources for retention acceptance; existing Session generations remain untouched. */
import { randomUUID } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

/** Memory-owned scratch directory and the registered workspace receiving new synthetic sources. */
export const Config = z.object({ run: z.string().required(), cwd: z.string().required() })
/** Canonical source creation uses the public Session persistence provider. */
export const inject = ['sessionPersistence']

/** Write new, closed canonical sources with old timestamps using the public persistence service.
 * @param ctx - supported Web profile.
 * @param config - memory-owned scratch root and registered workspace.
 */
export function apply(ctx, config) {
  const memory = fileURLToPath(new URL('../../', import.meta.url))
  let work
  ctx.effect(() => async () => { await work }, 'memory.storage-web-source-lifetime')
  ctx.effect(() => ctx.appReady.onReady(() => {
    work = (async () => {
      for (const path of [config.run, config.cwd]) {
        if (!isAbsolute(path) || !resolve(path).startsWith(resolve(memory) + sep) || await realpath(path) !== resolve(path)) throw new Error('Retention acceptance paths must stay inside memory')
      }
      const createdAt = Date.now() - 3 * 86_400_000
      const sources = []
      for (const kind of ['unreferenced', 'supported']) {
        const id = SessionId(`memory-retention-${kind}-${randomUUID()}`)
        const header = { id, version: SESSION_FORMAT_VERSION, createdAt, cwd: config.cwd, isSeeded: false }
        const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: kind === 'supported'
          ? '[Synthetic retention acceptance] Standing workspace policy: use ESM modules. This is a stable project constraint; no execution is claimed.'
          : '[Synthetic disposable cleanup record] Temporary acceptance text without a completed turn or derived knowledge.' }] })
        const events = kind === 'unreferenced'
          ? [{ type: 'user/message', seq: SessionSeq(0), time: createdAt + 1, data: message, surfaceOp: 'append' }]
          : [{ type: 'turn/start', seq: SessionSeq(0), time: createdAt + 1, data: { turn: 1 } },
            { type: 'user/message', seq: SessionSeq(1), time: createdAt + 2, data: message, surfaceOp: 'append' },
            { type: 'turn/end', seq: SessionSeq(2), time: createdAt + 3, data: { turn: 1, reason: { kind: 'completed' } } }]
        const writer = await ctx.sessionPersistence.create(header)
        try { await writer.append(events); await writer.flush() } finally { await writer.close() }
        sources.push({ id, kind, header, eventCount: events.length })
      }
      await writeFile(resolve(config.run, 'aged-sources.json'), JSON.stringify({ synthetic: true, sources }, null, 2), { flag: 'wx' })
      console.log('MEMORY_RETENTION_SOURCES_CREATED')
    })().catch(error => { ctx.logger.error('Retention acceptance source creation failed', error) })
  }), 'memory.storage-web-create-sources')
}
