/** Dedicated owner of all memory SQLite connections and transient full-text corpora. */
import { parentPort } from 'node:worker_threads'
import { SqliteMemory as Backend } from './sqlite-backend.ts'
import { TextMemoryRetriever as TextBackend } from './text-retrieval-backend.ts'
import type { Spec } from './config.ts'
import type { RetrievalRequest } from './retrieval.ts'
import type { TextSearchSpec } from './text-retrieval.ts'
import { MemoryError } from './types.ts'
import { storageMethods, storageRequest } from './storage-protocol.ts'
import type { StorageFailure } from './storage-protocol.ts'

if (parentPort === null) throw new MemoryError('integration', 'Storage entry must run in its owning worker')
const port = parentPort
const databases = new Map<number, Backend>()
let tail = Promise.resolve()
port.on('message', (value: unknown) => {
  const parsed = storageRequest.safeParse(value)
  if (!parsed.success) { port.close(); throw new MemoryError('integration', 'Invalid storage request') }
  const request = parsed.data
  tail = tail.then(async () => {
    try {
      let result: unknown
      if (request.scope === 'open') {
        if (request.method !== 'open' || request.args.length !== 1 || databases.has(request.database)) throw new MemoryError('integration', 'Invalid database open')
        const database = await Backend.open(request.args[0] as Spec)
        databases.set(request.database, database)
        database.onMemoryChange(() => port.postMessage({ kind: 'change', database: request.database }))
      } else {
        const database = databases.get(request.database)
        if (database === undefined) throw new MemoryError('closed', 'Storage database is unavailable')
        if (!storageMethods[request.scope].some(method => method === request.method)) throw new MemoryError('integration', 'Unknown storage operation')
        if (request.scope === 'database' && (request.method === 'textQuery' || request.method === 'textStatus')) {
          const [spec, query] = request.args as [TextSearchSpec, RetrievalRequest]
          const retriever = new TextBackend(database, { ...spec, expandQuery: false })
          try { result = request.method === 'textQuery' ? { result: await retriever.retrieve(query), matched: retriever.matched, fingerprint: retriever.fingerprint } : retriever.getIndexStatus(query.projectId) }
          finally { await retriever.close() }
        } else {
          const target = request.scope === 'database' ? database : database[request.scope]
          const method: unknown = Reflect.get(target, request.method)
          if (typeof method !== 'function') throw new MemoryError('integration', 'Storage operation is unavailable')
          const args = [...request.args]
          if (request.scope === 'knowledge' && ['approveShare', 'revokeShare'].includes(request.method)) {
            const verified = args[1] === true
            args[1] = () => verified
          }
          result = await Reflect.apply(method, target, args)
          if (request.scope === 'database' && request.method === 'close') databases.delete(request.database)
        }
      }
      port.postMessage({ kind: 'result', id: request.id, value: result })
    } catch (error) {
      const failure: StorageFailure = { code: error instanceof MemoryError ? error.code : 'storage',
        message: error instanceof MemoryError ? error.message : 'Storage operation failed; inspect the local database before retrying',
        ...error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? { errcode: error.errcode } : {} }
      port.postMessage({ kind: 'error', id: request.id, failure })
    }
  })
})
port.postMessage({ kind: 'ready' })
