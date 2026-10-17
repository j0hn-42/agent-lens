// #497: the summary of the top bar is one short line (symbols for the qualifiers); the full text is a popover that
// opens on hover and on focus and closes with Escape (WCAG 1.4.13), and stays the text read by screen readers.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { SUMMARY_KEY, SUMMARY_POPOVER, spokenCompactSummary } from '@/lib/chrome-utils'
import { SUMMARY_CLOSE_DELAY_MS } from '@/components/agent-visualizer/topbar-summary'
import { COST_LABELS } from '@/lib/ui-glossary'
import { COLORS } from '@/lib/colors'
import { setMobileView } from './mobile-media'

afterEach(() => {
  setMobileView(false)
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: 's1', sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 0, doneAgentCount: 26, staleAgentCount: 4, totalTokens: 5_300_000, totalCost: 40.49,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}
const partialTokens = { value: 5_300_000, status: 'partial', estimated: true } as const
const partialCost = { value: 40.49, status: 'partial', estimated: true } as const

const summary = (v: ReturnType<typeof render>) => v.getByTestId('topbar-summary')
const compact = (v: ReturnType<typeof render>) => v.getByTestId('topbar-summary-compact')
const full = (v: ReturnType<typeof render>) => v.getByTestId('topbar-summary-full')

test('the visible summary is the compact one, with every qualifier as a symbol', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  assert.equal(compact(v).textContent, '30 agents: 0 active · 4 last known · 26 done · ≥~5.3M ctx tokens · ≥~$40.49 est.')
  assert.equal(compact(v).getAttribute('aria-hidden'), 'true')
})

test('screen readers get the full text, with proper separators ("context · at least", never "context· at least")', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  const text = full(v).textContent ?? ''
  assert.match(text, /30 agents: 0 active - 4 last known state - 26 done/)
  assert.match(text, /at least 5\.3M estimated tokens in context\s+·\s+at least ~\$40\.49 estimated/)
  assert.doesNotMatch(text, /context·/)
  assert.ok(text.includes(SUMMARY_KEY), 'the key of the symbols is in the full text')
})

test('the summary is a focusable named group; the popover opens on hover and on focus, Escape closes it', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  const group = summary(v)
  assert.equal(group.getAttribute('role'), 'group')
  assert.ok(group.getAttribute('aria-label'))
  assert.equal(group.getAttribute('tabindex'), '0')
  assert.equal(group.getAttribute('data-open'), 'false')
  assert.ok(full(v).className.includes('sr-only'), 'closed: the text is visually hidden, still read')

  fireEvent.mouseEnter(group)
  assert.equal(group.getAttribute('data-open'), 'true')
  assert.ok(!full(v).className.includes('sr-only'), 'open: the full text is drawn')
  fireEvent.keyDown(group, { key: 'Escape' })
  assert.equal(group.getAttribute('data-open'), 'false', 'Escape closes it without moving the focus')
  fireEvent.mouseLeave(group)

  fireEvent.focus(group)
  assert.equal(group.getAttribute('data-open'), 'true')
  fireEvent.keyDown(group, { key: 'Escape' })
  assert.equal(group.getAttribute('data-open'), 'false')
  fireEvent.blur(group)
  fireEvent.focus(group)
  assert.equal(group.getAttribute('data-open'), 'true', 'a new focus opens it again')
})

test('the pointer can cross to the popover: leaving the summary closes it only after a short delay (hoverable, 1.4.13)', async () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  fireEvent.mouseEnter(summary(v))
  fireEvent.mouseLeave(summary(v))
  assert.equal(summary(v).getAttribute('data-open'), 'true', 'still open right after the pointer leaves')
  // the pointer reaches the popover (inside the group) before the delay ends
  fireEvent.mouseEnter(summary(v))
  await new Promise(r => setTimeout(r, SUMMARY_CLOSE_DELAY_MS + 50))
  assert.equal(summary(v).getAttribute('data-open'), 'true', 'back over the summary or its popover: it stays')
  fireEvent.mouseLeave(summary(v))
  await new Promise(r => setTimeout(r, SUMMARY_CLOSE_DELAY_MS + 50))
  assert.equal(summary(v).getAttribute('data-open'), 'false', 'the pointer went elsewhere: it closes')
})

