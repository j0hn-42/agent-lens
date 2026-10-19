// The "Graph truncated" banner (#51): status role, readable text, native controls, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TruncationBanner, TruncationAnnouncer, TruncationIndicator } from '@/components/agent-visualizer/truncation-banner'
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
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  const toggle = getByRole('button', { name: 'Details' })
  assert.equal(toggle.tagName, 'BUTTON')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  assert.ok(list, 'aria-controls points at the list')
  assert.equal(list.hidden, true)
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(list.hidden, false)
  const text = list.textContent ?? ''
  assert.match(text, /Events ignored[^:]*: 2/)
  assert.match(text, /Malformed inputs[^:]*: 1/)
  assert.match(text, /Nodes dropped[^:]*: 4/)
  assert.match(text, /Fields shortened or clamped: 9/)
  assert.match(text, /Duplicate events skipped: 5/)
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(list.hidden, true)
})

test('Details keeps adjustments (fields shortened, duplicates skipped) apart from losses, under their own visible heading (#567)', () => {
  const { getByRole, getByText } = render(<TruncationBanner stats={cut()} replayLost={6371} onDismiss={noop} />)
  fireEvent.click(getByRole('button', { name: 'Details' }))
  const losses = getByRole('list', { name: 'Losses' })
  const adjustments = getByRole('list', { name: 'Adjustments (not losses)' })
  assert.ok(getByText('Losses'), 'the losses heading is visible')
  assert.ok(getByText('Adjustments (not losses)'), 'the adjustments heading is visible')
  const lossText = losses.textContent ?? ''
  assert.match(lossText, /Earlier events not replayed \(lower bound\): 6371/, 'the replay loss is listed with the other losses')
  assert.match(lossText, /Events ignored[^:]*: 2/)
  assert.match(lossText, /Malformed inputs[^:]*: 1/)
  assert.match(lossText, /Nodes dropped[^:]*: 4/)
  assert.doesNotMatch(lossText, /Fields shortened|Duplicate events/, 'adjustments are not read as losses')
  const adjText = adjustments.textContent ?? ''
  assert.match(adjText, /Fields shortened or clamped: 9/)
  assert.match(adjText, /Duplicate events skipped: 5/)
  assert.doesNotMatch(adjText, /Events ignored|not replayed/)
})

test('without a replay loss, Details does not list a replay line', () => {
  const { getByRole } = render(<TruncationBanner stats={cut()} onDismiss={noop} />)
  fireEvent.click(getByRole('button', { name: 'Details' }))
  assert.doesNotMatch(getByRole('list', { name: 'Losses' }).textContent ?? '', /not replayed/)
})

test('Details in French: Pertes and Ajustements (pas des pertes)', () => {
  setLocaleChoice('fr')
  const { getByRole } = render(<TruncationBanner stats={cut()} replayLost={3} onDismiss={noop} />)
  fireEvent.click(getByRole('button', { name: 'Détails' }))
  assert.match(getByRole('list', { name: 'Pertes' }).textContent ?? '', /Événements antérieurs non rejoués \(borne basse\) : 3/)
  assert.match(getByRole('list', { name: 'Ajustements (pas des pertes)' }).textContent ?? '', /Champs raccourcis ou bornés : 9/)
})

