// Per-session replay buffers of the bridge are bounded (#209): capped per session with an absolute base counter,
// bounded in number of sessions, freed when a session is removed; the cap keeps the graph rebuildable.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import {
  SESSION_BUFFER_MAX_EVENTS, SESSION_BUFFER_MAX_SESSIONS, SESSION_BUFFER_LIFECYCLE_RESERVE,
  createSessionBuffers, appendSessionEvent, releaseSessionBuffer, sessionEventCount, sessionEventsFrom,
} from '@/lib/session-buffers'
import { RELAY_MAX_EVENTS_PER_SESSION, RELAY_MAX_BUFFERED_SESSIONS, RELAY_REPLAY_LIFECYCLE_RESERVE } from '../../extension/src/constants'
import type { SimulationEvent } from '@/lib/agent-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const sev = (sessionId: string, time: number, type = 'agent_activity'): SimulationEvent =>
  ({ time, type: type as SimulationEvent['type'], payload: { name: 'main' }, sessionId })

test('caps mirror the relay bounds', () => {
  assert.equal(SESSION_BUFFER_MAX_EVENTS, RELAY_MAX_EVENTS_PER_SESSION)
  assert.equal(SESSION_BUFFER_MAX_SESSIONS, RELAY_MAX_BUFFERED_SESSIONS)
  assert.equal(SESSION_BUFFER_LIFECYCLE_RESERVE, RELAY_REPLAY_LIFECYCLE_RESERVE)
})

test('N+k events leave N entries, the lifecycle event survives, positions stay absolute', () => {
  const s = createSessionBuffers()
  appendSessionEvent(s, 'a', sev('a', 0, 'agent_spawn'))
  for (let i = 1; i < SESSION_BUFFER_MAX_EVENTS + 25; i++) appendSessionEvent(s, 'a', sev('a', i))
  const buf = s.events.get('a')!
  assert.equal(buf.length, SESSION_BUFFER_MAX_EVENTS)
  assert.equal(buf[0].type, 'agent_spawn', 'spawn kept so the graph can be rebuilt')
  const total = sessionEventCount(s, 'a')
  assert.equal(total, SESSION_BUFFER_MAX_EVENTS + 25)
  assert.deepEqual(sessionEventsFrom(s, 'a', total - 2).map(e => e.time), [total - 2, total - 1])
  assert.equal(sessionEventsFrom(s, 'a', total).length, 0)
})

test('the number of buffered sessions is bounded, least recently written first, protected one kept', () => {
  const s = createSessionBuffers()
  for (let i = 0; i < SESSION_BUFFER_MAX_SESSIONS + 5; i++) appendSessionEvent(s, `s${i}`, sev(`s${i}`, i), 's0')
  assert.equal(s.events.size, SESSION_BUFFER_MAX_SESSIONS)
  assert.ok(s.events.has('s0'), 'selected session is never evicted')
  assert.ok(!s.events.has('s1'))
  assert.ok(s.events.has(`s${SESSION_BUFFER_MAX_SESSIONS + 4}`))
})

test('a released buffer keeps its absolute positions: a cursor taken before release still sees later events', () => {
  const s = createSessionBuffers()
  for (let i = 0; i < 30; i++) appendSessionEvent(s, 'a', sev('a', i))
  const cursor = sessionEventCount(s, 'a') // what the visualizer caches with its snapshot
  releaseSessionBuffer(s, 'a')
  assert.equal(s.events.has('a'), false, 'events are freed')
  assert.equal(sessionEventCount(s, 'a'), cursor, 'count never goes back')
  appendSessionEvent(s, 'a', sev('a', 100))
  appendSessionEvent(s, 'a', sev('a', 101))
  assert.deepEqual(sessionEventsFrom(s, 'a', cursor).map(e => e.time), [100, 101])

  // Same through the session-count eviction
  for (let i = 0; i < SESSION_BUFFER_MAX_SESSIONS + 1; i++) appendSessionEvent(s, `o${i}`, sev(`o${i}`, i))
  assert.equal(s.events.has('a'), false, 'evicted as least recently written')
  const cursor2 = sessionEventCount(s, 'a')
  assert.equal(cursor2, cursor + 2)
  appendSessionEvent(s, 'a', sev('a', 200))
  assert.deepEqual(sessionEventsFrom(s, 'a', cursor2).map(e => e.time), [200])
})

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })
const bev = (sessionId: string, time: number, type: string) => ({
  type: 'agent-event', event: { time, type, payload: { name: 'main', isMain: true }, sessionId },
})

test('bridge: after N+k events a selected session is still rebuilt from its capped buffer; removal frees it', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
    post(bev('a', 0, 'agent_spawn'))
    for (let i = 1; i < SESSION_BUFFER_MAX_EVENTS + 10; i++) post(bev('a', i, 'agent_activity'))
    post(bev('b', 1, 'agent_spawn'))
  })
  assert.equal(result.current.getSessionEventCount('a'), SESSION_BUFFER_MAX_EVENTS + 10, 'absolute count')
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.selectSession('a') })
  act(() => { result.current.flushSessionEvents('a') })
  const pending = result.current.pendingEvents
  assert.equal(pending.length, SESSION_BUFFER_MAX_EVENTS)
  assert.equal(pending[0].type, 'agent_spawn')
  assert.ok(pending.every(e => e.replayed === true))

  const cursorB = result.current.getSessionEventCount('b')
  act(() => { result.current.removeSession('b') })
  assert.equal(result.current.getSessionEventCount('b'), cursorB, 'absolute count survives the release')
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b') })
  assert.equal(result.current.pendingEvents.length, 0, 'removed session buffer is freed')
  // An event arriving after the removal is still seen from the cursor cached with the snapshot
  act(() => { post(bev('b', 2, 'agent_activity')) })
  act(() => { result.current.selectSession('a') })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b', cursorB) })
  assert.deepEqual(result.current.pendingEvents.map(e => e.time), [2])
})
