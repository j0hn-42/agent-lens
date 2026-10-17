// #523 (user request): the top bar no longer draws the tokens in context or the cost (the compact summary of #497 is
// gone, with its popover). The view total is drawn by the Cost panel, the per-session totals by the Sessions panel and
// the per-agent figures by the inspector. Two things have no other place, so they stay:
// - the agent counts by state ("30 agents: 0 active · 4 last known · 26 done"), drawn nowhere else as a total;
// - for screen readers, the token and cost totals of the view: the Cost panel that draws them is a canvas, not read.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { formatAgentCounts, formatAgentCountsCompact } from '@/lib/chrome-utils'
import { COST_LABELS } from '@/lib/ui-glossary'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: 's1', sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 0, staleAgentCount: 4, doneAgentCount: 26, totalTokens: 33000, totalCost: 0.312,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

/** What is drawn: the text of `el` without the visually hidden parts (sr-only, hidden tooltips). */
function drawnText(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const hidden of Array.from(copy.querySelectorAll('.sr-only, [hidden], [aria-hidden="true"].sr-only'))) hidden.remove()
  return copy.textContent ?? ''
}
/** What screen readers get from the visually hidden parts. */
const spokenText = (el: Element) => Array.from(el.querySelectorAll('.sr-only')).map(n => n.textContent).join(' ')

const partialTokens = { value: 33000, status: 'partial', estimated: true } as const
const partialCost = { value: 0.312, status: 'partial', estimated: true } as const

test('the bar draws no token total, no cost and no summary popover', () => {
  const { container } = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedCost={0.03} />)
  const header = container.querySelector('header')!
  const drawn = drawnText(header)
  assert.doesNotMatch(drawn, /tokens|ctx/, `no token total drawn: "${drawn}"`)
  assert.doesNotMatch(drawn, /\$\d|unattr/, `no cost drawn: "${drawn}"`)
  assert.equal(header.querySelector('[data-testid^="topbar-summary"]'), null, 'no compact summary, no popover')
  assert.equal(header.querySelector('[data-testid="topbar-cost"], [data-testid="topbar-all-summary"]'), null)
})

test('the agent counts by state stay drawn: they are not totalled anywhere else', () => {
  const { getByTestId } = render(<TopBar {...base} />)
  const counts = getByTestId('topbar-agent-counts')
  assert.equal(drawnText(counts).trim(), formatAgentCountsCompact(0, 26, 4))
  // The full wording for screen readers ("last known state"), the drawn one hidden from them
  assert.equal(spokenText(counts).trim().startsWith(formatAgentCounts(0, 26, 4)), true, spokenText(counts))
  assert.equal(counts.querySelector('[aria-hidden="true"]')?.textContent, formatAgentCountsCompact(0, 26, 4))
  assert.equal(counts.getAttribute('tabindex'), null, 'plain text, not a Tab stop')
})

test('screen readers still get the token and cost totals of the view, qualified, with the unattributed part', () => {
  const { getByTestId } = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedCost={0.03} />)
  const spoken = spokenText(getByTestId('topbar-agent-counts'))
  assert.match(spoken, /at least 33k estimated tokens in context/)
  assert.ok(spoken.includes(`${COST_LABELS.name} at least $0.312 estimated`), spoken)
  assert.match(spoken, /including .*\$0\.030.* unattributed/)
})

test('a total the runtime does not report is named as missing for screen readers (#383)', () => {
  const none = { value: null, status: 'unavailable', estimated: false } as const
  const { getByTestId } = render(<TopBar {...base} totalTokens={0} totalCost={0} tokenUsage={none} costUsage={none} />)
  const spoken = spokenText(getByTestId('topbar-agent-counts'))
  assert.match(spoken, /tokens not reported/)
  assert.match(spoken, /cost not reported/)
  assert.doesNotMatch(spoken, /context cost estimate not reported/)
})

test('All mode: sessions and agents drawn, the cost said in words to screen readers only', () => {
  const cost = { value: 1.23, status: 'available', estimated: false } as const
  const { getByTestId } = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} allSessionCount={3} costUsage={cost} />)
  const counts = getByTestId('topbar-agent-counts')
  assert.equal(drawnText(counts).trim(), '3 sessions · 30 agents')
  assert.ok(spokenText(counts).includes(`3 sessions, 30 agents, ${COST_LABELS.name} $1.23`), spokenText(counts))
})
