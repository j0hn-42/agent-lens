// The 'Show finished sessions (N)' toggle of the top bar (#36): native button, aria-pressed, keyboard operable.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

test('toggle is a native button named with the finished count and reports aria-pressed', () => {
  const calls: boolean[] = []
  const { getByRole, rerender } = render(
    <TopBar {...base} finishedSessionCount={15} showFinished={false} onToggleShowFinished={v => calls.push(v)} />,
  )
  const btn = getByRole('button', { name: 'Show finished sessions (15)' })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('aria-pressed'), 'false')
  fireEvent.click(btn)
  assert.deepEqual(calls, [true])
  rerender(<TopBar {...base} finishedSessionCount={15} showFinished onToggleShowFinished={v => calls.push(v)} />)
  assert.equal(getByRole('button', { name: 'Show finished sessions (15)' }).getAttribute('aria-pressed'), 'true')
})

test('toggle is hidden when there is nothing to show and outside the All tab; the All summary counts shown sessions', () => {
  const none = render(<TopBar {...base} finishedSessionCount={0} onToggleShowFinished={noop} />)
  assert.equal(none.queryByRole('button', { name: /Show finished sessions/ }), null)
  none.unmount()
  const single = render(<TopBar {...base} selectedSessionId="s1" finishedSessionCount={4} onToggleShowFinished={noop} />)
  assert.equal(single.queryByRole('button', { name: /Show finished sessions/ }), null)
  single.unmount()
  const all = render(<TopBar {...base} allSessionCount={3} finishedSessionCount={4} onToggleShowFinished={noop} />)
  assert.ok(all.getByText(/^3 sessions/))
})

test('a pressed toggle stays reachable even when the finished count drops to 0', () => {
  const { getByRole } = render(<TopBar {...base} finishedSessionCount={0} showFinished onToggleShowFinished={noop} />)
  assert.equal(getByRole('button', { name: 'Show finished sessions (0)' }).getAttribute('aria-pressed'), 'true')
})
