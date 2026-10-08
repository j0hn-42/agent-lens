// Visible signal for agents waiting for a permission or in error (#126): top bar counter, tab title, opt-in notification.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, renderHook, act } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { useAttentionAlerts } from '@/hooks/use-attention-alerts'
import { summarizeAttention, type AttentionAgent } from '@/lib/attention'

const noop = () => {}
const g = globalThis as unknown as { Notification?: unknown }
const realNotification = g.Notification

beforeEach(() => { document.title = 'Agent Lens'; try { localStorage.clear() } catch { /* none */ } })
afterEach(() => {
  cleanup()
  g.Notification = realNotification
  document.body.replaceChildren()
})

function topBar(extra: Partial<TopBarProps> = {}) {
  return (
    <TopBar
      sessions={[]} selectedSessionId="__all__" sessionsWithActivity={new Set()} showSessions={false} onToggleSessions={noop}
      isVSCode={false} connectionStatus="connected" activeAgentCount={0} doneAgentCount={0} totalTokens={0} totalCost={0}
      showFileAttention={false} showConversation={false} showCostOverlay={false} showTimeline={false} isMuted={false}
      onTogglePanel={noop} onToggleTimeline={noop} onToggleMute={noop} onOpenShortcuts={noop} {...extra}
    />
  )
}

const NOW = 1_000_000
const blocked = (id: string, state: string): AttentionAgent => ({ id, sessionId: id.split(':')[0], state, lastEventAt: NOW - 100 })

test('top bar: no counter without a blocked agent', () => {
  const { queryByTestId } = render(topBar({ attention: { waiting: 0, errors: 0 }, onJumpToAttention: noop }))
  assert.equal(queryByTestId('attention-counter'), null)
})

test('top bar: the counter names the numbers in words and a click goes to the first blocked agent', () => {
  let jumped = 0
  const { getByRole } = render(topBar({ attention: { waiting: 2, errors: 1 }, onJumpToAttention: () => { jumped++ } }))
  const button = getByRole('button', { name: /2 waiting \/ 1 error\. Go to the first agent/ })
  fireEvent.click(button)
  assert.equal(jumped, 1)
})

test('top bar: the notification option is hidden when unsupported and says when blocked', () => {
  const none = render(topBar({ notifyState: 'unsupported', onToggleNotify: noop }))
  assert.equal(none.queryByRole('button', { name: /Notif/ }), null)
  none.unmount()
  const denied = render(topBar({ notifyState: 'denied', onToggleNotify: noop }))
  denied.getByRole('button', { name: 'Notifications blocked' })
})

test('title: prefixed with the number of blocked agents and restored when none', () => {
  const hook = renderHook(({ agents }) => useAttentionAlerts(summarizeAttention(agents, NOW)), { initialProps: { agents: [] as AttentionAgent[] } })
  assert.equal(document.title, 'Agent Lens')
  hook.rerender({ agents: [blocked('s1:a', 'waiting_permission'), blocked('s2:a', 'error')] })
  assert.equal(document.title, '(2) Agent Lens')
  hook.rerender({ agents: [blocked('s1:a', 'waiting_permission')] })
  assert.equal(document.title, '(1) Agent Lens')
  hook.rerender({ agents: [] })
  assert.equal(document.title, 'Agent Lens')
  hook.unmount()
  assert.equal(document.title, 'Agent Lens')
})

class FakeNotification {
  static permission = 'default'
  static asked = 0
  static shown: Array<{ title: string; body?: string }> = []
  static requestPermission() { FakeNotification.asked++; FakeNotification.permission = 'granted'; return Promise.resolve('granted') }
  constructor(title: string, opts?: { body?: string }) { FakeNotification.shown.push({ title, body: opts?.body }) }
}

test('notification: permission is asked only when the user turns it on, then a hidden tab is notified of new blocked agents', async () => {
  FakeNotification.permission = 'default'; FakeNotification.asked = 0; FakeNotification.shown = []
  g.Notification = FakeNotification
  const hook = renderHook(({ agents }) => useAttentionAlerts(summarizeAttention(agents, NOW)), { initialProps: { agents: [] as AttentionAgent[] } })
  assert.equal(FakeNotification.asked, 0, 'never asked at load')
  assert.equal(hook.result.current.notifyState, 'off')

  await act(async () => { await hook.result.current.toggleNotify() })
  assert.equal(FakeNotification.asked, 1)
  assert.equal(hook.result.current.notifyState, 'on')

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  hook.rerender({ agents: [blocked('s1:a', 'waiting_permission')] })
  assert.equal(FakeNotification.shown.length, 0, 'a visible tab is not notified')

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  hook.rerender({ agents: [blocked('s1:a', 'waiting_permission'), blocked('s2:a', 'error')] })
  assert.equal(FakeNotification.shown.length, 1)
  assert.match(FakeNotification.shown[0].body ?? '', /1 waiting \/ 1 error/)
  hook.rerender({ agents: [blocked('s1:a', 'waiting_permission'), blocked('s2:a', 'error')] })
  assert.equal(FakeNotification.shown.length, 1, 'no repeat for agents already reported')

  await act(async () => { await hook.result.current.toggleNotify() })
  assert.equal(hook.result.current.notifyState, 'off')
  delete (document as unknown as Record<string, unknown>).hidden
})
