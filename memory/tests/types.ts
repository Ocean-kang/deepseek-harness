/** Negative compile cases pin the nominal identities at the public memory API. */
import type { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectId } from '../src/types.ts'

declare const project: ProjectId
declare const session: SessionId
declare const seq: SessionSeq
// @ts-expect-error A project identity cannot address a Session.
const wrongSession: SessionId = project
// @ts-expect-error A Session identity cannot select a memory project.
const wrongProject: ProjectId = session
// @ts-expect-error Existing event sequence and next-event offset are distinct.
const wrongOffset: SessionLogOffset = seq
void [wrongSession, wrongProject, wrongOffset]
