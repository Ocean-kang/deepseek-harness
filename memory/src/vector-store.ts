/** Version-bound SQLite vectors; authorization is always resolved from current memories. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeStore } from './knowledge-store.ts'
import type { OwnedMemory, SharedMemory } from './knowledge-types.ts'
import type { ProjectId } from './types.ts'
import { MemoryError } from './types.ts'
import type { EmbeddingSpec } from './embedding.ts'
import { unitVector } from './embedding.ts'

/** Migration owned by SqliteMemory's transaction. */
export const VECTOR_SCHEMA = `
CREATE TABLE memory_vectors (
 space TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
 vector TEXT NOT NULL, PRIMARY KEY(space,id,revision)
) STRICT;
CREATE TABLE memory_index_state (space TEXT PRIMARY KEY, status TEXT NOT NULL, failure TEXT) STRICT;
CREATE TABLE memory_generation (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL) STRICT;
INSERT INTO memory_generation VALUES (1,0);
CREATE TRIGGER memory_l1_insert AFTER INSERT ON l1_memories BEGIN UPDATE memory_generation SET generation = generation + 1; END;
CREATE TRIGGER memory_knowledge_insert AFTER INSERT ON knowledge_versions BEGIN UPDATE memory_generation SET generation = generation + 1; END;
CREATE TRIGGER memory_knowledge_update AFTER UPDATE ON knowledge_versions BEGIN UPDATE memory_generation SET generation = generation + 1; END;
CREATE TRIGGER memory_grant_insert AFTER INSERT ON knowledge_grants BEGIN UPDATE memory_generation SET generation = generation + 1; END;
CREATE TRIGGER memory_grant_delete AFTER DELETE ON knowledge_grants BEGIN UPDATE memory_generation SET generation = generation + 1; END;
CREATE INDEX memory_knowledge_candidates ON knowledge_versions(level,state,id);
`

/** Authorized candidate, whose text excludes private source lineage. */
export type VisibleMemory = OwnedMemory | SharedMemory
/** Retrieval projection and immutable content digest. */
export interface VectorDocument { readonly memory: VisibleMemory; readonly text: string; readonly digest: string }

/** Render one stable embedding document without expanding any source.
 * @param memory - authorized version.
 * @returns version-bound text and digest.
 */
export function vectorDocument(memory: VisibleMemory): VectorDocument {
  const text = memory.level === 'L1'
    ? JSON.stringify({ goal: memory.summary.goal, actions: memory.summary.actions, outcome: memory.summary.outcome,
      result: memory.summary.result, solution: memory.summary.solution, reason: memory.reason })
    : 'shared' in memory ? `${memory.title}\n${memory.body}` : `${memory.knowledge.title}\n${memory.knowledge.body}`
  return { memory, text, digest: createHash('sha256').update(text).digest('hex') }
}

/** Internal storage shares the parent's connection and lifetime. */
export class VectorStore {
  /** @param db - parent connection.
   * @param knowledge - authoritative visibility reader.
   * @param assertOpen - parent lifetime check.
   */
  constructor(private readonly db: DatabaseSync, private readonly knowledge: KnowledgeStore, private readonly assertOpen: () => void) {}

  /** @returns committed memory mutation generation. */
  generation(): number { this.assertOpen(); return Number(this.db.prepare('SELECT generation FROM memory_generation WHERE singleton = 1').get()!.generation) }

  /** @returns all owners with stored memories, including imported stores. */
  projects(): ProjectId[] {
    this.assertOpen()
    return this.db.prepare('SELECT project FROM l1_memories UNION SELECT project FROM knowledge_versions ORDER BY project').all().map(row => String(row.project) as ProjectId)
  }

  /** Page authorized candidates without loading the whole library.
   * @param project - requester.
   * @param size - page size.
   * @returns lazy version documents.
   */
  *documents(project: ProjectId, size: number): Generator<VectorDocument> {
    this.assertOpen()
    for (const level of ['L1', 'L2', 'L3'] as const) {
      let cursor = ''
      for (;;) {
        const page = this.knowledge.listCandidates(project, level, cursor, size)
        for (const memory of page) yield vectorDocument(memory)
        if (page.length < size) break
        cursor = page.at(-1)!.id
      }
    }
  }

  /** Recheck both current revision and sharing after asynchronous work.
   * @param project - requester.
   * @param document - previously visible content.
   * @returns whether the same content remains eligible.
   */
  current(project: ProjectId, document: VectorDocument): boolean {
    this.assertOpen()
    const memory = this.knowledge.getMemory(project, document.memory)
    return memory !== null && ('shared' in memory || (memory.state === 'active' && (memory.level === 'L1' || memory.knowledge.evidence === 'supported')))
      && vectorDocument(memory).digest === document.digest
  }

  /** @param spec - vector space.
   * @param document - exact document.
   * @returns validated unit vector or null when missing.
   */
  read(spec: EmbeddingSpec, document: VectorDocument): number[] | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT digest,vector FROM memory_vectors WHERE space = ? AND id = ? AND revision = ?').get(spec.space, document.memory.id, document.memory.revision)
    if (row === undefined || row.digest !== document.digest) return null
    try { return unitVector(JSON.parse(String(row.vector)), spec.dimensions) } catch (error) { throw new MemoryError('corrupt', 'stored embedding vector is invalid') }
  }

  /** Commit a validated batch atomically, skipping retired in-flight versions.
   * @param spec - vector space.
   * @param project - owner used for the final visibility check.
   * @param documents - input order.
   * @param vectors - corresponding external vectors.
   */
  put(spec: EmbeddingSpec, project: ProjectId, documents: readonly VectorDocument[], vectors: readonly number[][]): void {
    this.assertOpen()
    if (documents.length !== vectors.length) throw new MemoryError('output', 'embedding batch count mismatch')
    const validated = vectors.map(vector => unitVector(vector, spec.dimensions))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [index, document] of documents.entries()) {
        if (!this.current(project, document)) continue
        this.db.prepare('INSERT INTO memory_vectors VALUES (?,?,?,?,?) ON CONFLICT(space,id,revision) DO UPDATE SET digest=excluded.digest,vector=excluded.vector')
          .run(spec.space, document.memory.id, document.memory.revision, document.digest, JSON.stringify(validated[index]))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /** @param spec - vector space.
   * @param status - worker lifecycle state.
   * @param failure - body-free failure category.
   */
  state(spec: EmbeddingSpec, status: 'building' | 'ready' | 'failed', failure: string | null = null): void {
    this.assertOpen()
    this.db.prepare('INSERT INTO memory_index_state VALUES (?,?,?) ON CONFLICT(space) DO UPDATE SET status=excluded.status,failure=excluded.failure').run(spec.space, status, failure)
  }

  /** @param spec - selected vector space.
   * @returns persisted build status, independent of project completeness.
   */
  status(spec: EmbeddingSpec): { status: string; failure: string | null } {
    this.assertOpen()
    const row = this.db.prepare('SELECT status,failure FROM memory_index_state WHERE space = ?').get(spec.space)
    return { status: row === undefined ? 'missing' : String(row.status), failure: row?.failure == null ? null : String(row.failure) }
  }

  /** @param spec - exact vector space to rebuild; other spaces and memory history remain intact. */
  clear(spec: EmbeddingSpec): void { this.assertOpen(); this.db.prepare('DELETE FROM memory_vectors WHERE space = ?').run(spec.space) }
}