test('Escape closes a popover opened by hover while the focus is elsewhere (1.4.13), and only then stops Escape', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  const seen: string[] = []
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') seen.push('escape') }
  document.addEventListener('keydown', onKey)
  try {
    const timeline = v.getByRole('button', { name: 'Timeline' })
    timeline.focus()
    fireEvent.mouseEnter(summary(v))
    assert.equal(summary(v).getAttribute('data-open'), 'true')
    fireEvent.keyDown(timeline, { key: 'Escape' })
    assert.equal(summary(v).getAttribute('data-open'), 'false', 'Escape pressed with the focus on another control closes it')
    assert.deepEqual(seen, [], 'that Escape only closed the popover (the global Escape did not also run)')
    assert.equal(document.activeElement, timeline, 'the focus did not move')
    fireEvent.keyDown(timeline, { key: 'Escape' })
    assert.deepEqual(seen, ['escape'], 'closed, the popover lets Escape through')
  } finally {
    document.removeEventListener('keydown', onKey)
  }
})

test('the unattributed part of the cost has its compact marker, qualified like the cost', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedCost={0.03} />)
  assert.equal(compact(v).textContent, '30 agents: 0 active · 4 last known · 26 done · ≥~5.3M ctx tokens · ≥~$40.49 est. · incl. ≥~$0.030 est. unattr.')
  const plain = render(<TopBar {...base} unattributedCost={0.03} />)
  assert.match(plain.getAllByTestId('topbar-summary-compact')[1].textContent ?? '', /· incl\. ~\$0\.030 unattr\.$/)
})

test('the group is named by the compact text in words (2.5.3); the key and the method are drawn, not read twice', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  assert.equal(summary(v).getAttribute('aria-label'), spokenCompactSummary(compact(v).textContent ?? ''))
  const key = v.getByTestId('topbar-summary-key')
  assert.equal(key.getAttribute('aria-hidden'), 'true', 'screen readers do not hear a key of symbols they never see')
  assert.equal(key.textContent, SUMMARY_KEY)
  fireEvent.focus(summary(v))
  const method = v.getByTestId('topbar-summary-method')
  assert.equal(method.textContent, COST_LABELS.method, 'the cost method is in the popover')
  assert.equal(method.getAttribute('aria-hidden'), 'true', 'the spoken cost already says "context cost estimate"')
})

test('the popover paints the inks measured in every theme (theme-contrast.test.ts), the key with no opacity of its own', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  fireEvent.focus(summary(v))
  const pop = full(v)
  const probe = document.createElement('span')
  probe.style.background = COLORS[SUMMARY_POPOVER.ground]
  probe.style.color = COLORS[SUMMARY_POPOVER.text]
  assert.equal(pop.style.background, probe.style.background)
  assert.equal(pop.style.color, probe.style.color)
  assert.equal(SUMMARY_POPOVER.keyOpacity, 1)
  assert.doesNotMatch(v.getByTestId('topbar-summary-key').className, /opacity/)
})

test('All mode: sessions, agents, tokens and cost stay compact and qualified', () => {
  const v = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} allSessionCount={3} tokenUsage={partialTokens} costUsage={partialCost} />)
  assert.equal(compact(v).textContent, '3 sessions · 30 agents · ≥~5.3M ctx tokens · ≥~$40.49 est.')
  assert.match(full(v).textContent ?? '', /3 sessions - 30 agents - at least ~\$40\.49 estimated/)
})

test('folded (under 768 px) the summary is not a Tab stop', () => {
  setMobileView(true)
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  assert.equal(summary(v).getAttribute('tabindex'), null)
})

test('no axe violation with the popover open', async () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  fireEvent.focus(summary(v))
  const results = await axe.run(v.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
  assert.deepEqual(results.violations.map(x => x.id), [])
})
