import { test, before } from 'node:test'
import { strict as assert } from 'node:assert'

// #656: the VS Code panel sends the events of one 16 ms window as one `agent-event-batch` marked `live`. Such a batch
// is live traffic: its events keep their own `replayed` flag. A batch without it is still history (relay replay, #652).
type Listener = (e: { data: unknown; source: unknown; origin: string }) => void
const listeners: Listener[] = []
const parent = { postMessage() {} }
const fakeWindow: Record<string, unknown> = {
  addEventListener: (_t: string, l: Listener) => { listeners.push(l) },
  removeEventListener() {},
  parent,
}
fakeWindow.self = fakeWindow
;(globalThis as Record<string, unknown>).window = fakeWindow

type Bridge = NonNullable<typeof import('../web/lib/vscode-bridge')['vscodeBridge']>
let bridge: Bridge
before(async () => { bridge = (await import('../web/lib/vscode-bridge')).vscodeBridge! })
const send = (data: unknown) => { for (const l of listeners) l({ data, source: parent, origin: 'vscode-webview://x' }) }
const ev = (n: number, extra: Record<string, unknown> = {}) => ({ time: n, type: 'tool_call_start', sessionId: 's', payload: { n }, ...extra })

function received(data: unknown) {
  const out: { time: number; replayed?: boolean }[] = []
  const off = bridge.onEvent(e => { out.push(e) })
  send(data)
  off()
  return out
}

test('a live batch delivers its events in order, each one as sent: a live event is not made history', () => {
  const out = received({ type: 'agent-event-batch', live: true, events: [ev(1), ev(2, { replayed: true }), ev(3)] })
  assert.deepEqual(out.map(e => e.time), [1, 2, 3])
  assert.deepEqual(out.map(e => e.replayed), [undefined, true, undefined])
})

test('a batch without live is history, as before: every event is marked replayed', () => {
  const out = received({ type: 'agent-event-batch', events: [ev(1), ev(2)] })
  assert.deepEqual(out.map(e => e.replayed), [true, true])
})

test('only live: true makes a batch live; any other value leaves it history', () => {
  for (const live of ['true', 1, false, null]) {
    const out = received({ type: 'agent-event-batch', live, events: [ev(1)] })
    assert.deepEqual(out.map(e => e.replayed), [true], `live=${JSON.stringify(live)}`)
  }
})

test('a live batch skips an invalid event and keeps the others', () => {
  const out = received({ type: 'agent-event-batch', live: true, events: [ev(1), { nope: 1 }, ev(3)] })
  assert.deepEqual(out.map(e => e.time), [1, 3])
})
