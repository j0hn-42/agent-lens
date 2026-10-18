// #124: every panel of PANEL_BUTTON_IDS has a top bar button (aria-pressed, a tooltip or title, shortcut) and an entry in the help
// dialog. #523: the seven panel buttons (icons under 1280 px) have a role=tooltip linked by aria-describedby instead of a title.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { TopBar, PANEL_BUTTON_IDS, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { SHORTCUTS } from '@/lib/shortcuts'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

const props: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

/** The tooltip text of a button: its role=tooltip next to it (#523; linked by aria-describedby when it says more than the name) or its native title (Sessions). */
const tipText = (btn: HTMLElement) => {
  const tip = btn.parentElement?.querySelector('[role="tooltip"]')
  return tip?.textContent ?? btn.getAttribute('title') ?? ''
}

test('every panel button has aria-pressed, a tooltip and a keyboard shortcut listed in the help dialog table', () => {
  render(<TopBar {...props} />)
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  for (const [panel, id] of Object.entries(PANEL_BUTTON_IDS)) {
    const btn = document.getElementById(id)
    assert.ok(btn, `${panel}: no top bar button #${id}`)
    assert.ok(btn.hasAttribute('aria-pressed'), `${panel}: aria-pressed`)
    assert.ok(tipText(btn), `${panel}: tooltip`)
    const key = btn.getAttribute('aria-keyshortcuts')
    assert.ok(key, `${panel}: aria-keyshortcuts`)
    assert.ok(byKey.has(key), `${panel}: shortcut "${key}" missing from SHORTCUTS`)
    assert.match(byKey.get(key)!.description, /^Toggle /, `${panel}: help entry`)
  }
})

test('the Stats button reports its state and toggles the overlay', () => {
  const calls: string[] = []
  const { rerender } = render(<TopBar {...props} onToggleStats={() => calls.push('stats')} />)
  const btn = document.getElementById(PANEL_BUTTON_IDS.stats)!
  assert.equal(btn.getAttribute('aria-pressed'), 'false')
  btn.click()
  assert.deepEqual(calls, ['stats'])
  rerender(<TopBar {...props} showStats />)
  assert.equal(document.getElementById(PANEL_BUTTON_IDS.stats)!.getAttribute('aria-pressed'), 'true')
})

// #180: the Context panel needs the standalone relay; inside VS Code the button says so instead of opening an empty panel.
test('in VS Code the Context button exposes why the panel is unavailable', () => {
  render(<TopBar {...props} isVSCode />)
  const btn = document.getElementById(PANEL_BUTTON_IDS.context)!
  assert.ok(btn, 'the Context button stays visible')
  // Its tooltip, linked by aria-describedby, so screen readers read it after the name (#523)
  assert.match(tipText(btn), /standalone relay.*not available in VS Code/i)
  assert.match(document.getElementById(btn.getAttribute('aria-describedby') ?? '')?.textContent ?? '', /not available in VS Code/)
})

// #357, WCAG 1.4.10: with the System toggle the side panel group is wider than a 320 px viewport; it wraps like the
// toolbar around it instead of pushing Files and Context out of the screen (e2e reflow-320 measures the real layout).
test('the side panel group wraps on a narrow viewport and keeps every toggle in it', () => {
  render(<TopBar {...props} />)
  const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Side panels"]')!
  assert.match(group.className, /\bflex-wrap\b/)
  for (const panel of ['files', 'conversation', 'context', 'system', 'cost'] as const) {
    assert.ok(group.contains(document.getElementById(PANEL_BUTTON_IDS[panel])), `${panel} toggle stays in the group`)
  }
})

test('outside VS Code the Context button has no unavailability note', () => {
  render(<TopBar {...props} />)
  const btn = document.getElementById(PANEL_BUTTON_IDS.context)!
  assert.doesNotMatch(tipText(btn), /not available/i)
  assert.match(tipText(btn), /CLAUDE\.md/)
})
