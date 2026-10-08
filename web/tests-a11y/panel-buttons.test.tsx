// #124: every panel of PANEL_BUTTON_IDS has a top bar button (aria-pressed, title, shortcut) and an entry in the help dialog.
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

test('every panel button has aria-pressed, a title and a keyboard shortcut listed in the help dialog table', () => {
  render(<TopBar {...props} />)
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  for (const [panel, id] of Object.entries(PANEL_BUTTON_IDS)) {
    const btn = document.getElementById(id)
    assert.ok(btn, `${panel}: no top bar button #${id}`)
    assert.ok(btn.hasAttribute('aria-pressed'), `${panel}: aria-pressed`)
    assert.ok(btn.getAttribute('title'), `${panel}: title`)
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
