// @vitest-environment jsdom
/** Tool rows render only the recorded reference result in either locale. */
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemorySearchRow } from '../src/client/MemorySearchRow.tsx'
import type { ComponentProps } from 'react'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

it.each([en, zh])('shows readable version, evidence and summary from recorded results', dictionary => {
  const t: ComponentProps<typeof MemorySearchRow>['t'] = (key, args) => Object.entries(args ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
  const props = { phase: 'started', name: 'memory_search', block: { kind: 'tool-result', callId: 'search', isError: false,
    content: [{ type: 'text', text: JSON.stringify([{ id: 'memory-parser', revision: 2, level: 'L2', shared: false, evidenceStatus: 'model_supported', summary: 'Use the project parser flag.' }]) }] }, t } as ComponentProps<typeof MemorySearchRow>
  const ui = render(<MemorySearchRow {...props} />)
  fireEvent.click(ui.getByText(t('memorySearchResults', { count: 1 })))
  expect(ui.getByText('Use the project parser flag.')).toBeDefined()
  expect(ui.getByText(t('model_supported'))).toBeDefined()
  expect(ui.getByText(t('versionMetadata', { level: 'L2', revision: 2 }))).toBeDefined()
  ui.rerender(<MemorySearchRow {...props} block={{ ...props.block, isError: true }} />)
  expect(ui.getByText(t('memorySearchFailed'))).toBeDefined()
})
