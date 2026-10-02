// @vitest-environment jsdom
/** User selection persists across level changes and failed saves retain visible records. */
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MemoryPanel } from '../src/client/MemoryPanel.tsx'
import type { MemoryPanelProps, PanelCall } from '../src/client/MemoryPanel.tsx'
import { zh } from '../src/client/locales.ts'
import type { PanelRequest, PanelResponse, PanelRow } from '../src/panel-protocol.ts'
import type { MemoryId, MemoryRef } from '../src/l1-types.ts'

afterEach(cleanup)
const l2: MemoryRef = { id: 'knowledge-l2' as MemoryId, revision: 2 }
const l3: MemoryRef = { id: 'knowledge-l3' as MemoryId, revision: 2 }
const row = (ref: MemoryRef, level: 'L2' | 'L3'): PanelRow => ({ level, title: level === 'L2' ? 'Project rule' : 'Long-term rule',
  body: ref.id === l2.id && ref.revision === 1 ? 'Historical memory text' : 'Exact memory text', projectId: 'project', shared: false,
  state: ref.id === l2.id && ref.revision === 1 ? 'superseded' : 'active', selectable: true, ref, sources: [] })
function mount(failSave = false, paginated = false, wrap: (call: PanelCall) => PanelCall = call => call) {
  const requests: PanelRequest[] = []
  let refs: MemoryRef[] = []
  let automatic = false
  const call: PanelCall = async (request, signal): Promise<PanelResponse> => {
    signal.throwIfAborted()
    requests.push(request)
    switch (request.action) {
      case 'browse':
        if (paginated) return { action: 'browse', rows: [{ ...row(request.after === null ? l2 : l3, 'L2'),
          title: `${request.query}: ${request.after === null ? 'first' : 'next'}` }],
          next: request.after === null ? { level: 'L2', id: l2.id } : null }
        return { action: 'browse', rows: request.level === 'L2' ? [row(l2, 'L2')] : request.level === 'L3' ? [row(l3, 'L3')] : [], next: null }
      case 'state': return { action: 'state', projectId: 'project', refs, automatic, injectionReady: true, valid: true, bytes: refs.length * 100, limit: 5, maxBytes: 8192,
        used: [{ turn: 1, refs: [l2], body: 'Committed historical reference' }] }
      case 'select':
        if (failSave) throw new Error('conflict')
        refs = request.refs
        automatic = request.automatic
        return { action: 'select', refs, automatic }
      case 'detail': return { action: 'detail', row: row(request.ref, request.ref.id === l2.id ? 'L2' : 'L3') }
      case 'history': return request.before > 2 ? { action: 'history', refs: [l2], next: 2 } : { action: 'history', refs: [{ ...l2, revision: 1 }], next: null }
    }
  }
  const controller = new AbortController()
  // The panel reads only the tab lifetime from the framework's larger tab-info result.
  const props = { sessionId: SessionId('panel-session'), useTabInfo: () => ({ tab: { signal: controller.signal } }), call: wrap(call),
    t: (key: keyof typeof zh, params?: Record<string, unknown>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key])),
  } as MemoryPanelProps
  return { view: render(<MemoryPanel {...props} />), requests, controller, props }
}

it('combines L2 and L3 choices, saves them for the next turn and displays the recorded recall', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: 'L3' }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /Long-term rule/ })).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: zh.apply }))
  await waitFor(() => expect(item.requests).toContainEqual({ action: 'select', sessionId: 'panel-session', refs: [l2, l3], automatic: false }))
  await waitFor(() => expect(item.view.getByText(/待注入 2 条/)).toBeDefined())
  expect(item.view.getByText('Committed historical reference')).toBeDefined()
  fireEvent.click(item.view.getByRole('button', { name: zh.cancel }))
  await waitFor(() => expect(item.view.getByText(/待注入 0 条/)).toBeDefined())
})

it('explains excluded historical conversations without showing an empty-memory message', async () => {
  const item = mount(false, false, () => async () => { throw new Error('excluded') })
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.excluded))
  expect(item.view.queryByText(zh.empty)).toBeNull()
  expect(item.view.getByRole('button', { name: zh.apply }).hasAttribute('disabled')).toBe(true)
})

