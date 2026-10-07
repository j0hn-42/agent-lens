import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isAgentEvent, isSessionInfo, isConnectionStatus } from '../web/lib/bridge-types'

test('isAgentEvent rejects structurally invalid payloads', () => {
  assert.equal(isAgentEvent({ time: 1, type: 'x', payload: {} }), true)
  assert.equal(isAgentEvent({ time: 1, type: 'x', payload: {}, sessionId: 's' }), true)
  for (const bad of [undefined, null, 'x', [], {}, { time: 'a', type: 'x', payload: {} }, { time: 1, type: 'x' },
    { time: 1, type: 'x', payload: null }, { time: NaN, type: 'x', payload: {} }, { time: 1, type: 'x', payload: {}, sessionId: 3 }]) {
    assert.equal(isAgentEvent(bad), false)
  }
})

test('isSessionInfo and isConnectionStatus validate shapes', () => {
  const ok = { id: 'a', label: 'b', status: 'active', startTime: 1, lastActivityTime: 2 }
  assert.equal(isSessionInfo(ok), true)
  assert.equal(isSessionInfo({ ...ok, status: 'weird' }), false)
  assert.equal(isSessionInfo({ ...ok, id: 5 }), false)
  assert.equal(isSessionInfo(null), false)
  assert.equal(isConnectionStatus('watching'), true)
  assert.equal(isConnectionStatus('nope'), false)
  assert.equal(isConnectionStatus(undefined), false)
})
