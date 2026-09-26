/** L0 API: project-owned, complete Session events and durable prefix positions. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** Explicit stable project identity; independent of filesystem location. */
export type ProjectId = Branded<'MemoryProjectId'>

/** Half-open interval of Session event positions. */
export interface RawRange {
  readonly from: SessionLogOffset
  readonly to: SessionLogOffset
}

/** One ordered batch, including immutable source metadata for first registration. */
export interface AppendRawRequest {
  readonly projectId: ProjectId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
  readonly signal?: AbortSignal
}

/** Returned only after both events and the continuous prefix commit. */
export interface AppendRawResult {
  readonly range: RawRange
  readonly inserted: number
  readonly duplicates: number
  readonly committedTo: SessionLogOffset
}

/** A stable requested interval; cursor is the next position within that interval. */
export interface ReadRawRequest extends RawRange {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly limit: number
  readonly cursor?: SessionLogOffset
  readonly signal?: AbortSignal
}

/** Missing ranges cover the whole requested interval, independently of pagination. */
export interface ReadRawResult {
  readonly found: boolean
  readonly events: readonly SessionEvent[]
  readonly nextCursor: SessionLogOffset | null
  readonly committedTo: SessionLogOffset
  readonly missing: readonly RawRange[]
}

/** Minimal persistence capability; successful appends are durable transactions. */
export interface RawMemory {
  /**
   * Commit ordered source events without advancing across a gap.
   * @param request - ordered source events and project.
   * @returns committed batch counts and prefix.
   */
  appendRaw(request: AppendRawRequest): Promise<AppendRawResult>
  /**
   * Read only the requested project's stored events.
   * @param request - project-scoped interval and pagination.
   * @returns events and explicit missing ranges.
   */
  readRaw(request: ReadRawRequest): Promise<ReadRawResult>
}

/** Stable diagnostic categories; messages never include event bodies. */
export type MemoryErrorCode = 'config' | 'closed' | 'conflict' | 'gap' | 'schema' | 'corrupt' | 'storage' | 'source' | 'backpressure'

/** A memory failure with an optional underlying cause for local debugging. */
export class MemoryError extends Error {
  /** Stable category for body-free diagnostics. */
  readonly code: MemoryErrorCode

  /**
   * Create a diagnostic without copying source event bodies.
   * @param code - stable category.
   * @param message - body-free diagnostic.
   * @param cause - original failure.
   */
  constructor(code: MemoryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MemoryError'
    this.code = code
  }
}
