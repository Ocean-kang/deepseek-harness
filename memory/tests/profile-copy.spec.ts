/** Opt-in verification of an actual dsh smoke run, using the real JSONL decoder. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { memoryPath } from '../src/config.ts'

it.runIf(process.env.DSH_MEMORY_VERIFY_COPY === '1')('matches every copied event with the real profile log', async () => {
  const ctx = new Context()
  const db = new DatabaseSync(await memoryPath(process.env.DSH_MEMORY_VERIFY_DB ?? 'data/l0.sqlite'), { readOnly: true })
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: await memoryPath('home/sessions') })
    const sessions = db.prepare('SELECT id, committed_to FROM sessions').all()
    expect(sessions.length).toBeGreaterThan(0)
    for (const row of sessions) {
      if (typeof row.id !== 'string') throw new Error('invalid captured Session id')
      const handle = await ctx.sessionPersistence.open(SessionId(row.id), 'read')
      try {
        const source = await handle.read()
        const copied = db.prepare('SELECT body FROM events WHERE session_id = ? ORDER BY seq').all(row.id).map(record => {
          if (typeof record.body !== 'string') throw new Error('invalid captured JSON')
          const value: unknown = JSON.parse(record.body)
          return value
        })
        expect(copied.length).toBe(row.committed_to)
        // Boolean comparison keeps event bodies out of failure diagnostics.
        expect(isDeepStrictEqual(copied, source.events)).toBe(true)
      } finally {
        await handle.close()
      }
    }
  } finally {
    db.close()
    await ctx.fiber.dispose()
  }
})
