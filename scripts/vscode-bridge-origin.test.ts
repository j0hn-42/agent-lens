import { test, before } from 'node:test'
import { strict as assert } from 'node:assert'

// Minimal window stub: the bridge singleton registers its 'message' listener at import time.
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
const send = (data: unknown, source: unknown) => { for (const l of listeners) l({ data, source, origin: 'http://evil.example' }) }
const event = { type: 'agent-event', event: { time: 1, type: 'x', payload: {} } }

test('messages from a source other than window.parent are ignored', () => {
  let received = 0
  bridge.onEvent(() => { received++ })
  send({ type: '__vscode-bridge-init' }, {})
  send(event, {})
  send(event, fakeWindow)
  assert.equal(bridge.isVSCode, false)
  assert.equal(received, 0)
})

test('top-level page (parent === window) ignores every message', () => {
  fakeWindow.parent = fakeWindow
  let received = 0
  bridge.onEvent(() => { received++ })
  send({ type: '__vscode-bridge-init' }, fakeWindow)
  send(event, fakeWindow)
  assert.equal(bridge.isVSCode, false)
  assert.equal(received, 0)
  fakeWindow.parent = parent
})

test('messages from window.parent in an iframe are accepted', () => {
  let received = 0
  bridge.onEvent(() => { received++ })
  send({ type: '__vscode-bridge-init' }, parent)
  send(event, parent)
  assert.equal(bridge.isVSCode, true)
  assert.equal(received, 1)
})
