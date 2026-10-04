// @vitest-environment jsdom
/** User selection persists across level changes and failed saves retain visible records. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { MemoryPanel } from '../src/client/MemoryPanel.tsx'
import { PendingMemory } from '../src/client/PendingMemory.tsx'
import type { PendingMemoryProps } from '../src/client/PendingMemory.tsx'
import type { MemoryPanelProps, PanelCall } from '../src/client/MemoryPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { createPanelStateObserver } from '../src/client/state-observer.ts'
import type { PanelRequest, PanelResponse, PanelRow } from '../src/panel-protocol.ts'
import type { MemoryId, MemoryRef } from '../src/l1-types.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const l2: MemoryRef = { id: 'knowledge-l2' as MemoryId, revision: 2 }
const l3: MemoryRef = { id: 'knowledge-l3' as MemoryId, revision: 2 }
const row = (ref: MemoryRef, level: 'L2' | 'L3'): PanelRow => ({ level, title: level === 'L2' ? 'Project rule' : 'Long-term rule',
  body: ref.id === l2.id && ref.revision === 1 ? 'Historical memory text' : 'Exact memory text', projectId: 'project', shared: false,
  state: ref.id === l2.id && ref.revision === 1 ? 'superseded' : 'active', selectable: true, ref, sources: [],
  sections: [{ label: 'experience', text: ref.revision === 1 ? 'Historical memory text' : 'Exact memory text' }],
  description: null, outcome: null, sourceStatus: 'current', trust: null, generation: null, raw: null })
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
        pending: refs.map(ref => row(ref, ref.id === l2.id ? 'L2' : 'L3')), revision: 'initial', refreshIntervalMs: 3000, recallMethod: 'trigram',
        learning: { enabled: true, pending: 0, running: 0, failed: 0, generated: 2 },
        used: [{ turn: 1, refs: [l2], body: 'Committed historical reference' }] }
      case 'select':
        if (failSave) throw new Error('conflict')
        refs = request.refs
        automatic = request.automatic
        return { action: 'select', refs, automatic }
      case 'automatic':
        automatic = request.automatic
        return { action: 'automatic', refs, automatic }
      case 'detail': return { action: 'detail', row: row(request.ref, request.ref.id === l2.id ? 'L2' : 'L3') }
      case 'history': return request.before > 2 ? { action: 'history', refs: [l2], next: 2 } : { action: 'history', refs: [{ ...l2, revision: 1 }], next: null }
    }
  }
  const controller = new AbortController()
  const observer = createPanelStateObserver(wrap(call))
  // The panel reads only the tab lifetime from the framework's larger tab-info result.
  const props = { sessionId: SessionId('panel-session'), useTabInfo: () => ({ tab: { signal: controller.signal } }),
    call: observer.call, watch: observer.watch, refresh: observer.refresh,
    t: (key: keyof typeof zh, params?: Record<string, unknown>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key])),
  } as MemoryPanelProps
  return { view: render(<MemoryPanel {...props} />), requests, controller, props, observer }
}

it('combines L2 and L3 choices, saves them for the next turn and displays the recorded recall', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: 'L3' }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: Long-term rule/ })).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: zh.applySelection }))
  await waitFor(() => expect(item.requests).toContainEqual({ action: 'select', sessionId: 'panel-session', refs: [l2, l3], automatic: false }))
  await waitFor(() => expect(item.view.getByText(/待注入 2 条/)).toBeDefined())
  expect(item.view.getByText('Committed historical reference')).toBeDefined()
  fireEvent.click(item.view.getByRole('button', { name: zh.cancel }))
  await waitFor(() => expect(item.view.getByText(/待注入 0 条/)).toBeDefined())
})

it('places each selection control before its memory title and keeps insertion as a separate action', async () => {
  const item = mount()
  const checkbox = await item.view.findByRole('checkbox', { name: zh.select })
  const card = checkbox.closest('article')!
  const heading = within(card).getByRole('button', { name: /查看正文与来源: Project rule/ })
  expect(checkbox.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(checkbox.closest('label')?.getAttribute('title')).toBe('选择记忆：Project rule')
  fireEvent.click(checkbox)
  expect(item.requests.some(request => request.action === 'select')).toBe(false)
  fireEvent.click(item.view.getByRole('button', { name: zh.applySelection }))
  await waitFor(() => expect(item.view.getByText(/待注入 1 条/)).toBeDefined())
  expect(item.requests.filter(request => request.action === 'select')).toEqual([
    { action: 'select', sessionId: 'panel-session', refs: [l2], automatic: false },
  ])
})

it('shows one-sentence L1–L3 descriptions and opens full text and folded JSON in detail', async () => {
  const sentence = 'Use a dedicated workspace for each project to preserve its memory'
  const item = mount(false, false, call => async (request, signal) => {
    if (request.action === 'browse' && request.level === 'L1') return { action: 'browse', next: null,
      rows: [{ ...row(l2, 'L2'), level: 'L1', selectable: false, description: sentence }] }
    const response = await call(request, signal)
    if (response.action === 'browse') return { ...response, rows: response.rows.map(row => ({ ...row, description: sentence })) }
    if (response.action === 'detail' && response.row !== null) return { ...response,
      row: { ...response.row, description: sentence, raw: '{"knowledge":{"body":"Exact memory text"}}' } }
    return response
  })
  await waitFor(() => expect(item.view.getByText(sentence)).toBeDefined())
  expect(item.view.queryByText('Exact memory text')).toBeNull()
  fireEvent.click(item.view.getByRole('button', { name: 'L1' }))
  await waitFor(() => expect(item.view.getByText(zh.readOnly)).toBeDefined())
  await waitFor(() => expect(item.view.getByText(sentence)).toBeDefined())
  expect(item.view.queryByRole('checkbox')).toBeNull()
  expect(item.view.queryByText('Exact memory text')).toBeNull()
  fireEvent.click(item.view.getByRole('button', { name: 'L3' }))
  await waitFor(() => expect(item.view.getByText(sentence)).toBeDefined())
  expect(item.view.getByRole('checkbox')).toBeDefined()
  expect(item.view.queryByText('Exact memory text')).toBeNull()
  fireEvent.click(item.view.getByRole('button', { name: /查看正文与来源: Long-term rule/ }))
  await waitFor(() => expect(item.view.getByText('Exact memory text')).toBeDefined())
  expect(item.view.getAllByText(sentence)).toHaveLength(2)
  expect(item.view.getByText('{"knowledge":{"body":"Exact memory text"}}').closest('details')?.hasAttribute('open')).toBe(false)
})

it('explains excluded historical conversations without showing an empty-memory message', async () => {
  const item = mount(false, false, () => async () => { throw new Error('excluded') })
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.excluded))
  expect(item.view.queryByText(zh.empty)).toBeNull()
  expect(item.view.getByRole('button', { name: zh.applySelection }).hasAttribute('disabled')).toBe(true)
})

it('pages the submitted search while edits remain pending and restarts a new search without the old cursor', async () => {
  const item = mount(false, true)
  await waitFor(() => expect(item.view.getByRole('button', { name: zh.more })).toBeDefined())
  const input = item.view.getByRole('textbox', { name: zh.search })
  fireEvent.change(input, { target: { value: 'alpha' } })
  fireEvent.click(item.view.getByRole('button', { name: zh.search }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: alpha: first/ })).toBeDefined())
  fireEvent.change(input, { target: { value: 'beta' } })
  fireEvent.click(item.view.getByRole('button', { name: zh.more }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: alpha: next/ })).toBeDefined())
  expect(item.requests.filter(request => request.action === 'browse').at(-1)).toEqual({
    action: 'browse', sessionId: 'panel-session', level: 'L2', query: 'alpha', after: { level: 'L2', id: l2.id },
  })
  fireEvent.click(item.view.getByRole('button', { name: zh.search }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: beta: first/ })).toBeDefined())
  expect(item.requests.filter(request => request.action === 'browse').at(-1)).toEqual({
    action: 'browse', sessionId: 'panel-session', level: 'L2', query: 'beta', after: null,
  })
  expect(item.view.queryByRole('button', { name: /alpha:/ })).toBeNull()
})

it('keeps the selected row and asks for reselection when the server rejects a changed version', async () => {
  const item = mount(true)
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: zh.applySelection }))
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.stale))
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(item.view.getByText('Exact memory text')).toBeDefined()
})

it('saves the automatic switch separately from an unsaved manual draft', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('switch', { name: zh.automatic }))
  await waitFor(() => expect(item.requests).toContainEqual({ action: 'automatic', sessionId: 'panel-session', automatic: true }))
  await waitFor(() => expect(item.view.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
})

it('turns recall off while an invalid saved manual choice remains visible', async () => {
  let automatic = true
  const requests: PanelRequest[] = []
  const item = mount(false, false, call => async (request, signal) => {
    requests.push(request)
    if (request.action === 'automatic') { automatic = request.automatic; return { action: 'automatic', refs: [l2], automatic } }
    if (request.action === 'select') throw new Error('conflict')
    const response = await call(request, signal)
    return response.action === 'state' ? { ...response, automatic, refs: [l2], valid: false, pending: [row(l2, 'L2')] } : response
  })
  await waitFor(() => expect(item.view.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('switch'))
  await waitFor(() => expect(item.view.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
  expect(requests).toContainEqual({ action: 'automatic', sessionId: 'panel-session', automatic: false })
  expect(item.view.queryByRole('alert')).toBeNull()
  expect(item.view.getByText(zh.stale)).toBeDefined()
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})

it('adds one row to pending memory without clearing another unsaved choice', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('checkbox')).toBeDefined())
  fireEvent.click(item.view.getByRole('checkbox'))
  fireEvent.click(item.view.getByRole('button', { name: 'L3' }))
  await waitFor(() => expect(item.view.getByRole('button', { name: '加入下一轮：Long-term rule' })).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: '加入下一轮：Long-term rule' }))
  await waitFor(() => expect(item.view.getByText(/待注入 1 条/)).toBeDefined())
  expect(item.requests.filter(request => request.action === 'select')).toEqual([
    { action: 'select', sessionId: 'panel-session', refs: [l3], automatic: false },
  ])
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(item.view.getByText('已选择 2 条')).toBeDefined()
  fireEvent.click(item.view.getByRole('button', { name: 'L2' }))
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: Project rule/ })).toBeDefined())
  expect((item.view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(item.view.getByRole('button', { name: zh.applySelection }))
  await waitFor(() => expect(item.view.getByText(/待注入 2 条/)).toBeDefined())
  expect(item.requests.filter(request => request.action === 'select').at(-1)).toEqual({
    action: 'select', sessionId: 'panel-session', refs: [l2, l3], automatic: false,
  })
})

it('identifies the displayed historical version and its superseded state', async () => {
  const item = mount()
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: Project rule/ })).toBeDefined())
  fireEvent.click(item.view.getByRole('button', { name: /查看正文与来源: Project rule/ }))
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
  await waitFor(() => expect(item.view.getByRole('button', { name: /查看正文与来源: Second Session memory/ })).toBeDefined())
  expect(previousSignal?.aborted).toBe(true)
  await act(async () => { finish({ action: 'browse', rows: [{ ...row(l2, 'L2'), title: 'Late first Session memory' }], next: null }); await pending })
  expect(item.view.queryByRole('button', { name: /Late first Session memory/ })).toBeNull()
  expect(item.view.getByRole('button', { name: /查看正文与来源: Second Session memory/ })).toBeDefined()
})

it('shows trust and raw JSON in detail while saving a row directly into the separate pending area', async () => {
  const item = mount(false, false, call => async (request, signal) => {
    const response = await call(request, signal)
    if (response.action === 'detail' && response.row !== null) return { ...response, row: { ...response.row,
      trust: { score: 4, scoreMin: 0, scoreMax: 5, evidence: 'unverified', rationale: 'Needs external confirmation', category: 'constraint' },
      raw: '{"score":4}',
    } }
    return response
  })
  await waitFor(() => expect(item.view.getByRole('button', { name: '加入下一轮：Project rule' })).toBeDefined())
  expect(item.view.queryByText('Needs external confirmation')).toBeNull()
  fireEvent.click(item.view.getByRole('button', { name: /查看正文与来源: Project rule/ }))
  await waitFor(() => expect(item.view.getByText('Needs external confirmation')).toBeDefined())
  expect(item.view.getByText(zh.unverified)).toBeDefined()
  expect(item.view.getByText('{"score":4}').closest('details')?.hasAttribute('open')).toBe(false)
  fireEvent.click(item.view.getByRole('button', { name: '加入下一轮：Project rule' }))
  await waitFor(() => expect(item.view.getByText(/待注入 1 条/)).toBeDefined())
  expect(item.requests).toContainEqual({ action: 'select', sessionId: 'panel-session', refs: [l2], automatic: false })
  expect(item.view.getAllByText('Exact memory text')).toHaveLength(3)
})

it('refreshes completed extraction without losing submitted search, loaded pages, detail, scroll or an unsaved draft', async () => {
  vi.useFakeTimers()
  let generation = 'before'
  const item = mount(false, true, call => async (request, signal) => {
    const response = await call(request, signal)
    return response.action === 'state' ? { ...response, revision: generation, refreshIntervalMs: 100,
      learning: { enabled: true, pending: 0, running: generation === 'before' ? 1 : 0, failed: 0, generated: generation === 'before' ? 2 : 3 } } : response
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => {
    fireEvent.change(item.view.getByRole('textbox'), { target: { value: 'Exact' } })
    fireEvent.click(item.view.getByRole('button', { name: zh.search }))
  })
  await act(async () => { fireEvent.click(item.view.getByRole('button', { name: zh.more })) })
  fireEvent.click(item.view.getAllByRole('checkbox')[0]!)
  await act(async () => { fireEvent.click(item.view.getByRole('button', { name: /查看正文与来源: Exact: first/ })) })
  fireEvent.change(item.view.getByRole('textbox'), { target: { value: 'unsent draft query' } })
  const scroller = item.view.container.querySelector('[aria-busy]')!
  scroller.scrollTop = 120
  generation = 'after'
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(item.view.getByText('项目累计已生成 3 条记忆')).toBeDefined()
  expect(item.view.queryByText(/正在提炼/)).toBeNull()
  expect(item.view.getByRole('textbox').getAttribute('value')).toBe('unsent draft query')
  expect(item.view.getByRole('button', { name: /查看正文与来源: Exact: next/ })).toBeDefined()
  expect(item.view.getByRole('button', { name: zh.close })).toBeDefined()
  expect((item.view.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true)
  expect(scroller.scrollTop).toBe(120)
  expect(item.requests.filter(request => request.action === 'browse').slice(-2)).toMatchObject([{ query: 'Exact', after: null }, { query: 'Exact', after: { level: 'L2' } }])
  expect(item.view.container.querySelector('mark')?.textContent).toBe('Exact')
  const reads = item.requests.length
  item.view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(item.requests.length).toBe(reads)
})

it('shows failed extraction alongside generated counts and disables stale derived selection', async () => {
  const item = mount(false, false, call => async (request, signal) => {
    const response = await call(request, signal)
    if (response.action === 'browse') return { ...response, rows: response.rows.map(row => ({ ...row, sourceStatus: 'needs-review', selectable: false })) }
    return response.action === 'state' ? { ...response, learning: { ...response.learning, failed: 1 } } : response
  })
  await waitFor(() => expect(item.view.getByText('提炼失败 · 1 个项目任务')).toBeDefined())
  expect(item.view.getByText('项目累计已生成 2 条记忆')).toBeDefined()
  expect(item.view.getByText(zh.needsReview)).toBeDefined()
  expect(item.view.queryByRole('checkbox')).toBeNull()
})

it('keeps the visible card at the same offset when a refresh inserts earlier cards and replaces its revision', async () => {
  vi.useFakeTimers()
  let generation = 'before'
  const earlier: MemoryRef = { id: 'knowledge-a' as MemoryId, revision: 1 }
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const scroller = this.closest('[aria-busy]')
    if (this.hasAttribute('data-row-key') && scroller !== null) {
      const index = [...scroller.querySelectorAll('[data-row-key]')].indexOf(this)
      return new DOMRect(0, index * 80 - scroller.scrollTop, 400, 80)
    }
    return new DOMRect(0, 0, 400, 200)
  })
  try {
    const item = mount(false, true, call => async (request, signal) => {
      const response = await call(request, signal)
      if (response.action === 'state') return { ...response, revision: generation, refreshIntervalMs: 100 }
      if (response.action === 'browse' && request.action === 'browse' && generation === 'after') {
        if (request.after === null) return { ...response, rows: [row(earlier, 'L2')], next: { level: 'L2', id: earlier.id } }
        if (request.after.level !== 'L0' && request.after.id === earlier.id) {
          return { ...response, rows: [row(l2, 'L2')], next: { level: 'L2', id: l2.id } }
        }
        return { ...response, rows: [row({ ...l3, revision: 3 }, 'L2')], next: null }
      }
      return response
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(item.view.getByRole('button', { name: zh.more })) })
    const scroller = item.view.container.querySelector('[aria-busy]')!
    scroller.scrollTop = 95
    const visible = (): Element => item.view.container.querySelector(`[data-row-key="${l3.id}"]`)!
    expect(visible().getBoundingClientRect().top).toBe(-15)
    generation = 'after'
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(item.view.container.querySelectorAll('[data-row-key]')).toHaveLength(3)
    expect(item.view.getByText(/L2 · v3/)).toBeDefined()
    expect(scroller.scrollTop).toBe(175)
    expect(visible().getBoundingClientRect().top).toBe(-15)
    item.view.unmount()
  } finally { geometry.mockRestore() }
})

it('keeps the visible L0 event when newly captured earlier sessions add a refresh page', async () => {
  vi.useFakeTimers()
  let generation = 'before'
  const eventRow = (sessionId: string, seq: number): PanelRow => ({ ...row(l2, 'L2'), level: 'L0', ref: null,
    title: `${sessionId} #${seq}`, selectable: false, sources: [{ kind: 'event', sessionId: SessionId(sessionId), seq: SessionSeq(seq) }] })
  const prior = [eventRow('session-b', 1), eventRow('session-b', 2)]
  const updated = [eventRow('session-a', 1), ...prior, eventRow('session-b', 3)]
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const scroller = this.closest('[aria-busy]')
    if (this.hasAttribute('data-row-key') && scroller !== null) {
      const index = [...scroller.querySelectorAll('[data-row-key]')].indexOf(this)
      return new DOMRect(0, index * 80 - scroller.scrollTop, 400, 80)
    }
    return new DOMRect(0, 0, 400, 200)
  })
  try {
    const item = mount(false, false, call => async (request, signal) => {
      if (request.action === 'browse' && request.level === 'L0') {
        const rows = generation === 'before' ? prior : updated
        const after = request.after
        const index = after?.level === 'L0'
          ? rows.findIndex(row => row.sources.some(source => source.kind === 'event' && source.sessionId === after.sessionId && source.seq === after.seq)) + 1
          : 0
        const current = rows[index]!
        const source = current.sources[0]!
        if (source.kind !== 'event') throw new Error('Expected an L0 event source')
        return { action: 'browse', rows: [current], next: index < rows.length - 1
          ? { level: 'L0', sessionId: source.sessionId, seq: source.seq } : null }
      }
      const response = await call(request, signal)
      return response.action === 'state' ? { ...response, revision: generation, refreshIntervalMs: 100 } : response
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(item.view.getByRole('button', { name: 'L0' })) })
    await act(async () => { fireEvent.click(item.view.getByRole('button', { name: zh.more })) })
    const scroller = item.view.container.querySelector('[aria-busy]')!
    scroller.scrollTop = 95
    const visible = (): Element => [...item.view.container.querySelectorAll('[data-row-key]')].find(row => row.textContent?.includes('session-b #2'))!
    expect(visible().getBoundingClientRect().top).toBe(-15)
    generation = 'after'
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(item.view.container.querySelectorAll('[data-row-key]')).toHaveLength(3)
    expect(scroller.scrollTop).toBe(175)
    expect(visible().getBoundingClientRect().top).toBe(-15)
    expect(item.view.queryByRole('button', { name: /查看正文与来源: session-b #3/ })).toBeNull()
    item.view.unmount()
  } finally { geometry.mockRestore() }
})

it('retries automatic browsing after a refresh fails without another memory generation', async () => {
  vi.useFakeTimers()
  let generation = 'before'
  let reads = 0
  const item = mount(false, false, call => async (request, signal) => {
    if (request.action === 'browse' && ++reads === 2) throw new Error('storage')
    const response = await call(request, signal)
    if (response.action === 'state') return { ...response, revision: generation, refreshIntervalMs: 100 }
    if (response.action === 'browse') return { ...response, rows: response.rows.map(row => ({ ...row, title: generation })) }
    return response
  })
  await act(async () => { await Promise.resolve() })
  generation = 'after'
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(item.view.getByRole('alert').textContent).toBe(zh.failed)
  expect(item.view.getByRole('button', { name: /查看正文与来源: before/ })).toBeDefined()
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(item.view.queryByRole('alert')).toBeNull()
  expect(item.view.getByRole('button', { name: /查看正文与来源: after/ })).toBeDefined()
  expect(reads).toBe(3)
})

it('reminds the composer about saved memory, then replaces pending content with its committed admission receipt', async () => {
  vi.useFakeTimers()
  let used = false
  const requests: PanelRequest[] = []
  const call: PanelCall = async (request, signal) => {
    signal.throwIfAborted()
    requests.push(request)
    return { action: 'state', projectId: 'project', refs: used ? [] : [l2], automatic: true, injectionReady: true, valid: true,
      bytes: used ? 0 : 100, limit: 5, maxBytes: 8192, pending: used ? [] : [row(l2, 'L2')],
      used: used ? [{ turn: 2, refs: [l2], body: 'Committed exact context' }] : [],
      revision: used ? 'used' : 'pending', refreshIntervalMs: 100, recallMethod: 'trigram',
      learning: { enabled: true, pending: 0, running: 0, failed: 0, generated: 1 } }
  }
  const observer = createPanelStateObserver(call)
  const t: PendingMemoryProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key]))
  const view = render(<PendingMemory sessionId={SessionId('composer-session')} t={t} watch={observer.watch} />)
  await act(async () => { await Promise.resolve() })
  expect(view.getByText('下一轮待用 1 条记忆 · 100/8192 字节')).toBeDefined()
  expect(view.getByText('Exact memory text')).toBeDefined()
  used = true
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(view.queryByText(/下一轮待用 1 条/)).toBeNull()
  expect(view.getByText('第 2 轮已送入模型上下文 1 条记忆')).toBeDefined()
  expect(view.getByText('Committed exact context')).toBeDefined()
  view.unmount()
  const count = requests.length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(requests).toHaveLength(count)
})

it('shares one state poll between the sidebar and composer and continues until both unmount', async () => {
  vi.useFakeTimers()
  const item = mount(false, false, call => async (request, signal) => {
    const response = await call(request, signal)
    return response.action === 'state' ? { ...response, refreshIntervalMs: 100 } : response
  })
  const composer = render(<PendingMemory sessionId={item.props.sessionId} t={item.props.t} watch={item.props.watch} />)
  await act(async () => { await Promise.resolve() })
  expect(item.requests.filter(request => request.action === 'state')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(item.requests.filter(request => request.action === 'state')).toHaveLength(2)
  item.view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(item.requests.filter(request => request.action === 'state')).toHaveLength(3)
  composer.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(item.requests.filter(request => request.action === 'state')).toHaveLength(3)
})

it('retries an initial state failure from the sidebar without requiring a polling interval', async () => {
  let states = 0
  const item = mount(false, false, call => async (request, signal) => {
    if (request.action === 'state' && ++states === 1) throw new Error('storage')
    return call(request, signal)
  })
  await waitFor(() => expect(item.view.getByRole('alert').textContent).toBe(zh.failed))
  fireEvent.click(item.view.getByRole('button', { name: zh.retry }))
  await waitFor(() => expect(item.view.getByText('Exact memory text')).toBeDefined())
  expect(item.view.queryByRole('alert')).toBeNull()
  expect(states).toBe(2)
})

it('retries an initial state failure from the composer without requiring a polling interval', async () => {
  let states = 0
  const observer = createPanelStateObserver(async () => {
    if (++states === 1) throw new Error('storage')
    return { action: 'state', projectId: 'project', refs: [l2], automatic: false, injectionReady: true, valid: true,
      bytes: 100, limit: 5, maxBytes: 8192, pending: [row(l2, 'L2')], used: [], revision: 'retry', refreshIntervalMs: 100,
      recallMethod: 'trigram', learning: { enabled: true, pending: 0, running: 0, failed: 0, generated: 1 } }
  })
  const t: PendingMemoryProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key]))
  const view = render(<PendingMemory sessionId={SessionId('retry-session')} t={t} watch={observer.watch} />)
  await waitFor(() => expect(view.getByRole('status').textContent).toContain(zh.failed))
  fireEvent.click(view.getByRole('button', { name: zh.retry }))
  await waitFor(() => expect(view.getByText('Exact memory text')).toBeDefined())
  expect(view.queryByRole('status')).toBeNull()
  expect(states).toBe(2)
})
