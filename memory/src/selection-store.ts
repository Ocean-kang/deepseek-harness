/** Durable next-turn selections; consumption follows committed Session messages. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryRef, OperationId } from './l1-types.ts'
import { integer, json, object, textValue } from './l1-validation.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'

/** Migration executed in the parent provider's opening transaction. */
export const SELECTION_SCHEMA = `
CREATE TABLE memory_selections (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id), project TEXT NOT NULL,
 token TEXT NOT NULL, refs TEXT NOT NULL, automatic INTEGER NOT NULL CHECK(automatic IN (0,1))
) STRICT;
`

/** Exact versions waiting for one accepted turn, and the Session's automatic recall preference. */
export interface MemorySelection {
  readonly token: OperationId
  readonly refs: readonly MemoryRef[]
  readonly automatic: boolean
}

/** Shares the parent SQLite connection; callers validate eligibility and budgets before replacing selections. */
export class SelectionStore {
  /** @param db - parent-owned connection.
   * @param assertOpen - parent lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void) {}

  private owner(project: ProjectId, sessionId: SessionId): void {
    this.assertOpen()
    if (this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND project = ?').get(sessionId, project) === undefined) {
      throw new MemoryError('source', 'Session is not available in this project')
    }
  }

  /** @param project - authoritative Session owner.
   * @param sessionId - captured Session.
   * @returns durable selection, or null when no preference has been saved.
   */
  get(project: ProjectId, sessionId: SessionId): MemorySelection | null {
    this.owner(project, sessionId)
    const row = this.db.prepare('SELECT * FROM memory_selections WHERE session_id = ? AND project = ?').get(sessionId, project)
    if (row === undefined) return null
    const refs = json(row.refs)
    if (!Array.isArray(refs) || (row.automatic !== 0 && row.automatic !== 1)) throw new MemoryError('corrupt', 'Invalid stored memory selection')
    return { token: textValue(row.token) as OperationId, automatic: row.automatic === 1,
      refs: refs.map(value => {
        const ref = object(value)
        const revision = integer(ref.revision)
        if (revision < 1) throw new MemoryError('corrupt', 'Invalid selected memory revision')
        return { id: textValue(ref.id) as MemoryRef['id'], revision }
      }) }
  }

  /** Replace the pending versions; empty refs cancel selection without deleting memories.
   * @param project - authoritative Session owner.
   * @param sessionId - captured Session.
   * @param refs - validated exact versions.
   * @param automatic - automatic recall preference.
   * @returns new receipt; earlier in-flight receipts cannot consume this selection.
   */
  replace(project: ProjectId, sessionId: SessionId, refs: readonly MemoryRef[], automatic: boolean): MemorySelection {
    this.owner(project, sessionId)
    const token = randomUUID() as OperationId
    this.db.prepare(`INSERT INTO memory_selections VALUES (?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET project=excluded.project,token=excluded.token,refs=excluded.refs,automatic=excluded.automatic`)
      .run(sessionId, project, token, JSON.stringify(refs), automatic ? 1 : 0)
    return { token, refs: refs.map(ref => ({ ...ref })), automatic }
  }

  /** Clear only the receipt recorded in an admitted recall; retains the automatic preference.
   * @param project - authoritative owner.
   * @param sessionId - Session carrying the committed message.
   * @param token - receipt in that message.
   */
  consume(project: ProjectId, sessionId: SessionId, token: OperationId): void {
    this.owner(project, sessionId)
    this.db.prepare("UPDATE memory_selections SET refs = '[]' WHERE session_id = ? AND project = ? AND token = ?")
      .run(sessionId, project, token)
  }
}
