// The locale reaches the real notification channels (#373): the hook, not only the pure evaluateTriggers, composes the text.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useAttentionAlerts } from '@/hooks/use-attention-alerts'
import { setLocaleChoice } from '@/lib/locale'
import { summarizeAttention, type AttentionAgent } from '@/lib/attention'
import type { NotifyItem } from '@/lib/notification-rules'
import type { UsageTotal } from '@/lib/usage'

const g = globalThis as unknown as { Notification?: unknown }
const realNotification = g.Notification
const NOW = 1_000_000
const ALL_RULES = { permission: true, error: true, complete: true, cost: true, costThresholdUsd: 5 }
const agent = (id: string, state: string): AttentionAgent => ({ id, sessionId: id.split(':')[0], state, lastEventAt: NOW - 100 })
const cost = (value: number): UsageTotal => ({ value, status: 'complete', estimated: false })
type Session = { id: string; label: string; status: 'active' | 'completed' }

class FakeNotification {
  static permission = 'granted'
  static shown: Array<{ title: string; body?: string }> = []
  static requestPermission() { return Promise.resolve('granted') }
  constructor(title: string, opts?: { body?: string }) { FakeNotification.shown.push({ title, body: opts?.body }) }
}

beforeEach(() => {
  document.title = 'Agent Lens'
  try { localStorage.clear() } catch { /* none */ }
  FakeNotification.shown = []
  g.Notification = FakeNotification
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
})
afterEach(() => {
  cleanup()
  g.Notification = realNotification
  delete (document as unknown as Record<string, unknown>).hidden
  act(() => setLocaleChoice('auto'))
})

interface Props { agents: AttentionAgent[]; sessions: Session[]; cost: UsageTotal }
const before: Props = { agents: [], sessions: [{ id: 's1', label: 'Mon projet', status: 'active' }], cost: cost(1) }
const after: Props = { agents: [agent('s1:a', 'waiting_permission'), agent('s2:a', 'error')], sessions: [{ id: 's1', label: 'Mon projet', status: 'completed' }], cost: cost(6) }

function mount(native?: (item: NotifyItem) => void) {
  return renderHook(
    (p: Props) => useAttentionAlerts(summarizeAttention(p.agents, NOW), { rules: ALL_RULES, sessions: p.sessions, cost: p.cost, native }),
    { initialProps: before },
  )
}

async function fire(hook: ReturnType<typeof mount>) {
  await act(async () => { await hook.result.current.toggleNotify() })
  assert.equal(hook.result.current.notifyState, 'on')
  hook.rerender(after)
}

const FR = {
  attention: '1 agent en attente / 1 agent en erreur',
  complete: 'Session terminée : Mon projet',
  cost: /^Estimation du coût du contexte atteinte : .*6.* \(seuil .*5.*\)$/,
}
const EN = {
  attention: '1 agent waiting / 1 agent in error',
  complete: 'Session finished: Mon projet',
  cost: /^Context cost estimate reached .*6.* \(threshold .*5.*\)$/,
}

test('browser Notification: the body is in French with a French locale', async () => {
  act(() => setLocaleChoice('fr'))
  const hook = mount()
  await fire(hook)
  const bodies = FakeNotification.shown.map(n => n.body ?? '')
  assert.equal(FakeNotification.shown.length, 3, 'attention, complete and cost')
  assert.ok(bodies.includes(FR.attention), bodies.join(' | '))
  assert.ok(bodies.includes(FR.complete), bodies.join(' | '))
  assert.ok(bodies.some(b => FR.cost.test(b)), bodies.join(' | '))
  for (const b of bodies) assert.doesNotMatch(b, /waiting|in error|finished|reached|threshold/)
})

test('browser Notification: the body is in English with an English locale', async () => {
  act(() => setLocaleChoice('en'))
  const hook = mount()
  await fire(hook)
  const bodies = FakeNotification.shown.map(n => n.body ?? '')
  assert.equal(FakeNotification.shown.length, 3)
  assert.ok(bodies.includes(EN.attention), bodies.join(' | '))
  assert.ok(bodies.includes(EN.complete), bodies.join(' | '))
  assert.ok(bodies.some(b => EN.cost.test(b)), bodies.join(' | '))
})

test('native VS Code channel: the items handed to the extension are in French, then in English', async () => {
  for (const [choice, expected] of [['fr', FR], ['en', EN]] as const) {
    act(() => setLocaleChoice(choice))
    const sent: NotifyItem[] = []
    const hook = mount(item => { sent.push(item) })
    await fire(hook)
    const byTrigger = Object.fromEntries(sent.map(i => [i.trigger, i.body]))
    assert.equal(sent.length, 3, choice)
    assert.equal(byTrigger.attention, expected.attention)
    assert.equal(byTrigger.complete, expected.complete)
    assert.match(byTrigger.cost, expected.cost)
    cleanup()
  }
  assert.equal(FakeNotification.shown.length, 0, 'the native channel does not use the browser API')
})
