/** Incremental, requester-isolated FTS corpora; immutable memories remain the authority. */
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate as yieldHost } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeStore } from './knowledge-store.ts'
import type { MemoryId } from './l1-types.ts'
import { MemoryError } from './types.ts'
import { matchesRetrieval, renderRecall } from './retrieval.ts'
import type { RetrievalHit, RetrievalRequest, RetrievalResult } from './retrieval.ts'
import { vectorDocument } from './vector-store.ts'
import type { TextSearchSpec } from './text-retrieval-backend.ts'

/** Version-7 derived indexes and mutation journal; rows can be rebuilt from retained memories. */
export const TEXT_SCHEMA = `
CREATE TABLE memory_text_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL) STRICT;
CREATE TABLE memory_text_corpora (
 key TEXT PRIMARY KEY, epoch TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
 seq INTEGER NOT NULL CHECK(seq>=0), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), touched INTEGER NOT NULL DEFAULT 0 CHECK(touched>=0)
) STRICT;
CREATE TABLE memory_text_entries (
 row_id INTEGER PRIMARY KEY, corpus TEXT NOT NULL REFERENCES memory_text_corpora(key) ON DELETE CASCADE,
 id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), owner TEXT NOT NULL, shared INTEGER NOT NULL CHECK(shared IN (0,1)),
 digest TEXT NOT NULL, UNIQUE(corpus,id)
) STRICT;
CREATE INDEX memory_l1_project_id ON l1_memories(project,id,revision);
CREATE INDEX memory_knowledge_project_id ON knowledge_versions(project,state,id);
CREATE TRIGGER memory_text_l1_insert AFTER INSERT ON l1_memories BEGIN INSERT INTO memory_text_changes(id) VALUES(new.id); END;
CREATE TRIGGER memory_text_l1_delete AFTER DELETE ON l1_memories BEGIN INSERT INTO memory_text_changes(id) VALUES(old.id); END;
CREATE TRIGGER memory_text_knowledge_insert AFTER INSERT ON knowledge_versions BEGIN INSERT INTO memory_text_changes(id) VALUES(new.id); END;
CREATE TRIGGER memory_text_knowledge_update AFTER UPDATE ON knowledge_versions BEGIN INSERT INTO memory_text_changes(id) VALUES(new.id); END;
CREATE TRIGGER memory_text_knowledge_delete AFTER DELETE ON knowledge_versions BEGIN INSERT INTO memory_text_changes(id) VALUES(old.id); END;
CREATE TRIGGER memory_text_grant_insert AFTER INSERT ON knowledge_grants BEGIN INSERT INTO memory_text_changes(id) VALUES(new.id); END;
CREATE TRIGGER memory_text_grant_delete AFTER DELETE ON knowledge_grants BEGIN INSERT INTO memory_text_changes(id) VALUES(old.id); END;
CREATE TRIGGER memory_text_audit_insert AFTER INSERT ON memory_execution_audits BEGIN
 INSERT INTO memory_text_changes(id) VALUES(new.memory_id);
 UPDATE memory_generation SET generation=generation+1;
END;
`

interface Corpus { key: string; epoch: string; cursor: string; ready: number; seq: number; version: number }

/** Connection-local coordinator; each persistent corpus contains only one requester's eligible records. */
export class TextIndex {
  private readonly busy = new Map<string, number>()
  /** @param db - owning connection. @param knowledge - current visibility and ancestry reader. @param capacity - maximum retained filter corpora. */
  constructor(private readonly db: DatabaseSync, private readonly knowledge: KnowledgeStore, private readonly capacity: number) {}

  private latest(): number { return Number(this.db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='memory_text_changes'),0) AS seq").get()!.seq) }

