// #36 D2 through the REAL useVSCodeBridge: the session list and the replayed events reach the bridge in
// the same tick (one act), before React re-renders. A finished session must not be stamped as active.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const H = 3_600_000
const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const ev = (sessionId: string) => ({
  type: 'agent-event',
  event: { time: 1, type: 'agent_spawn', payload: { name: 'main', isMain: true }, sessionId },
})
const info = (id: string, status: 'active' | 'completed', ago: number) => ({
  id, label: id, status, startTime: Date.now() - 5 * H, lastActivityTime: Date.now() - ago,
})

test('list + replayed events in the same tick: the finished session is not stamped active', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('old', 'completed', 3 * H), info('live', 'active', 1000)] })
    post(ev('old'))
    post(ev('old'))
    post(ev('live'))
  })
  assert.equal(result.current.finishedSessionCount, 1)
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  assert.deepEqual([...(result.current.allViewSessionIds ?? [])].sort(), ['live'])
})

test('a session announced by session-started in the same tick is known to the event handler', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => {
    post({ type: 'session-list', sessions: [info('live', 'active', 1000)] })
    post({ type: 'session-started', session: info('old', 'completed', 3 * H) })
    post(ev('old'))
    post(ev('live'))
  })
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  assert.deepEqual([...(result.current.allViewSessionIds ?? [])].sort(), ['live'])
})
