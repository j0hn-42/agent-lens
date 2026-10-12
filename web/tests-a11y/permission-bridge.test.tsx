// Bridge side of operator decisions (#240, PR 4): the page declares its decision surface (permission-surface
// ready true, then false when it goes away or the page unloads), sends decisions, and relays the extension's
// permission-request / permission-closed / permission-result messages, validated. Nothing of it outside VS Code.
// Tests run in order: the bridge singleton cannot leave VS Code mode once it entered it.
import { test, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { vscodeBridge, type PermissionBridgeMessage } from '@/lib/vscode-bridge'

const bridge = vscodeBridge!
const NONCE = '0123456789abcdef0123456789abcdef'
const request = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, toolName: 'Bash',
  inputPreview: '{"command":"npm test"}', inputTruncated: false, inputSha256: 'b'.repeat(64),
  requestedAt: 1_000, expiresAt: 61_000, ...over,
})

let posted: Array<Record<string, unknown>> = []
let received: PermissionBridgeMessage[] = []
const off = bridge.onPermission(m => { received.push(m) })
beforeEach(() => { posted = []; received = [] })

test('outside VS Code: no surface is declared and nothing is relayed', () => {
  const sent: unknown[] = []
  const realPost = window.postMessage.bind(window)
  window.postMessage = ((m: unknown) => { sent.push(m) }) as typeof window.postMessage
  try {
    const detach = bridge.attachPermissionSurface()
    bridge.sendPermissionDecision({ sessionId: 'sess-1', toolUseId: null, nonce: NONCE, action: 'approve' })
    bridge.dispatch({ type: 'permission-request', request: request() })
    detach()
    window.dispatchEvent(new Event('pagehide'))
  } finally {
    window.postMessage = realPost
  }
  assert.deepEqual(sent, [])
  assert.deepEqual(received, [])
})

test('enter VS Code', () => {
  bridge.configureWebviewApi(msg => posted.push(msg))
  assert.equal(bridge.isVSCode, true)
})

test('the surface says ready when attached and not ready when detached, once', () => {
  const detach = bridge.attachPermissionSurface()
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: true }])
  detach()
  detach()
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: true }, { type: 'permission-surface', ready: false }])
})

test('unloading the page withdraws the surface; a later detach sends nothing more', () => {
  const detach = bridge.attachPermissionSurface()
  window.dispatchEvent(new Event('pagehide'))
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: true }, { type: 'permission-surface', ready: false }])
  detach()
  assert.equal(posted.length, 2)
})

test('beforeunload withdraws the surface too', () => {
  const detach = bridge.attachPermissionSurface()
  window.dispatchEvent(new Event('beforeunload'))
  detach()
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: true }, { type: 'permission-surface', ready: false }])
})

test('a decision is sent with exactly its fields', () => {
  bridge.sendPermissionDecision({ sessionId: 'sess-1', toolUseId: null, nonce: NONCE, action: 'deny' })
  assert.deepEqual(posted, [{ type: 'permission-decision', sessionId: 'sess-1', toolUseId: null, nonce: NONCE, action: 'deny' }])
})

test('incoming request, closing and result are relayed', () => {
  bridge.dispatch({ type: 'permission-request', request: request() })
  bridge.dispatch({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: null, outcome: 'expired' })
  bridge.dispatch({ type: 'permission-result', nonce: null, ok: false, reason: 'disabled' })
  bridge.dispatch({ type: 'permission-result', nonce: NONCE, ok: true })
  assert.deepEqual(received, [
    { kind: 'request', request: request() },
    { kind: 'closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: null, outcome: 'expired' },
    { kind: 'result', nonce: null, ok: false, reason: 'disabled' },
    { kind: 'result', nonce: NONCE, ok: true },
  ])
})

test('malformed messages are dropped', () => {
  bridge.dispatch({ type: 'permission-request', request: request({ nonce: 'XYZ' }) })
  bridge.dispatch({ type: 'permission-request', request: request({ inputSha256: 'nope' }) })
  bridge.dispatch({ type: 'permission-request', request: request({ toolUseId: 7 }) })
  bridge.dispatch({ type: 'permission-request', request: request({ inputTruncated: 'yes' }) })
  bridge.dispatch({ type: 'permission-request' })
  bridge.dispatch({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: null })
  bridge.dispatch({ type: 'permission-result', nonce: NONCE, ok: 'true' })
  assert.deepEqual(received, [])
  off()
})
