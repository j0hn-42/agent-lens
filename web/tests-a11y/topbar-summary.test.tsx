// #497: the summary of the top bar is one short line (symbols for the qualifiers); the full text is a popover that
// opens on hover and on focus and closes with Escape (WCAG 1.4.13), and stays the text read by screen readers.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { SUMMARY_KEY } from '@/lib/chrome-utils'
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

test('the open popover stays open while the pointer is over it (hoverable, 1.4.13)', () => {
  const v = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} />)
  fireEvent.mouseEnter(summary(v))
  fireEvent.mouseEnter(full(v))
  assert.equal(summary(v).getAttribute('data-open'), 'true')
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
