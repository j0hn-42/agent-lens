// useVSCodeBridge, real hook: (1) the events re-fed when the session selection changes are history
// (`replayed: true`, #59) on both flush paths, single session and 'All'; (2) a session known only from
// the index (#66) loses `indexedOnly` once it is watched live, and is never listed as a finished session.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const ev = (sessionId: string, time: number) => ({
  type: 'agent-event',
  event: { time, type: 'agent_spawn', payload: { name: `main-${sessionId}`, isMain: true }, sessionId },
})
const info = (id: string, extra: Record<string, unknown> = {}) => ({
  id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), ...extra,
})

test('flush of a single session re-feeds its buffered events flagged replayed', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
    post(ev('a', 1)); post(ev('b', 2)); post(ev('b', 3))
  })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b') })
  const pending = result.current.pendingEvents
  assert.deepEqual(pending.map(e => e.sessionId), ['b', 'b'], 'only the selected session is re-fed')
  assert.ok(pending.every(e => e.replayed === true), 'history, not live activity')
})

test('flush from an index skips what was already consumed, the rest stays replayed', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('b')] })
    post(ev('b', 1)); post(ev('b', 2))
  })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b', 1) })
  const pending = result.current.pendingEvents
  assert.deepEqual(pending.map(e => e.time), [2])
  assert.equal(pending[0].replayed, true)
})

test("flush of 'All' re-feeds the events of the visible sessions flagged replayed", () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
    post(ev('a', 1)); post(ev('b', 2))
  })
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
  const pending = result.current.pendingEvents
  assert.deepEqual(pending.map(e => e.sessionId).sort(), ['a', 'b'])
  assert.ok(pending.every(e => e.replayed === true))
})

test('an indexed-only session is not a finished session; once started live it drops indexedOnly', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('live'), info('idx', { status: 'completed', indexedOnly: true, lastActivityTime: 1 })] })
  })
  assert.equal(result.current.finishedSessionCount, 0, 'the index proves no end: not counted as finished')
  assert.equal(result.current.sessions.find(s => s.id === 'idx')?.indexedOnly, true)
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  assert.deepEqual([...(result.current.allViewSessionIds ?? [])], ['live'], 'never drawn in All')

  act(() => { post({ type: 'session-started', session: info('idx') }) })
  const adopted = result.current.sessions.find(s => s.id === 'idx')!
  assert.equal(adopted.indexedOnly, undefined, 'watched live: the flag is gone')
  assert.equal(adopted.status, 'active')
  assert.equal(result.current.sessions.filter(s => s.id === 'idx').length, 1, 'no duplicate entry')
})
