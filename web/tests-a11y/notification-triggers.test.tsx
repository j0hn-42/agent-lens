// Configurable notification triggers and native channel (#225): hook, persisted rules, Settings section.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, renderHook, act } from '@testing-library/react'

import { SettingsDialog } from '@/components/agent-visualizer/settings-dialog'
import { useAttentionAlerts } from '@/hooks/use-attention-alerts'
import { useNotificationRules } from '@/hooks/use-notification-rules'
import { DEFAULT_RULES, NOTIFY_RULES_STORAGE_KEY, type NotificationRules } from '@/lib/notification-rules'
import { summarizeAttention, type AttentionAgent } from '@/lib/attention'

const noop = () => {}
// The jsdom preload does not expose localStorage as a global; the hooks read the bare identifier like a browser page
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true, writable: true })
const NOW = 1_000_000
const g = globalThis as unknown as { Notification?: unknown }
const realNotification = g.Notification

class FakeNotification {
  static permission = 'default'
  static asked = 0
  static shown: Array<{ title: string; body?: string }> = []
  static requestPermission() { FakeNotification.asked++; FakeNotification.permission = 'granted'; return Promise.resolve('granted') }
  constructor(title: string, opts?: { body?: string }) { FakeNotification.shown.push({ title, body: opts?.body }) }
}

beforeEach(() => { document.title = 'Agent Lens'; try { localStorage.clear() } catch { /* none */ } })
afterEach(() => {
  cleanup()
  g.Notification = realNotification
  delete (document as unknown as Record<string, unknown>).hidden
  document.body.replaceChildren()
})

const hide = () => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
const grantedNotification = () => {
  FakeNotification.permission = 'granted'; FakeNotification.asked = 0; FakeNotification.shown = []
  g.Notification = FakeNotification
  try { localStorage.setItem('agent-lens:notify-blocked', 'true') } catch { /* none */ }
}
const blocked = (id: string, state: string): AttentionAgent => ({ id, sessionId: id.split(':')[0], state, lastEventAt: NOW - 100 })
const sess = (status: 'active' | 'completed') => [{ id: 's1', label: 'refactor', status, startTime: 1, lastActivityTime: 2 }]
const usageOf = (value: number | null) => ({ value, status: value === null ? 'unavailable' as const : 'available' as const, estimated: false })
const empty = summarizeAttention([], NOW)

test('triggers: a finished session notifies a hidden tab only when the rule is on', () => {
  grantedNotification(); hide()
  const run = (rules: NotificationRules) => {
    FakeNotification.shown = []
    const hook = renderHook(({ status }) => useAttentionAlerts(empty, { rules, sessions: sess(status), cost: usageOf(null) }),
      { initialProps: { status: 'active' as 'active' | 'completed' } })
    hook.rerender({ status: 'completed' })
    hook.unmount()
    return FakeNotification.shown.length
  }
  assert.equal(run(DEFAULT_RULES), 0)
  assert.equal(run({ ...DEFAULT_RULES, complete: true }), 1)
})

test('triggers: crossing the cost threshold notifies once, with the qualified figure', () => {
  grantedNotification(); hide()
  const rules = { ...DEFAULT_RULES, cost: true, costThresholdUsd: 5 }
  const hook = renderHook(({ value }) => useAttentionAlerts(empty, { rules, sessions: [], cost: usageOf(value) }), { initialProps: { value: 1 as number | null } })
  hook.rerender({ value: 6 })
  hook.rerender({ value: 7 })
  assert.equal(FakeNotification.shown.length, 1)
  assert.equal(FakeNotification.shown[0].body, 'Context cost estimate reached ~$6.00 (threshold $5.00)')
})

test('triggers: nothing is sent while the history replays', () => {
  grantedNotification(); hide()
  const rules = { ...DEFAULT_RULES, cost: true, costThresholdUsd: 5 }
  const hook = renderHook(({ value, replaying }) => useAttentionAlerts(empty, { rules, sessions: [], cost: usageOf(value), replaying }),
    { initialProps: { value: null as number | null, replaying: true } })
  hook.rerender({ value: 9, replaying: true })
  hook.rerender({ value: 9, replaying: false })
  assert.equal(FakeNotification.shown.length, 0)
})

test('triggers: turning a rule off hides its alert, the others still fire', () => {
  grantedNotification(); hide()
  const rules = { ...DEFAULT_RULES, error: false }
  const hook = renderHook(({ agents }) => useAttentionAlerts(summarizeAttention(agents, NOW), { rules }), { initialProps: { agents: [] as AttentionAgent[] } })
  hook.rerender({ agents: [blocked('s1:a', 'error')] })
  assert.equal(FakeNotification.shown.length, 0)
  hook.rerender({ agents: [blocked('s1:a', 'error'), blocked('s2:a', 'waiting_permission')] })
  assert.equal(FakeNotification.shown.length, 1)
  assert.equal(FakeNotification.shown[0].body, '1 waiting')
})

