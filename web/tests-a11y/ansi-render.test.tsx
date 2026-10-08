// ANSI colors of Bash output (#152): built spans, no raw code in the DOM, truncation and search on visible text.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TranscriptMessage } from '@/components/agent-visualizer/transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const E = '\x1b'
const result = (content: string, toolName = 'Bash'): ConversationMessage =>
  ({ id: 'r', type: 'tool_result', timestamp: 0, content: `< ${content}`, toolName })

test('Bash result: colors become styled spans and the text holds no code', () => {
  const { container } = render(<TranscriptMessage message={result(`${E}[34mℹ${E}[39m info\n${E}[1;31mFAIL${E}[0m`)} />)
  const spans = [...container.querySelectorAll('span[style]')]
  const blue = spans.find(s => s.textContent === 'ℹ') as HTMLElement
  assert.equal(blue.style.color, 'var(--ansi-4)')
  const fail = spans.find(s => s.textContent === 'FAIL') as HTMLElement
  assert.equal(fail.style.color, 'var(--ansi-1)')
  assert.equal(fail.style.fontWeight, '700')
  const text = container.textContent ?? ''
  assert.ok(text.includes('ℹ info\nFAIL'))
  assert.ok(!text.includes(E) && !/\[\d+m/.test(text))
})

test('lost ESC and cursor sequences leave nothing visible', () => {
  const { container } = render(<TranscriptMessage message={result(`[32mok${E}[2K${E}[0G[0m done`)} />)
  assert.ok((container.textContent ?? '').includes('ok done'))
  assert.ok(!/\[\d+m|\x1b/.test(container.textContent ?? ''))
})

test('no HTML injection: markup in the output stays text', () => {
  const { container } = render(<TranscriptMessage message={result(`${E}[31m<img src=x onerror=alert(1)><b>x</b>${E}[0m`)} />)
  assert.equal(container.querySelector('img'), null)
  assert.equal(container.querySelector('b'), null)
  assert.ok((container.textContent ?? '').includes('<img src=x onerror=alert(1)><b>x</b>'))
})

test('truncation counts visible characters and Show all restores the full colored text', () => {
  const long = `${E}[32m${'a'.repeat(900)}${E}[0m${'b'.repeat(900)}`
  const { container, getByRole } = render(<TranscriptMessage message={result(long)} />)
  const btn = getByRole('button')
  assert.match(btn.textContent ?? '', /Show all \(\+\d+ chars\)/)
  assert.ok(!(container.textContent ?? '').includes(E))
  fireEvent.click(btn)
  assert.equal([...container.querySelectorAll('span[style]')].some(s => (s.textContent ?? '').length === 900), true)
  assert.ok((container.textContent ?? '').includes('b'.repeat(900)))
})

test('search highlight works inside colored text', () => {
  const { container } = render(<TranscriptMessage message={result(`${E}[33mwarning: disk${E}[0m`)} searchQuery="disk" />)
  assert.equal(container.querySelector('mark')?.textContent, 'disk')
})

test('non-Bash results are not interpreted', () => {
  const { container } = render(<TranscriptMessage message={result(`${E}[31mx`, 'Read')} />)
  assert.equal(container.querySelectorAll('span[style]').length, 0)
})

test('axe: colored result has no violation', async () => {
  const { container } = render(<TranscriptMessage message={result(`${E}[31mred${E}[0m ${E}[4mu${E}[0m`)} />)
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
  assert.deepEqual(r.violations, [])
})
