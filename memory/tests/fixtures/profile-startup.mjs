/** Verify panel registration after the complete supported Web profile settles. */
import assert from 'node:assert/strict'

export const inject = ['memory', 'connection', 'webServer']
export function apply(ctx) {
  console.log('MEMORY_PROFILE_STARTUP_REGISTERED')
  ctx.effect(() => ctx.appReady.onReady(async () => {
    try {
      console.log('MEMORY_PROFILE_STARTUP_READY')
      const handler = ctx.connection.createSharedFetchHandler('/api')
      const call = body => handler.fetch(new Request('http://localhost/api/memory/panel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body,
      }))
      assert.equal((await call('not-json')).status, 400)
      assert.equal((await call('{}')).status, 400)
      assert.equal((await call(JSON.stringify({ type: 'client-request', rpcId: 'wrong', method: 'panel', payload: {} }))).status, 400)
      assert.equal((await handler.fetch(new Request('http://localhost/api/memory/panel', { method: 'POST', body: '{}' }))).status, 415)
      const response = await call(JSON.stringify({ type: 'client-request', rpcId: 'startup', method: 'memory/panel', payload: {} }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'startup',
        result: { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid memory panel request', details: {} } } })
      assert.equal(ctx.memory.browser.injectionReady, true)
      console.log('MEMORY_PROFILE_STARTUP_PASSED')
      ctx.appExit(0)
    } catch (error) { console.error(error); ctx.appExit(1) }
  }), 'memory.startup-check')
}
