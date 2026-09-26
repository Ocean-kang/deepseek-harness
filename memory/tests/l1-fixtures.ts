/** Isolated source turns and validated candidate values for L1 behavior tests. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { L1Candidate, L1Task } from '../src/l1-types.ts'

/**
 * Build one complete turn, including a human message with optional large text.
 * @param reason - source end reason.
 * @param text - human task text.
 * @returns contiguous source events.
 */
export function turnEvents(reason: TurnEndReason = { kind: 'completed' }, text = 'Fix the failing parser'): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason } },
  ]
}

/**
 * Produce a conservative summary that claims no unobserved successful fix.
 * @param task - source identity.
 * @returns candidate citing the provided human message.
 */
export function candidate(task: Pick<L1Task, 'sessionId'>): L1Candidate {
  return { kind: 'memory', summary: { goal: 'Fix the parser', actions: [], outcome: 'unknown',
    result: 'A fix was requested; no verified result is present.', solution: null,
    sources: [{ sessionId: task.sessionId, seq: SessionSeq(1) }] } }
}