it('pages the submitted search while edits remain pending and restarts a new search without the old cursor', async () => {
  const item = mount(false, true)
  await waitFor(() => expect(item.view.getByRole('button', { name: zh.more })).toBeDefined())
  const input = item.view.getByRole('textbox', { name: zh.search })
  fireEvent.change(input, { target: { value: 'alpha' } })
  fireEvent.click(item.view.getByRole('button', { name: zh.search }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /alpha: first/ })).toBeDefined())
  fireEvent.change(input, { target: { value: 'beta' } })
  fireEvent.click(item.view.getByRole('button', { name: zh.more }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /alpha: next/ })).toBeDefined())
  expect(item.requests.filter(request => request.action === 'browse').at(-1)).toEqual({
    action: 'browse', sessionId: 'panel-session', level: 'L2', query: 'alpha', after: { level: 'L2', id: l2.id },
  })
  fireEvent.click(item.view.getByRole('button', { name: zh.search }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /beta: first/ })).toBeDefined())
  expect(item.requests.filter(request => request.action === 'browse').at(-1)).toEqual({
    action: 'browse', sessionId: 'panel-session', level: 'L2', query: 'beta', after: null,
  })
  expect(item.view.queryByRole('button', { name: /alpha:/ })).toBeNull()
})

it('keeps the selected row and asks for reselection when the server rejects a changed version', async () => {
  const item = mount(true)
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: zh.apply }))
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.stale))
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(item.view.getByText('Exact memory text')).toBeDefined()
})

it('saves the automatic switch separately from an unsaved manual draft', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('switch', { name: zh.automatic }))
  await waitFor(() => expect(item.requests).toContainEqual({ action: 'select', sessionId: 'panel-session', refs: [], automatic: true }))
  await waitFor(() => expect(item.view.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
})

it('identifies the displayed historical version and its superseded state', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('button', { name: /Project rule/ })).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: /Project rule/ }))
  await waitFor(() => expect(item.view.getByRole('button', { name: zh.older })).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: zh.older }))
  await waitFor(() => expect(item.view.getByRole('button', { name: 'v1' })).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: 'v1' }))
  await waitFor(() => expect(item.view.getByText('Historical memory text')).toBeDefined())
  expect(item.view.getByText(/L2 · v1.*已替代/)).toBeDefined()
  expect(item.view.getByRole('button', { name: 'v1' }).getAttribute('aria-pressed')).toBe('true')
  expect(item.view.getByRole('button', { name: 'v2' }).getAttribute('aria-pressed')).toBe('false')
})

it('retains visible records after a failed reload and retries the read', async () => {
  let reads = 0
  const item = mount(false, false, call => async (request, signal) => {
    if (request.action === 'browse' && ++reads === 2) throw new Error('storage')
    return call(request, signal)
  })
  await waitFor(() => expect(item.view.getByText('Exact memory text')).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: zh.retry }))
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.failed))
  expect(item.view.getByText('Exact memory text')).toBeDefined()
  fireEvent.click(item.view.getByRole('button', { name: zh.retry }))
  await waitFor(() => expect(item.view.queryByRole('alert')).toBeNull())
  expect(reads).toBe(3)
})

it('cancels the previous Session read and ignores its late response after switching Sessions', async () => {
  let finish: (response: PanelResponse) => void = () => { throw new Error('read was not started') }
  const pending = new Promise<PanelResponse>(resolve => { finish = resolve })
  let previousSignal: AbortSignal | undefined
  const item = mount(false, false, call => async (request, signal) => {
    if (request.action === 'browse' && request.sessionId === 'panel-session') {
      previousSignal = signal
      return pending
    }
    if (request.action === 'browse') return { action: 'browse', rows: [{ ...row(l3, 'L3'), title: 'Second Session memory' }], next: null }
    return call(request, signal)
  })
  await waitFor(() => expect(previousSignal).toBeDefined())
  item.view.rerender(<MemoryPanel {...item.props} sessionId={SessionId('second-session')} />)
  await waitFor(() => expect(item.view.getByRole('button', { name: /Second Session memory/ })).toBeDefined())
  expect(previousSignal?.aborted).toBe(true)
  await act(async () => { finish({ action: 'browse', rows: [{ ...row(l2, 'L2'), title: 'Late first Session memory' }], next: null }); await pending })
  expect(item.view.queryByRole('button', { name: /Late first Session memory/ })).toBeNull()
  expect(item.view.getByRole('button', { name: /Second Session memory/ })).toBeDefined()
})
