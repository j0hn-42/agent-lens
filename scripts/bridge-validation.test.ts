import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isAgentEvent, isSessionInfo, isConnectionStatus, resumeSession, type SessionInfo } from '../web/lib/bridge-types'

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

test('isSessionInfo checks the recorded start and the watched-start flag (#365)', () => {
  const ok = { id: 'a', label: 'b', status: 'active', startTime: 1, lastActivityTime: 2 }
  assert.equal(isSessionInfo({ ...ok, recordedStartTime: 0.5, startTimeWatched: false }), true)
  assert.equal(isSessionInfo({ ...ok, recordedStartTime: 'x' }), false)
  assert.equal(isSessionInfo({ ...ok, recordedStartTime: Infinity }), false)
  assert.equal(isSessionInfo({ ...ok, startTimeWatched: 'yes' }), false)
})

test('resumeSession: an announced session keeps the times the source gives, not the reception time (#365)', () => {
  const known: SessionInfo = { id: 'a', label: 'old', status: 'completed', startTime: 1, lastActivityTime: 2, indexedOnly: true }
  const announced: SessionInfo = { id: 'a', label: 'new', status: 'active', startTime: 10, recordedStartTime: 5, lastActivityTime: 20 }
  const r = resumeSession(known, announced, 999)
  assert.equal(r.status, 'active')
  assert.equal(r.lastActivityTime, 20, 'the announced last activity (file mtime), not now')
  assert.equal(r.recordedStartTime, 5)
  assert.equal(r.indexedOnly, undefined, 'now watched live')
  assert.equal(r.label, 'old', 'the known entry keeps its label (aliases)')
  const noTime = resumeSession(known, { ...announced, lastActivityTime: NaN }, 999)
  assert.equal(noTime.lastActivityTime, 999)
})
