/** Human-only exact-version L3 sharing through the interactive command registry. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryRef, OperationId } from './l1-types.ts'
import { knowledgeRef } from './knowledge-validation.ts'
import type { ShareAction } from './knowledge-types.ts'
import type { SqliteMemory } from './sqlite.ts'
import type { ProjectId } from './types.ts'

const PREVIEW_MS = 5 * 60 * 1000
const USER_ID = 'local-interactive-user'

function refFrom(value: string): MemoryRef | null {
  const match = /^([^\s@]+)@(\d+)$/u.exec(value)
  if (match === null) return null
  const revision = Number(match[2])
  if (!Number.isSafeInteger(revision) || revision < 1) return null
  return knowledgeRef({ id: match[1], revision })
}

/** Install an optional direct user command; no model tool receives a grant method.
 * @param ctx - owning plugin context with a Session durability checkpoint.
 * @param provider - open local memory database.
 */
export function installShareCommand(ctx: Context, provider: SqliteMemory): void {
  const previews = new Map<SessionId, { token: string; project: ProjectId; ref: MemoryRef; expiresAt: number }>()
  ctx.effect(() => () => previews.clear(), 'memory.share-previews')
  ctx.on('session/disposed', session => { previews.delete(session.id) })
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'memory-share',
      description: 'Show, approve, or revoke sharing of an exact L3 memory version',
      input: { hint: 'show <id>@<revision> | approve <token> | revoke <id>@<revision>' },
      handler: async ({ agent, commandId, rawInput, signal }) => {
        const [action, value, extra] = rawInput.trim().split(/\s+/u)
        if (extra !== undefined || value === undefined || !['show', 'approve', 'revoke'].includes(action ?? '')) {
          return { kind: 'error', text: 'Use /memory-share show <id>@<revision>, approve <token>, or revoke <id>@<revision>.' }
        }
        signal.throwIfAborted()
        if (!await ctx.sessions.flush(agent.session)) return { kind: 'error', text: 'Session persistence is unavailable.' }
        signal.throwIfAborted()
        const project = provider.getSessionProject(agent.session.id)
        if (project === undefined) return { kind: 'error', text: 'This Session has no recorded memory project.' }
        if (action === 'approve') {
          const preview = previews.get(agent.session.id)
          if (preview === undefined || preview.token !== value || preview.project !== project || preview.expiresAt <= Date.now()) {
            return { kind: 'error', text: 'The sharing preview expired or belongs to another Session.' }
          }
          const memory = provider.knowledge.getMemory(project, preview.ref)
          if (memory === null || 'shared' in memory || memory.level !== 'L3' || memory.state !== 'active' || memory.knowledge.evidence !== 'supported') {
            return { kind: 'error', text: 'This L3 version is no longer eligible for sharing.' }
          }
          signal.throwIfAborted()
          const now = Date.now()
          const receiptId = String(commandId)
          const share: ShareAction = { operationId: receiptId as OperationId, projectId: project, ref: preview.ref,
            action: 'approve', userId: USER_ID, receiptId, occurredAt: now, expiresAt: now + PREVIEW_MS }
          provider.knowledge.approveShare(share, candidate => candidate === share && agent.session.snapshotEvents().some(event =>
            event.type === 'command/run' && event.data.commandId === commandId && event.data.name === 'memory-share' && event.data.source.kind === 'user'), now)
          previews.delete(agent.session.id)
          return { kind: 'success', text: `Shared ${preview.ref.id}@${preview.ref.revision} for future requests.` }
        }
        const ref = refFrom(value)
        if (ref === null) return { kind: 'error', text: 'Expected an exact memory id and positive revision.' }
        const memory = provider.knowledge.getMemory(project, ref)
        if (memory === null || 'shared' in memory || memory.level !== 'L3' || memory.projectId !== project) {
          return { kind: 'error', text: 'The requested L3 version is unavailable in this project.' }
        }
        if (action === 'show') {
          if (memory.state !== 'active' || memory.knowledge.evidence !== 'supported') return { kind: 'error', text: 'Only a current supported L3 version can be shared.' }
          const now = Date.now()
          const token = randomUUID()
          previews.set(agent.session.id, { token, project, ref, expiresAt: now + PREVIEW_MS })
          return { kind: 'success', text: `${memory.knowledge.title}\n\n${memory.knowledge.body}\n\nSharing exposes this version to other projects. Revocation stops new reads but cannot erase content already recorded in other Sessions or derived from earlier reads. To approve within five minutes, run /memory-share approve ${token}.` }
        }
        signal.throwIfAborted()
        const now = Date.now()
        const receiptId = String(commandId)
        const share: ShareAction = { operationId: receiptId as OperationId, projectId: project, ref,
          action: 'revoke', userId: USER_ID, receiptId, occurredAt: now, expiresAt: now + PREVIEW_MS }
        provider.knowledge.revokeShare(share, candidate => candidate === share && agent.session.snapshotEvents().some(event =>
          event.type === 'command/run' && event.data.commandId === commandId && event.data.name === 'memory-share' && event.data.source.kind === 'user'), now)
        return { kind: 'success', text: `Revoked sharing of ${ref.id}@${ref.revision} for future requests.` }
      },
    })
  })
}
