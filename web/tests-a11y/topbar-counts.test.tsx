// #523 (user request): the top bar draws no summary text any more: no tokens in context, no cost (the compact summary
// of #497 is gone, with its popover) and no agent counts by state. The view total is drawn by the Cost panel, the
// per-session totals and the agent counts by state by the Sessions panel (its header), the per-agent figures by the
// inspector. One thing has no other readable place, so it stays in the bar for screen readers only (sr-only, never
// drawn): the token and cost totals of the view, because the Cost panel that draws them is a canvas, not read.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { viewCountsText } from '@/lib/chrome-utils'
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

const partialTokens = { value: 33000, status: 'partial', estimated: true } as const
const partialCost = { value: 0.312, status: 'partial', estimated: true } as const

test('the bar draws no token total, no cost and no summary popover', () => {
  const { container } = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedTokens={900_000} unattributedCost={0.03} />)
  const header = container.querySelector('header')!
  const drawn = drawnText(header)
  assert.doesNotMatch(drawn, /tokens|ctx/, `no token total drawn: "${drawn}"`)
  assert.doesNotMatch(drawn, /\$\d|unattr/, `no cost drawn: "${drawn}"`)
  assert.equal(header.querySelector('[data-testid^="topbar-summary"]'), null, 'no compact summary, no popover')
  assert.equal(header.querySelector('[data-testid="topbar-cost"], [data-testid="topbar-all-summary"]'), null)
})

test('the bar draws no agent counts either: no "agents:", "active", "last known" or "done" (#523)', () => {
  for (const props of [base, { ...base, selectedSessionId: ALL_SESSIONS_ID, allSessionCount: 3 }]) {
    const { container, unmount } = render(<TopBar {...props} />)
    const drawn = drawnText(container.querySelector('header')!)
    assert.doesNotMatch(drawn, /agents?:|\bactive\b|last known|\bdone\b|\d+ agents?\b|\d+ sessions? ·/, `no counts drawn: "${drawn}"`)
    assert.equal(container.querySelector('[data-testid="topbar-agent-counts"]'), null, 'no drawn counts element')
    unmount()
  }
})

test('screen readers still get the agent counts in the bar, in the full wording, and nothing of it is a Tab stop', () => {
  const { getByTestId } = render(<TopBar {...base} />)
  const totals = getByTestId('topbar-spoken-totals')
  assert.ok(totals.classList.contains('sr-only'), 'read, never drawn')
  assert.equal(totals.textContent!.startsWith(viewCountsText({ active: 0, done: 26, stale: 4, idle: 0, error: 0 }, null).spoken), true, totals.textContent!)
  assert.equal(totals.getAttribute('tabindex'), null, 'plain text, not a Tab stop')
})

test('screen readers still get the token and cost totals of the view, qualified, with the unattributed part', () => {
  const { getByTestId } = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedTokens={900_000} unattributedCost={0.03} unattributedEstimated />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  assert.match(spoken, /at least 33k estimated tokens in context/)
  assert.ok(spoken.includes(`${COST_LABELS.name} at least $0.312 estimated`), spoken)
  assert.match(spoken, /including 900k unattributed tokens \(about \$0\.030 estimated\)/, spoken)
})

test('a total the runtime does not report is named as missing for screen readers (#383)', () => {
  const none = { value: null, status: 'unavailable', estimated: false } as const
  const { getByTestId } = render(<TopBar {...base} totalTokens={0} totalCost={0} tokenUsage={none} costUsage={none} />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  assert.match(spoken, /tokens not reported/)
  assert.match(spoken, /cost not reported/)
  assert.doesNotMatch(spoken, /context cost estimate not reported/)
})

test('All mode: sessions, agents and the cost said in words to screen readers only', () => {
  const cost = { value: 1.23, status: 'available', estimated: false } as const
  const { getByTestId } = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} allSessionCount={3} costUsage={cost} />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  assert.ok(spoken.includes(`3 sessions, 30 agents, ${COST_LABELS.name} $1.23`), spoken)
})

// #576: the bar says the unattributed part with the rule and the qualifiers of the drawing of the Cost panel (draw-cost.ts)
// and of its "Cost totals" region (#573): tokens, "about" for the drawn "~", "estimated" when one part is an estimate, and
// in every view, All included, never a bare exact-looking figure.
test('#576 the unattributed part is not a bare figure: tokens and "about" (not an estimate: no "estimated")', () => {
  const { getByTestId } = render(<TopBar {...base} unattributedTokens={900_000} unattributedCost={5.4} />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  assert.ok(spoken.includes('including 900k unattributed tokens (about $5.40)'), spoken)
  assert.doesNotMatch(spoken, /including \$[\d.]+ unattributed/)
})

test('#576 All view: the unattributed part is read too, as the drawing shows its row in every mode', () => {
  const { getByTestId } = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} allSessionCount={3} unattributedTokens={900_000} unattributedCost={5.4} unattributedEstimated />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  assert.ok(spoken.includes('including 900k unattributed tokens (about $5.40 estimated)'), spoken)
})

test('#576 no unattributed tokens: nothing is said (the drawing draws no row), even with a cost figure', () => {
  const { getByTestId } = render(<TopBar {...base} unattributedTokens={0} unattributedCost={0.5} />)
  assert.doesNotMatch(getByTestId('topbar-spoken-totals').textContent!, /unattributed/)
})

test('#576 the unattributed part does not depend on costReported: a partial cost (a lower bound) still says it', () => {
  // A cost of "unavailable" with unattributed tokens cannot happen in the app (the rest is priced at the default rate as
  // soon as it has tokens), so the case is not pinned; a partial cost is the realistic one
  const { getByTestId } = render(<TopBar {...base} costUsage={partialCost} unattributedTokens={900_000} unattributedCost={5.4} />)
  assert.match(getByTestId('topbar-spoken-totals').textContent!, /including 900k unattributed tokens \(about \$5\.40\)/)
})

test('#576 reading order: counts, cost, tokens, then the unattributed part, as the Cost region reads it', () => {
  const { getByTestId } = render(<TopBar {...base} tokenUsage={partialTokens} costUsage={partialCost} unattributedTokens={900_000} unattributedCost={0.03} />)
  const spoken = getByTestId('topbar-spoken-totals').textContent!
  const at = (re: RegExp) => spoken.search(re)
  assert.ok(at(/tokens in context/) >= 0 && at(/at least \$0\.312/) < at(/tokens in context/), spoken)
  assert.ok(at(/tokens in context/) < at(/including 900k unattributed/), spoken)
})
