/** Per-test memory-owned filesystem resources and real SQLite connections. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { memoryPath, resolveConfig } from '../src/config.ts'
import { SqliteMemory } from '../src/sqlite.ts'
import type { AppendRawRequest } from '../src/types.ts'

/**
 * Allocate an isolated memory-local test root.
 * @returns unique owned directory and its resolved provider configuration.
 */
export async function fixture() {
  const parent = await memoryPath('.tmp/tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'l0-'))
  const spec = await resolveConfig({ projectId: 'test-project', databasePath: join(root, 'l0.sqlite'), batchSize: 2, pageSize: 2, queueCapacity: 2 })
  const connections: SqliteMemory[] = []
  return {
    root, spec,
    async open() {
      const provider = await SqliteMemory.open(spec)
      connections.push(provider)
      return provider
    },
    async close() {
      await Promise.all(connections.map(provider => provider.close()))
      await memoryPath(root)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/**
 * Construct metadata for a fixture Session.
 * @param id - fixture identity.
 * @returns current unseeded Session metadata.
 */
export function header(id = 'session-a'): SessionHeader {
  return { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
}

/**
 * Construct a complete event without file or message references.
 * @param seq - event position.
 * @returns a complete fixture event.
 */
export function event(seq: number): SessionEvent<'session/end-seed'> {
  return { type: 'session/end-seed', seq: SessionSeq(seq), time: seq + 1, data: {} }
}

/**
 * Bind fixture events to their project and Session metadata.
 * @param spec - project owner.
 * @param events - ordered fixture batch.
 * @returns append request.
 */
export function batch(spec: { projectId: AppendRawRequest['projectId'] }, events: readonly SessionEvent[]): AppendRawRequest {
  return { projectId: spec.projectId, header: header(), inheritedEventCount: SessionLogOffset(0), events }
}
