// #112: the two qualified totals of the top bar are separated, and the canvas cost panel sits below the (wrapping) bar.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { costPanelTop } from '@/components/agent-visualizer/canvas/draw-cost'
import { COST_PANEL } from '@/lib/canvas-constants'

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
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

test('a partial estimated token total and a partial estimated cost are separated', () => {
  const partial = { value: 33000, status: 'partial', estimated: true } as const
  const cost = { value: 0.312, status: 'partial', estimated: true } as const
  const { container } = render(<TopBar {...base} tokenUsage={partial} costUsage={cost} unattributedCost={0.03} />)
  const text = container.textContent ?? ''
  assert.doesNotMatch(text, /estimé\s*au moins/, 'no "estimé" glued to the next "au moins"')
  assert.match(text, /tokens\s*·\s*au moins/)
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
