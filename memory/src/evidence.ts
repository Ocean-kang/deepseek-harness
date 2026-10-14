/** Program checks use committed tool results; assistant text never establishes execution success. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { EventRef, L1Summary } from './l1-types.ts'
import type { EvidenceStatus, Knowledge } from './knowledge-types.ts'

/** Check a matched tool result using tool-owned status fields or the shipped shell renderer.
 * @param call - recorded invocation.
 * @param result - recorded settlement of that invocation.
 * @returns whether a completed operation succeeded, excluding background starts and timeouts.
 */
export function executionSucceeded(call: SessionEvent<'tool/call'>, result: SessionEvent<'tool/result'>): boolean {
  if (call.data.callId !== result.data.message.toolCallId || result.data.message.isError === true || result.data.error !== undefined) return false
  const text = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  if (['bash', 'pwsh'].includes(call.data.name)) {
    let args: unknown
    try { args = JSON.parse(call.data.arguments) } catch (error) { return false } // Invalid recorded arguments cannot establish a completed command.
    if (args === null || typeof args !== 'object' || ('run_in_background' in args && args.run_in_background === true)) return false
    if (/\[(?:timed out|aborted|stopped:|still running|sandbox:|exit code: null)|^started background job |^.*background job /mu.test(text)) return false
    const status = parseExitStatus(text)
    return 'exitCode' in status && status.exitCode === 0
  }
  // Explicit tool status is required; the absence of isError alone says nothing about an artifact or test.
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { return false } // Plain output remains a model-supported claim.
  if (value === null || typeof value !== 'object') return false
  if (('timedOut' in value && value.timedOut !== false) || ('aborted' in value && value.aborted !== false)
    || ('signal' in value && value.signal !== null) || ('kind' in value && ['background', 'promoted'].includes(String(value.kind)))) return false
  return ('exitCode' in value && value.exitCode === 0) || ('success' in value && value.success === true)
}

/** Collect successful matched result references inside one recorded source interval.
 * @param sessionId - owning source Session.
 * @param events - complete source events.
 * @returns successful result identities; no outcome is inferred from turn completion.
 */
export function executionRefs(sessionId: EventRef['sessionId'], events: readonly SessionEvent[]): EventRef[] {
  const calls = new Map<string, SessionEvent<'tool/call'>>()
  const refs: EventRef[] = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event)
    if (event.type !== 'tool/result') continue
    const call = calls.get(event.data.message.toolCallId)
    if (call !== undefined && executionSucceeded(call, event)) refs.push({ sessionId, seq: event.seq })
  }
  return refs
}

/** Preserve execution details separately from the episode's readable fields.
 * @param events - complete source interval.
 * @param actions - extracted intermediate actions.
 * @returns trace retaining original invocation arguments and error/result data.
 */
export function episodeTrace(events: readonly SessionEvent[], actions: readonly string[]): NonNullable<L1Summary['trace']> {
  return { actions, commands: events.filter(event => traceIncludes(event, 'commands')).map(event => JSON.stringify(event)),
    files: events.filter(event => traceIncludes(event, 'files')).map(event => JSON.stringify(event)),
    errors: events.filter(event => traceIncludes(event, 'errors')).map(event => JSON.stringify(event)) }
}

/** Classify one recorded trace item without retaining the source interval.
 * @param event - one committed source event.
 * @param category - trace section to collect.
 * @returns whether this event belongs to the section.
 */
export function traceIncludes(event: SessionEvent, category: 'commands' | 'files' | 'errors'): boolean {
  if (category === 'commands') return event.type === 'tool/call' && /bash|pwsh|shell|terminal/u.test(event.data.name)
  if (category === 'files') return event.type === 'tool/call' && /file|read|write|edit|patch|fs_/u.test(event.data.name)
  return (event.type === 'tool/result' && (event.data.message.isError === true || event.data.error !== undefined
    || event.data.message.content.some(block => block.type === 'text' && /\[(?:exit code: [1-9]\d*|killed by signal:|timed out|aborted|stopped:)/u.test(block.text))))
    || (event.type === 'turn/end' && event.data.reason.kind === 'error')
}

/** Select the largest UTF-8 bounded prefix without splitting a Unicode code point.
 * @param text - one source value or stored chunk.
 * @param offset - UTF-16 position on a code-point boundary.
 * @param maxBytes - available byte capacity.
 * @returns exclusive UTF-16 end position.
 */
export function utf8End(text: string, offset: number, maxBytes: number): number {
  let end = offset
  let bytes = 0
  while (end < text.length) {
    const point = text.codePointAt(end)!
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    end += point > 0xffff ? 2 : 1
  }
  return end
}

/** Resolve old confidence labels and source freshness without changing historical JSON.
 * @param knowledge - immutable card.
 * @param current - whether every source remains usable.
 * @returns confidence origin or the current stale/conflicted state.
 */
export function evidenceStatus(knowledge: Knowledge, current = true): EvidenceStatus {
  if (!current) return 'stale'
  if (knowledge.evidence === 'conflict') return 'conflicted'
  return knowledge.evidenceStatus ?? (knowledge.evidence === 'supported' ? 'model_supported' : 'claimed')
}
