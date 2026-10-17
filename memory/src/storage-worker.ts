/** Dedicated owner of all memory SQLite connections and transient full-text corpora. */
import { parentPort } from 'node:worker_threads'
import { SqliteMemory as Backend } from './sqlite-backend.ts'
import type { Spec } from './config.ts'
import { MemoryError } from './types.ts'
import { storageMethods, storageRequest, storageCancel } from './storage-protocol.ts'
import type { StorageFailure } from './storage-protocol.ts'

if (parentPort === null) throw new MemoryError('integration', 'Storage entry must run in its owning worker')
const port = parentPort
const databases = new Map<number, Backend>()
const tails = new Map<number, Promise<void>>()
const aborts = new Map<number, AbortController>()
port.on('message', (value: unknown) => {
  const cancellation = storageCancel.safeParse(value)
  if (cancellation.success) { aborts.get(cancellation.data.id)?.abort(new MemoryError('excluded', 'Storage request was cancelled')); return }
  const parsed = storageRequest.safeParse(value)
  if (!parsed.success) { port.close(); throw new MemoryError('integration', 'Invalid storage request') }
  const request = parsed.data
  const abort = new AbortController()
  aborts.set(request.id, abort)
  const work = (tails.get(request.database) ?? Promise.resolve()).then(async () => {
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
          const target = request.scope === 'database' ? database : database[request.scope]
          const method: unknown = Reflect.get(target, request.method)
          if (typeof method !== 'function') throw new MemoryError('integration', 'Storage operation is unavailable')
          const args = [...request.args]
          for (const index of request.signalArgs ?? []) {
            const argument = args[index]
            if (typeof argument !== 'object' || argument === null) throw new MemoryError('integration', 'Invalid cancellable storage argument')
            args[index] = { ...argument, signal: abort.signal }
          }
          abort.signal.throwIfAborted()
          if (request.scope === 'knowledge' && ['approveShare', 'revokeShare'].includes(request.method)) {
            const verified = args[1] === true
            args[1] = () => verified
          }
          result = await Reflect.apply(method, target, args)
          if (request.scope === 'database' && request.method === 'close') databases.delete(request.database)
      }
      port.postMessage({ kind: 'result', id: request.id, value: result })
    } catch (error) {
      const failure: StorageFailure = { code: error instanceof MemoryError ? error.code : 'storage',
        message: error instanceof MemoryError ? error.message : 'Storage operation failed; inspect the local database before retrying',
        ...error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? { errcode: error.errcode } : {} }
      port.postMessage({ kind: 'error', id: request.id, failure })
    } finally { aborts.delete(request.id) }
  })
  tails.set(request.database, work)
  void work.finally(() => { if (tails.get(request.database) === work) tails.delete(request.database) }).catch(() => undefined)
})
port.postMessage({ kind: 'ready' })