test('reopened from the indicator (initialOpen + takeFocus): Details is expanded and the focus lands on its toggle once (#567)', () => {
  let taken = 0
  const { getByRole } = render(<TruncationBanner stats={createStats()} replayLost={6371} initialOpen takeFocus onFocusTaken={() => { taken++ }} onDismiss={noop} />)
  const toggle = getByRole('button', { name: 'Details' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.hidden, false)
  assert.equal(document.activeElement, toggle)
  assert.equal(taken, 1, 'the parent is told the focus request is spent')
})

test('initialOpen alone (a later mount of a reopened banner) expands Details without moving the focus (#569 review)', () => {
  const { getByRole } = render(<TruncationBanner stats={createStats()} replayLost={6371} initialOpen onDismiss={noop} />)
  const toggle = getByRole('button', { name: 'Details' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.notEqual(document.activeElement, toggle)
})

test('the indicator: a short text that stays, with a native button that reopens the notice (#567)', () => {
  let shown = 0
  const { getByTestId, getByRole } = render(<TruncationIndicator stats={createStats()} replayLost={6371} onShow={() => { shown++ }} />)
  const el = getByTestId('truncation-indicator')
  assert.match(el.textContent ?? '', /at least 6371 events not replayed/)
  assert.equal(el.querySelector('[aria-hidden="true"]')?.textContent?.trim(), '⚠', 'the symbol is decorative')
  const btn = getByRole('button', { name: 'Show notice' })
  assert.equal(btn.tagName, 'BUTTON', 'a native button: Enter and Space activate it')
  assert.equal(btn.getAttribute('type'), 'button')
  assert.ok(btn.className.includes(FOCUS_RING), 'visible focus')
  assert.ok(btn.className.includes('min-h-6'), '24px target')
  fireEvent.click(btn)
  assert.equal(shown, 1)
})

test('the indicator reads "at least", singular for one, and names a normalizer loss when there is no replay loss', () => {
  const one = render(<TruncationIndicator stats={createStats()} replayLost={1} onShow={noop} />)
  assert.match(one.getByTestId('truncation-indicator').textContent ?? '', /at least 1 event not replayed/)
  one.unmount()
  const cutOnly = render(<TruncationIndicator stats={cut()} onShow={noop} />)
  assert.match(cutOnly.getByTestId('truncation-indicator').textContent ?? '', /3 events ignored, 4 nodes dropped/)
  cutOnly.unmount()
  const both = render(<TruncationIndicator stats={cut()} replayLost={5} onShow={noop} />)
  const text = both.getByTestId('truncation-indicator').textContent ?? ''
  assert.match(text, /at least 5 events not replayed/)
  assert.match(text, /3 events ignored, 4 nodes dropped/)
})

test('the indicator renders nothing without a loss (adjustments alone are no loss)', () => {
  for (const [stats, lost] of [[createStats(), 0], [{ ...createStats(), clampedFields: 12, duplicateEvents: 3 }, 0], [createStats(), -2], [createStats(), Number.NaN]] as const) {
    const { container, unmount } = render(<TruncationIndicator stats={stats} replayLost={lost} onShow={noop} />)
    assert.equal(container.firstChild, null)
    unmount()
  }
})

test('the indicator in French declares its language and says "au moins"', () => {
  setLocaleChoice('fr')
  const { getByTestId, getByRole } = render(<TruncationIndicator stats={createStats()} replayLost={6371} onShow={noop} />)
  const el = getByTestId('truncation-indicator')
  assert.equal(el.getAttribute('lang'), 'fr', 'the indicator declares its language')
  assert.match(el.textContent ?? '', /au moins 6371 événements non rejoués/)
  assert.ok(getByRole('button', { name: 'Afficher la notice' }))
})

test('no axe violations for the indicator', async () => {
  const { container } = render(<TruncationIndicator stats={cut()} replayLost={7} onShow={noop} />)
  assert.deepEqual(await violations(container), [])
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
  assert.doesNotMatch(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /at least \d+ updates? not read/, 'said in the headline only when there is one')
})

test('the notice is in the language of the interface (#247): French, with the same counters', () => {
  setLocaleChoice('fr')
  const { getByRole, getByLabelText } = render(<TruncationBanner stats={cut({ missedUpdates: 2 })} replayLost={5} onDismiss={noop} />)
  const group = getByRole('group', { name: 'Troncature du graphe' })
  assert.equal(group.getAttribute('lang'), 'fr', 'the block declares its language (the page lang stays en)')
  const text = group.textContent ?? ''
  assert.match(text, /Graphe tronqué : 3 événements ignorés, 4 nœuds supprimés, au moins 2 mises à jour non lues/)
  assert.match(text, /au moins 5 événements antérieurs n’ont pas été rejoués/)
  fireEvent.click(getByRole('button', { name: 'Détails' }))
  const details = getByLabelText('Compteurs par cause').textContent ?? ''
  assert.match(details, /Mises à jour non lues \(borne basse\) : 2/)
  assert.ok(getByRole('button', { name: 'Fermer l’avertissement de troncature' }))
})

test('events the relay could not replay show on their own, as "at least" (#366)', () => {
  const { getByRole } = render(<TruncationBanner stats={createStats()} replayLost={40} onDismiss={noop} />)
  const text = getByRole('group', { name: 'Graph truncation' }).textContent ?? ''
  assert.match(text, /Graph incomplete: at least 40 earlier events were not replayed/)
  assert.doesNotMatch(text, /Graph truncated/)
})

test('both causes are named when both apply; a replay loss of one is singular', () => {
  const { getByRole, rerender } = render(<TruncationBanner stats={cut()} replayLost={5} onDismiss={noop} />)
  const text = getByRole('group', { name: 'Graph truncation' }).textContent ?? ''
  assert.match(text, /Graph truncated: 3 events ignored, 4 nodes dropped/)
  assert.match(text, /at least 5 earlier events were not replayed/)
  rerender(<TruncationBanner stats={createStats()} replayLost={1} onDismiss={noop} />)
  assert.match(getByRole('group', { name: 'Graph truncation' }).textContent ?? '', /at least 1 earlier event was not replayed/)
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
