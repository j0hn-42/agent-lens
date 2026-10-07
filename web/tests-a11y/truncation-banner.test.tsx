// The "Graph truncated" banner (#51): status role, readable text, native controls, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TruncationBanner } from '@/components/agent-visualizer/truncation-banner'
import { FOCUS_RING } from '@/lib/chrome-utils'
import { createStats, type NormalizationStats } from '@/lib/event-normalize'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const cut = (over: Partial<NormalizationStats> = {}): NormalizationStats =>
  ({ ...createStats(), ignoredEvents: 2, malformed: 1, droppedByCap: 4, clampedFields: 9, duplicateEvents: 5, ...over })

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('renders nothing unless events or nodes were really discarded (duplicates and clamping alone do not count)', () => {
  const none = render(<TruncationBanner stats={createStats()} onDismiss={noop} />)
  assert.equal(none.container.firstChild, null)
  none.unmount()
  const benign = render(<TruncationBanner stats={{ ...createStats(), clampedFields: 40, duplicateEvents: 40 }} onDismiss={noop} />)
  assert.equal(benign.container.firstChild, null)
})

test('is a status region whose text states the proven numbers (events = ignored + malformed, nodes = dropped by caps)', () => {
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const status = getByRole('status')
  assert.match(status.textContent ?? '', /Graph truncated: 3 events ignored, 4 nodes dropped/)
})

test('singular forms for a count of one', () => {
  const { getByRole } = render(<TruncationBanner stats={cut({ ignoredEvents: 1, malformed: 0, droppedByCap: 1 })} onDismiss={noop} />)
  assert.match(getByRole('status').textContent ?? '', /Graph truncated: 1 event ignored, 1 node dropped/)
})

test('the details disclosure is a native button that toggles aria-expanded and lists the counters by reason', () => {
  const { getByRole, getByLabelText } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const toggle = getByRole('button', { name: 'Details' })
  assert.equal(toggle.tagName, 'BUTTON')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  assert.ok(list, 'aria-controls points at the list')
  assert.equal(list.hidden, true)
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(list.hidden, false)
  const text = getByLabelText('Counters by reason').textContent ?? ''
  assert.match(text, /Events ignored[^:]*: 2/)
  assert.match(text, /Malformed inputs[^:]*: 1/)
  assert.match(text, /Nodes dropped[^:]*: 4/)
  assert.match(text, /Fields shortened or clamped: 9/)
  assert.match(text, /Duplicate events skipped: 5/)
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(list.hidden, true)
})

test('dismiss is a native named button that reports to the parent (which owns the per-session memory)', () => {
  let calls = 0
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={() => { calls++ }} />)
  const btn = getByRole('button', { name: 'Dismiss truncation warning' })
  assert.equal(btn.tagName, 'BUTTON')
  fireEvent.click(btn)
  assert.equal(calls, 1)
})

test('every control keeps a 24px target and a visible :focus-visible style', () => {
  const { getAllByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const buttons = getAllByRole('button')
  assert.equal(buttons.length, 2)
  for (const b of buttons) {
    assert.ok(b.className.includes('min-h-6') && b.className.includes('min-w-6'), `${b.textContent}: 24px target`)
    assert.ok(b.className.includes(FOCUS_RING), `${b.textContent}: focus-visible style`)
  }
})

test('the warning symbol is decorative: the meaning is in the words, not in a color or an icon', () => {
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const symbol = getByRole('status').querySelector('[aria-hidden="true"]')
  assert.ok(symbol)
  assert.match(getByRole('status').textContent ?? '', /truncated/i)
})

test('no axe violations, collapsed and expanded', async () => {
  const { container, getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  assert.deepEqual(await violations(container), [])
  fireEvent.click(getByRole('button', { name: 'Details' }))
  assert.deepEqual(await violations(container), [])
})
