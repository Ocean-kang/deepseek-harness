/** Historical migration fixtures retain only the objects shipped in the requested generation. */
import type { DatabaseSync } from 'node:sqlite'

/** Remove later-generation objects from an isolated fixture without changing retained records.
 * @param db - fixture-only connection with no active transactions.
 * @param version - released fixture generation.
 */
export function retainSchema(db: DatabaseSync, version: 1 | 2 | 3 | 4 | 5): void {
  const retained = new Set(['sessions', 'events', ...version >= 2 ? ['l1_scans', 'l1_tasks', 'l1_memories'] : [],
    ...version >= 3 ? ['knowledge_versions', 'knowledge_tasks', 'knowledge_operations', 'knowledge_share_actions', 'knowledge_grants'] : [],
    ...version >= 4 ? ['memory_vectors', 'memory_index_state', 'memory_generation'] : [], ...version >= 5 ? ['memory_selections'] : []])
  const triggers = new Set(version >= 4 ? ['memory_l1_insert', 'memory_knowledge_insert', 'memory_knowledge_update', 'memory_grant_insert', 'memory_grant_delete'] : [])
  const indexes = new Set(['sessions_project', ...version >= 2 ? ['l1_tasks_due'] : [],
    ...version >= 3 ? ['knowledge_current_id', 'knowledge_current_content'] : [], ...version >= 4 ? ['memory_knowledge_candidates'] : []])
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) {
    if (!triggers.has(String(row.name))) db.exec(`DROP TRIGGER "${String(row.name)}"`)
  }
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) {
    if (!indexes.has(String(row.name))) db.exec(`DROP INDEX "${String(row.name)}"`)
  }
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  for (const row of tables.filter(row => String(row.sql).includes('VIRTUAL TABLE'))) db.exec(`DROP TABLE "${String(row.name)}"`)
  for (const row of tables) if (!retained.has(String(row.name))) db.exec(`DROP TABLE IF EXISTS "${String(row.name)}"`)
  db.exec(`PRAGMA user_version = ${version}`)
}
