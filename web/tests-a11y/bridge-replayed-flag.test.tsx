// Events of a history batch are flagged `replayed` by the bridge; a single live event is not (#59).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { vscodeBridge, type AgentEvent } from '@/lib/vscode-bridge'

const post = (data: unknown) =>
  window.dispatchEvent(new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data }))

test('batch events are flagged replayed, a single event is not', () => {
  assert.ok(vscodeBridge)
  const got: AgentEvent[] = []
  const off = vscodeBridge.onEvent(e => { got.push(e) })
  const ev = { time: 1, type: 'agent_spawn', payload: { name: 'a' }, sessionId: 's' }
  post({ type: 'agent-event-batch', events: [ev, { ...ev, time: 2 }] })
  post({ type: 'agent-event', event: { ...ev, time: 3 } })
  if (typeof off === 'function') off()
  assert.deepEqual(got.map(e => e.replayed), [true, true, undefined])
})
