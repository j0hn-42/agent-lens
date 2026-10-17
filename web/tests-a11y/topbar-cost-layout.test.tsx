// #112: the two qualified totals of the top bar are separated, and the canvas cost panel sits below the (wrapping) bar.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { costPanelTop, costHeaderWraps } from '@/components/agent-visualizer/canvas/draw-cost'
import { COST_PANEL } from '@/lib/canvas-constants'
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
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 33000, totalCost: 0.312,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

test('a partial estimated token total and a partial estimated cost are separated', () => {
  const partial = { value: 33000, status: 'partial', estimated: true } as const
  const cost = { value: 0.312, status: 'partial', estimated: true } as const
  const { container } = render(<TopBar {...base} tokenUsage={partial} costUsage={cost} unattributedCost={0.03} />)
  const text = container.textContent ?? ''
  assert.doesNotMatch(text, /estimated\s*at least/, 'no "estimated" glued to the next "at least"')
  assert.match(text, /tokens in context\s*·\s*at least/)
})

test('cost panel top follows the published top bar height', () => {
  assert.equal(costPanelTop('96px'), 96)
  assert.equal(costPanelTop(' 120.5px '), 121)
})

test('cost panel top falls back to the default when the bar height is unknown or smaller', () => {
  assert.equal(costPanelTop(''), COST_PANEL.yStart)
  assert.equal(costPanelTop('abc'), COST_PANEL.yStart)
  assert.equal(costPanelTop('20px'), COST_PANEL.yStart)
})

test('cost panel header puts tokens on a second line when both do not fit side by side (#116)', () => {
  assert.equal(costHeaderWraps(60, 60), false)
  // « $0.069 estimated » + « 11k estimated tokens » dépassaient les 232 px du panneau
  assert.equal(costHeaderWraps(114, 126), true)
})

test('the top bar cost is a context cost estimate: marked "~", named in words, method in its tooltip (#364)', () => {
  const cost = { value: 0.312, status: 'available', estimated: false } as const
  const tokens = { value: 33000, status: 'available', estimated: false } as const
  const { getByTestId, container } = render(<TopBar {...base} tokenUsage={tokens} costUsage={cost} />)
  const el = getByTestId('topbar-cost')
  assert.equal(el.getAttribute('title'), COST_LABELS.method)
  assert.match(el.textContent ?? '', /~\$0\.312/)
  // Starts with a pause: the "·" before it is hidden, so it must not run into "tokens in context"
  assert.equal(el.querySelector('.sr-only')?.textContent, `, ${COST_LABELS.name} $0.312`)
  // The token total adds up what each context holds now, not what was consumed
  assert.match(container.textContent ?? '', /33k tokens in context/)
})

test('All mode: the summary keeps "~" on screen and says the estimate in words to screen readers (#364)', () => {
  const cost = { value: 1.23, status: 'available', estimated: false } as const
  const { getByTestId } = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} allSessionCount={3} costUsage={cost} />)
  const el = getByTestId('topbar-all-summary')
  assert.equal(el.querySelector('[aria-hidden="true"]')?.textContent, '3 sessions - 1 agent - ~$1.23')
  assert.equal(el.querySelector('.sr-only')?.textContent, `3 sessions, 1 agent, ${COST_LABELS.name} $1.23`)
})

test('unavailable usage names what is missing, on screen and for assistive technology (#383)', () => {
  const none = { value: null, status: 'unavailable', estimated: false } as const
  const { container, getByTestId } = render(<TopBar {...base} totalTokens={0} totalCost={0} tokenUsage={none} costUsage={none} />)
  assert.match(container.textContent ?? '', /tokens not reported\s*·\s*cost not reported/)
  assert.doesNotMatch(getByTestId('topbar-cost').textContent ?? '', /context cost estimate not reported/)
})