  private corpus(spec: TextSearchSpec, request: RetrievalRequest): Corpus {
    const key = createHash('sha256').update(JSON.stringify([request.projectId, spec.tokenizer,
      request.levels === undefined ? null : [...request.levels].sort(), request.kinds === undefined ? null : [...request.kinds].sort(), request.scenario])).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
    if (this.db.prepare('SELECT 1 FROM memory_text_corpora WHERE key=?').get(key) === undefined) {
      const rows = this.db.prepare('SELECT key FROM memory_text_corpora ORDER BY touched,key').all()
      if (rows.length >= this.capacity) {
        const victim = rows.find(row => !this.busy.has(String(row.key)))
        if (victim === undefined) throw new MemoryError('backpressure', 'All retained text corpora are currently in use')
        const name = String(victim.key)
        if (!/^[0-9a-f]{64}$/u.test(name)) throw new MemoryError('corrupt', 'Invalid stored text corpus identity')
        this.db.exec(`DROP TABLE IF EXISTS memory_fts_${name}`)
        this.db.prepare('DELETE FROM memory_text_corpora WHERE key=?').run(name)
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO memory_text_corpora(key,epoch,seq) VALUES(?,?,?)').run(key, randomUUID(), this.latest())
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`memory_fts_${key}`) === undefined) {
      this.db.prepare('DELETE FROM memory_text_entries WHERE corpus=?').run(key)
      this.db.prepare("UPDATE memory_text_corpora SET cursor='',ready=0,seq=?,epoch=?,version=version+1 WHERE key=?").run(this.latest(), randomUUID(), key)
      this.db.exec(`CREATE VIRTUAL TABLE memory_fts_${key} USING fts5(body,tokenize='${spec.tokenizer}')`)
    }
    this.db.prepare('UPDATE memory_text_corpora SET touched=? WHERE key=?').run(Date.now(), key)
    const corpus = this.readCorpus(key)
    this.db.exec('COMMIT')
    return corpus
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private readCorpus(key: string): Corpus {
    const row = this.db.prepare('SELECT * FROM memory_text_corpora WHERE key=?').get(key)!
    return { key, epoch: String(row.epoch), cursor: String(row.cursor), ready: Number(row.ready), seq: Number(row.seq), version: Number(row.version) }
  }

  /** Discard only derived corpora; the caller drains active queries before rebuilding.
   * @returns completion after every retained corpus is removed.
   */
  reset(): void {
    if (this.busy.size) throw new MemoryError('conflict', 'Text index is in use; wait for active queries before rebuilding')
    this.db.exec('BEGIN IMMEDIATE')
    try {
    for (const row of this.db.prepare('SELECT key FROM memory_text_corpora').all()) {
      const key = String(row.key)
      if (!/^[0-9a-f]{64}$/u.test(key)) throw new MemoryError('corrupt', 'Invalid stored text corpus identity')
      this.db.exec(`DROP TABLE IF EXISTS memory_fts_${key}`)
    }
    this.db.exec('DELETE FROM memory_text_corpora')
    this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private document(request: RetrievalRequest, id: string) {
    const row = this.db.prepare(`SELECT revision FROM l1_memories WHERE id=? AND project=? ORDER BY revision DESC LIMIT 1`).get(id, request.projectId)
      ?? this.db.prepare(`SELECT revision FROM knowledge_versions WHERE id=? AND state='active'`).get(id)
    if (row === undefined) return null
    const ref = { id: id as MemoryId, revision: Number(row.revision) }
    const memory = this.knowledge.getMemory(request.projectId, ref)
    if (memory === null || (!('shared' in memory) && (memory.state !== 'active' || (memory.level !== 'L1' && memory.knowledge.evidence !== 'supported')))
      || !this.knowledge.sourcesCurrent(memory.projectId, ref)) return null
    const document = vectorDocument(memory)
    return matchesRetrieval(document, request) ? document : null
  }

  private update(corpus: Corpus, request: RetrievalRequest, id: string): void {
    const old = this.db.prepare('SELECT row_id,revision,digest,shared FROM memory_text_entries WHERE corpus=? AND id=?').get(corpus.key, id)
    const document = this.document(request, id)
    if (old !== undefined && document !== null && old.revision === document.memory.revision && old.digest === document.digest && old.shared === Number('shared' in document.memory)) return
    if (old === undefined && document === null) return
    if (old !== undefined) {
      this.db.prepare(`DELETE FROM memory_fts_${corpus.key} WHERE rowid=?`).run(old.row_id!)
      this.db.prepare('DELETE FROM memory_text_entries WHERE row_id=?').run(old.row_id!)
    }
    if (document !== null) {
      const inserted = this.db.prepare('INSERT INTO memory_text_entries(corpus,id,revision,owner,shared,digest) VALUES(?,?,?,?,?,?)')
        .run(corpus.key, id, document.memory.revision, document.memory.projectId, Number('shared' in document.memory), document.digest)
      this.db.prepare(`INSERT INTO memory_fts_${corpus.key}(rowid,body) VALUES(?,?)`).run(inserted.lastInsertRowid, document.text)
    }
    this.db.prepare('UPDATE memory_text_corpora SET version=version+1 WHERE key=?').run(corpus.key)
  }

  /** Apply bounded pages before exposing a corpus; partially built corpora never serve ranked results.
   * @param spec - tokenizer and page bounds. @param request - requester and filters.
   * @returns exact corpus version after all preceding changes have been applied.
   */
  async snapshot(spec: TextSearchSpec, request: RetrievalRequest): Promise<string> {
    let corpus = this.corpus(spec, request)
    const startSeq = this.latest()
    const started = performance.now()
    let changedDuringBuild = false
    this.busy.set(corpus.key, (this.busy.get(corpus.key) ?? 0) + 1)
    try {
    for (;;) {
      request.signal?.throwIfAborted()
      if (performance.now() - started > spec.indexTimeoutMs) throw new MemoryError('index-not-ready', 'Text index synchronization exceeded its time budget; completed pages are saved, retry to continue')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (!corpus.ready) {
          const rows = this.db.prepare(`SELECT id FROM (
            SELECT id FROM l1_memories WHERE project=? AND id>?
            UNION SELECT id FROM knowledge_versions WHERE project=? AND state='active' AND id>?
            UNION SELECT v.id FROM knowledge_grants g JOIN knowledge_versions v ON v.id=g.id AND v.revision=g.revision
              WHERE v.state='active' AND v.level='L3' AND v.id>? AND v.project<>?
            ) ORDER BY id LIMIT ?`).all(request.projectId, corpus.cursor, request.projectId, corpus.cursor, corpus.cursor, request.projectId, spec.pageSize)
          for (const row of rows) this.update(corpus, request, String(row.id))
          this.db.prepare('UPDATE memory_text_corpora SET cursor=?,ready=? WHERE key=?').run(rows.length ? String(rows.at(-1)!.id) : corpus.cursor, Number(rows.length < spec.pageSize), corpus.key)
        } else {
          const rows = this.db.prepare('SELECT seq,id FROM memory_text_changes WHERE seq>? ORDER BY seq LIMIT ?').all(corpus.seq, spec.pageSize)
          const ids = new Set(rows.map(row => String(row.id)))
          const concurrent = new Set(rows.filter(row => Number(row.seq) > startSeq).map(row => String(row.id)))
          for (const id of ids) {
            const descendants = this.db.prepare(`WITH RECURSIVE affected(id) AS (SELECT ? UNION
              SELECT s.id FROM knowledge_selection_sources s JOIN affected a ON s.source_id=a.id)
              SELECT id FROM affected`).all(id)
            for (const descendant of descendants) {
              const ref = String(descendant.id)
              if (concurrent.has(id)
                && (this.document(request, ref) !== null || this.db.prepare('SELECT 1 FROM memory_text_entries WHERE corpus=? AND id=?').get(corpus.key, ref) !== undefined)) changedDuringBuild = true
              this.update(corpus, request, ref)
            }
          }
          if (rows.length) this.db.prepare('UPDATE memory_text_corpora SET seq=? WHERE key=?').run(Number(rows.at(-1)!.seq), corpus.key)
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      corpus = this.readCorpus(corpus.key)
      if (corpus.ready && corpus.seq === this.latest()) {
        this.db.prepare('DELETE FROM memory_text_changes WHERE seq <= (SELECT min(seq) FROM memory_text_corpora)').run()
        if (changedDuringBuild) throw new MemoryError('conflict', 'Memory changed while the text index was being synchronized; retry the query')
        return `${corpus.key}:${corpus.epoch}:${corpus.version}`
      }
      await yieldHost()
    }
    } finally {
      const remaining = this.busy.get(corpus.key)! - 1
      if (remaining === 0) this.busy.delete(corpus.key)
      else this.busy.set(corpus.key, remaining)
    }
  }

  /** @param spec - tokenizer and query budgets. @param request - requester. @returns indexed document count and readiness. */
  status(spec: TextSearchSpec, request: RetrievalRequest) {
    const corpus = this.corpus(spec, request)
    const candidates = Number(this.db.prepare('SELECT count(*) AS count FROM memory_text_entries WHERE corpus=?').get(corpus.key)!.count)
    return { method: 'bm25' as const, candidates, truncated: false, ready: Boolean(corpus.ready) && corpus.seq === this.latest() }
  }

  /** Read a fully synchronized corpus using a bounded number of ranked candidates.
   * @param spec - resolved budgets. @param request - authorized query. @param terms - validated literal words.
   * @returns exact references and the corpus version used for scoring.
   */
  async query(spec: TextSearchSpec, request: RetrievalRequest, terms: readonly string[]) {
    const start = performance.now()
    const fingerprint = await this.snapshot(spec, request)
    const queryStarted = performance.now()
    const key = fingerprint.split(':')[0]!
    const table = `memory_fts_${key}`
    const short = spec.tokenizer === 'trigram' ? terms.filter(term => Array.from(term).length < 3) : []
    const match = terms.filter(term => !short.includes(term)).map(term => `"${term}"`).join(' OR ')
    const rows: Array<{ row_id: number; rank?: number }> = match ? this.db.prepare(`SELECT rowid AS row_id,bm25(${table}) AS rank FROM ${table}
      WHERE ${table} MATCH ? ORDER BY rank,rowid LIMIT ?`).all(match, spec.maxCandidates + 1).map(row => ({ row_id: Number(row.row_id), rank: Number(row.rank) })) : []
    if (short.length) {
      const seen = new Set(rows.map(row => row.row_id))
      for (const row of this.db.prepare(`SELECT rowid AS row_id FROM ${table} WHERE ${short.map(() => 'instr(lower(body),lower(?))>0').join(' OR ')} ORDER BY rowid LIMIT ?`).all(...short, spec.maxCandidates + 1)) {
        if (!seen.has(Number(row.row_id))) rows.push({ row_id: Number(row.row_id) })
      }
    }
    request.signal?.throwIfAborted()
    if (performance.now() - queryStarted > spec.timeoutMs) throw new MemoryError('timeout', 'Text memory retrieval timed out')
    const hits: RetrievalHit[] = []
    let scanned = 0
    for (const row of rows) {
      request.signal?.throwIfAborted()
      if (performance.now() - queryStarted > spec.timeoutMs) throw new MemoryError('timeout', 'Text memory retrieval timed out')
      if (scanned === spec.maxCandidates) throw new MemoryError('budget', 'Matching memory candidates exceed the processing budget')
      scanned++
      const entry = this.db.prepare('SELECT id FROM memory_text_entries WHERE row_id=? AND corpus=?').get(row.row_id, key)
      if (entry === undefined) continue
      const document = this.document(request, String(entry.id))
      if (document === null) continue
      const memory = document.memory
      const hit: RetrievalHit = { ref: { id: memory.id, revision: memory.revision }, projectId: memory.projectId,
        shared: 'shared' in memory, text: document.text, similarity: null, ...row.rank === undefined ? {} : { score: -row.rank } }
      if (Buffer.byteLength(renderRecall([...hits, hit])) > (request.maxBytes ?? spec.maxBytes)) continue
      hits.push(hit)
      if (hits.length === (request.limit ?? spec.limit)) break
    }
    const result: RetrievalResult = { method: 'bm25', hits, text: renderRecall(hits), scanned, elapsedMs: performance.now() - start }
    const candidates = Number(this.db.prepare('SELECT count(*) AS count FROM memory_text_entries WHERE corpus=?').get(key)!.count)
    return { result, matched: rows.length > 0, fingerprint, candidates }
  }
}
