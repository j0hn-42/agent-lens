// useVSCodeBridge, real hook (#645): a live event of the displayed session is queued by reference for the
// rAF loop and does not re-render the tree by itself; the simulation's own throttle (250 ms) decides the commits.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, time: number) => ({
  type: 'agent-event',
  event: { time, type: 'agent_spawn', payload: { name: `main-${sessionId}`, isMain: true }, sessionId },
})
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })

const COUNT = 200

test(`${COUNT} live events of the displayed session commit no React render, yet all reach the pending queue`, () => {
  let renders = 0
  const { result } = renderHook(() => { renders++; return useVSCodeBridge() })
  act(() => { post({ type: 'session-list', sessions: [info('a')] }) })
  act(() => { result.current.selectSession('a') })
  act(() => { result.current.flushSessionEvents('a') })
  const before = renders
  for (let i = 0; i < COUNT; i++) act(() => { post(ev('a', i)) })
  const commits = renders - before
  console.log(`[#645] commits for ${COUNT} events of the displayed session: ${commits}`)
  assert.equal(commits, 0, 'an event alone triggers no render')
  assert.equal(result.current.pendingEvents.length, COUNT, 'the rAF loop still finds every event in the queue')
  assert.ok(result.current.pendingEvents.every(e => e.replayed !== true), 'live events, not history')
  act(() => { result.current.consumeEvents() })
  assert.equal(result.current.pendingEvents.length, 0, 'consumed in place')
})

test('an event of a session that is not displayed still marks its activity (one render, not one per event)', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }) })
  act(() => { result.current.selectSession('a') })
  act(() => { post(ev('b', 1)) })
  assert.ok(result.current.sessionsWithActivity.has('b'))
})
