// #36 D2 through the REAL useVSCodeBridge: the session list and the replayed events reach the bridge in
// the same tick (one act), before React re-renders. A finished session must not be stamped as active.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const H = 3_600_000
const post = (data: unknown) => vscodeBridge!.dispatch(data)
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

test('with a project scope, the finished count only covers the sessions of that project (#372: the bar says how many the filter hides)', () => {
  const { result } = renderHook(() => useVSCodeBridge({ projectScope: 'p1' }))
  act(() => {
    post({ type: 'session-list', sessions: [
      { ...info('old1', 'completed', 3 * H), projectId: 'p1', projectName: 'one' },
      { ...info('old2', 'completed', 3 * H), projectId: 'p2', projectName: 'two' },
      { ...info('live', 'active', 1000), projectId: 'p1', projectName: 'one' },
    ] })
  })
  // old2 is out of the view because of the project, not of the filter: turning the filter off would not show it
  assert.equal(result.current.finishedSessionCount, 1)
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
