// The "Graph truncated" banner (#51): status role, readable text, native controls, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TruncationBanner, TruncationAnnouncer } from '@/components/agent-visualizer/truncation-banner'
import { FOCUS_RING } from '@/lib/focus-ring'
import { createStats, type NormalizationStats } from '@/lib/event-normalize'
import { setLocaleChoice } from '@/lib/locale'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
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

test('is a named group (not a live region of its own) whose text states the proven numbers (events = ignored + malformed, nodes = dropped by caps)', () => {
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const status = getByRole('group', { name: 'Graph truncation' })
  assert.match(status.textContent ?? '', /Graph truncated: 3 events ignored, 4 nodes dropped/)
})

test('singular forms for a count of one', () => {
  const { getByRole } = render(<TruncationBanner stats={cut({ ignoredEvents: 1, malformed: 0, droppedByCap: 1 })} onDismiss={noop} />)
  assert.match(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /Graph truncated: 1 event ignored, 1 node dropped/)
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
  const symbol = getByRole('group', { name: 'Graph truncation' }).querySelector('[aria-hidden="true"]')
  assert.ok(symbol)
  assert.match(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /truncated/i)
})

test('no axe violations, collapsed and expanded', async () => {
  const { container, getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  assert.deepEqual(await violations(container), [])
  fireEvent.click(getByRole('button', { name: 'Details' }))
  assert.deepEqual(await violations(container), [])
})

test('updates the reader did not read (OpenCode, #420) have their own counter and label: never "events ignored"', () => {
  const { getByRole, getByLabelText, rerender } = render(<TruncationBanner stats={{ ...createStats(), missedUpdates: 2 }} onDismiss={noop} />)
  const group = getByRole('group', { name: 'Graph truncation' })
  assert.match(group.textContent ?? '', /Graph truncated: 0 events ignored, 0 nodes dropped, at least 2 updates not read/)
  fireEvent.click(getByRole('button', { name: 'Details' }))
  const text = getByLabelText('Counters by reason').textContent ?? ''
  assert.match(text, /Updates not read \(lower bound\): 2/)
  assert.match(text, /Events ignored[^:]*: 0/)
  rerender(<TruncationBanner stats={{ ...createStats(), missedUpdates: 1 }} onDismiss={noop} />)
  assert.match(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /at least 1 update not read/)
  rerender(<TruncationBanner stats={cut()} onDismiss={noop} />)
  assert.doesNotMatch(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /not read/, 'said only when there is one')
})

test('the notice is in the language of the interface (#247): French, with the same counters', () => {
  setLocaleChoice('fr')
  const { getByRole, getByLabelText } = render(<TruncationBanner stats={cut({ missedUpdates: 2 })} replayLost={5} onDismiss={noop} />)
  const group = getByRole('group', { name: 'Troncature du graphe' })
  const text = group.textContent ?? ''
  assert.match(text, /Graphe tronqué : 3 événements ignorés, 4 nœuds supprimés, au moins 2 mises à jour non lues/)
  assert.match(text, /au moins 5 événements antérieurs n’ont pas été rejoués par le relais/)
  fireEvent.click(getByRole('button', { name: 'Détails' }))
  const details = getByLabelText('Compteurs par cause').textContent ?? ''
  assert.match(details, /Mises à jour non lues \(borne basse\) : 2/)
  assert.ok(getByRole('button', { name: 'Fermer l’avertissement de troncature' }))
})

test('events the relay could not replay show on their own, as "at least" (#366)', () => {
  const { getByRole } = render(<TruncationBanner stats={createStats()} replayLost={40} onDismiss={noop} />)
  const text = getByRole('group', { name: 'Graph truncation' }).textContent ?? ''
  assert.match(text, /Graph incomplete: at least 40 earlier events were not replayed by the relay/)
  assert.doesNotMatch(text, /Graph truncated/)
})

test('both causes are named when both apply; a replay loss of one is singular', () => {
  const { getByRole, rerender } = render(<TruncationBanner stats={cut()} replayLost={5} onDismiss={noop} />)
  const text = getByRole('group', { name: 'Graph truncation' }).textContent ?? ''
  assert.match(text, /Graph truncated: 3 events ignored, 4 nodes dropped/)
  assert.match(text, /at least 5 earlier events were not replayed by the relay/)
  rerender(<TruncationBanner stats={createStats()} replayLost={1} onDismiss={noop} />)
  assert.match(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /at least 1 earlier event was not replayed by the relay/)
})

test('a replay loss that is not a positive safe integer renders nothing', () => {
  for (const bad of [0, -3, Number.NaN, 1.5, Infinity]) {
    const { container, unmount } = render(<TruncationBanner stats={createStats()} replayLost={bad} onDismiss={noop} />)
    assert.equal(container.firstChild, null, String(bad))
    unmount()
  }
})

test('dismissing hands the focus to a stable element instead of dropping it on the page (WCAG 2.4.3, #366)', () => {
  const { getByRole } = render(
    <div>
      <button id="stable-target" type="button">Sessions</button>
      <TruncationBanner stats={cut()} returnFocusId="stable-target" onDismiss={noop} />
    </div>,
  )
  const dismiss = getByRole('button', { name: 'Dismiss truncation warning' })
  dismiss.focus()
  fireEvent.click(dismiss)
  assert.equal(document.activeElement?.id, 'stable-target')
})

test('dismissing without a target (or with a missing one) still just reports to the parent', () => {
  let calls = 0
  const { getByRole } = render(<TruncationBanner stats={cut()} returnFocusId="nope" onDismiss={() => { calls++ }} />)
  fireEvent.click(getByRole('button', { name: 'Dismiss truncation warning' }))
  assert.equal(calls, 1)
})

test('the announcer is a stable live region: empty when hidden, one fixed sentence when shown (numbers do not re-announce)', () => {
  const { container, rerender } = render(<TruncationAnnouncer shown={false} />)
  const region = () => container.querySelector('[role="status"]')!
  assert.equal(region().getAttribute('aria-live'), 'polite')
  assert.equal(region().textContent, '')
  rerender(<TruncationAnnouncer shown />)
  const text = region().textContent
  assert.match(text ?? '', /Graph incomplete or truncated/)
  rerender(<TruncationAnnouncer shown />)
  assert.equal(region().textContent, text)
  rerender(<TruncationAnnouncer shown={false} />)
  assert.equal(region().textContent, '')
})

test('no axe violations with a replay loss', async () => {
  const { container } = render(<TruncationBanner stats={cut()} replayLost={7} onDismiss={noop} />)
  assert.deepEqual(await violations(container), [])
})