test('native channel (VS Code): sends the item to the extension, no browser permission, not gated on document.hidden', async () => {
  FakeNotification.permission = 'default'; FakeNotification.asked = 0; FakeNotification.shown = []
  g.Notification = FakeNotification
  const sent: Array<{ trigger: string; title: string; body: string }> = []
  const hook = renderHook(({ agents }) => useAttentionAlerts(summarizeAttention(agents, NOW), { native: item => sent.push(item) }), { initialProps: { agents: [] as AttentionAgent[] } })
  assert.equal(hook.result.current.notifyState, 'off')
  await act(async () => { await hook.result.current.toggleNotify() })
  assert.equal(FakeNotification.asked, 0, 'the browser permission is irrelevant in VS Code')
  assert.equal(hook.result.current.notifyState, 'on')
  hook.rerender({ agents: [blocked('s1:a', 'error')] })
  assert.deepEqual(sent, [{ trigger: 'attention', title: 'Agent Lens', body: '1 error' }])
  assert.equal(FakeNotification.shown.length, 0)
})

test('rules hook: persisted per browser, defaults without storage', () => {
  const hook = renderHook(() => useNotificationRules())
  assert.deepEqual(hook.result.current.rules, DEFAULT_RULES)
  act(() => hook.result.current.setRules({ ...DEFAULT_RULES, complete: true }))
  assert.equal(hook.result.current.rules.complete, true)
  assert.match(localStorage.getItem(NOTIFY_RULES_STORAGE_KEY) ?? '', /"complete":true/)
  hook.unmount()
  const again = renderHook(() => useNotificationRules())
  assert.equal(again.result.current.rules.complete, true)
})

const settingsProps = (over: Record<string, unknown> = {}) => ({
  open: true, onClose: noop, hexGrid: true, onHexGridChange: noop, muted: false, onToggleMute: noop,
  showMode: 'active' as const, onShowModeChange: noop, singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop, ...over,
})

test('settings: a Notifications section with one named switch per trigger and a labelled threshold', () => {
  const changes: NotificationRules[] = []
  let toggled = 0
  const view = render(<SettingsDialog {...settingsProps({
    notifications: { state: 'on', onToggle: () => { toggled++ }, rules: DEFAULT_RULES, onRulesChange: (r: NotificationRules) => changes.push(r) },
  })} />)
  // Settings sit in tabs since #533: the Notifications section is in its own tab
  fireEvent.click(view.getByRole('tab', { name: 'Notifications and announcements' }))
  view.getByRole('region', { name: 'Notifications' })
  const master = view.getByRole('switch', { name: /Enable notifications/ }) as HTMLInputElement
  assert.equal(master.checked, true)
  fireEvent.click(master)
  assert.equal(toggled, 1)
  for (const name of ['Agent waiting for a permission', 'Agent in error', 'Session finished', 'Cost threshold reached']) view.getByRole('switch', { name: new RegExp(name) })
  fireEvent.click(view.getByRole('switch', { name: /Session finished/ }))
  assert.equal(changes.at(-1)?.complete, true)
  const amount = view.getByRole('spinbutton', { name: /Cost threshold \(USD\)/ }) as HTMLInputElement
  assert.equal(amount.disabled, true, 'enabled only with the cost rule')
  view.rerender(<SettingsDialog {...settingsProps({
    notifications: { state: 'on', onToggle: noop, rules: { ...DEFAULT_RULES, cost: true }, onRulesChange: (r: NotificationRules) => changes.push(r) },
  })} />)
  const enabled = view.getByRole('spinbutton', { name: /Cost threshold \(USD\)/ }) as HTMLInputElement
  fireEvent.change(enabled, { target: { value: '12' } })
  assert.equal(changes.at(-1)?.costThresholdUsd, 12)
  fireEvent.change(enabled, { target: { value: '-4' } })
  assert.equal(changes.at(-1)?.costThresholdUsd, 12, 'an invalid amount is not applied')
  view.getByText(/Invalid amount/)
})

test('settings: notifications blocked or unsupported are said, never silently off', () => {
  const blockedView = render(<SettingsDialog {...settingsProps({ notifications: { state: 'denied', onToggle: noop, rules: DEFAULT_RULES, onRulesChange: noop } })} />)
  fireEvent.click(blockedView.getByRole('tab', { name: 'Notifications and announcements' }))
  blockedView.getByText(/blocked in the browser settings/)
  blockedView.unmount()
  const unsupported = render(<SettingsDialog {...settingsProps({ notifications: { state: 'unsupported', onToggle: noop, rules: DEFAULT_RULES, onRulesChange: noop } })} />)
  fireEvent.click(unsupported.getByRole('tab', { name: 'Notifications and announcements' }))
  unsupported.getByText(/not available in this environment/)
})

test('bridge: notify posts a typed message to the extension, and nothing outside VS Code', async () => {
  const { vscodeBridge } = await import('@/lib/vscode-bridge')
  assert.ok(vscodeBridge)
  const posted: Array<Record<string, unknown>> = []
  vscodeBridge.notify({ trigger: 'cost', title: 'Agent Lens', body: 'x' })
  assert.equal(posted.length, 0, 'standalone: no-op')
  vscodeBridge.configureWebviewApi(msg => posted.push(msg))
  vscodeBridge.notify({ trigger: 'cost', title: 'Agent Lens', body: 'Cost reached $6.00 (threshold $5.00)' })
  assert.deepEqual(posted.at(-1), { type: 'notify', trigger: 'cost', title: 'Agent Lens', body: 'Cost reached $6.00 (threshold $5.00)' })
})
