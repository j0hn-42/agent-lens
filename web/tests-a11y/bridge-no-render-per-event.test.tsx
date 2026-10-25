// useVSCodeBridge, real hook (#645): a live event of the displayed session is queued by reference for the
// rAF loop and does not re-render the tree by itself; the simulation's own throttle (250 ms) decides the commits.
// The numbers below count the renders of the HOOK on its own (renderHook): not the commits of the Profiler at the root
// of the app, which still follow UI_THROTTLE_MS (250 ms) because the simulation commits its state at that pace.
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

test('events of a session that is not displayed: a render for the first two (activity mark, visibility), none for the next ones', () => {
  let renders = 0
  const { result } = renderHook(() => { renders++; return useVSCodeBridge() })
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }) })
  act(() => { result.current.selectSession('a') })
  act(() => { result.current.flushSessionEvents('a') })
  const before = renders
  act(() => { post(ev('b', 1)) })
  assert.ok(result.current.sessionsWithActivity.has('b'))
  assert.ok(renders - before >= 1, 'the first event of the background session marks it')
  for (let i = 2; i < 5; i++) act(() => { post(ev('b', i)) })
  const settled = renders
  for (let i = 5; i < 55; i++) act(() => { post(ev('b', i)) })
  console.log(`[#613] renders for 50 more events of a background session: ${renders - settled}`)
  assert.equal(renders - settled, 0, '50 more events of the same background session re-render nothing')
})

// What the remaining bump costs, measured (#613). The rAF loop reads the queue by reference, so the bump is not what
// delivers the events: it is the single re-render that follows a flush. A reset has none of its own: the session
// state it clears re-renders already (2 renders measured, with and without a bump), so it was removed.
test('a reset re-renders through the session state it clears, with no bump of its own', () => {
  let renders = 0
  const { result } = renderHook(() => { renders++; return useVSCodeBridge() })
  act(() => { post({ type: 'session-list', sessions: [info('a')] }) })
  act(() => { result.current.selectSession('a') })
  act(() => { result.current.flushSessionEvents('a') })
  const before = renders
  act(() => { post({ type: 'reset', reason: 'panel-reopened' }) })
  assert.ok(renders - before >= 1, 'rendered')
  assert.equal(result.current.sessions.length, 0)
  assert.equal(result.current.selectedSessionId, null)
})

test('a flush costs one render per call (the switch of session or the restart), whatever the number of events replayed', () => {
  let renders = 0
  const { result } = renderHook(() => { renders++; return useVSCodeBridge() })
  act(() => {
    post({ type: 'session-list', sessions: [info('a')] })
    for (let i = 0; i < 20; i++) post(ev('a', i))
  })
  act(() => { result.current.selectSession('a') })
  const before = renders
  act(() => { result.current.flushSessionEvents('a') })
  assert.equal(renders - before, 1)
  assert.equal(result.current.pendingEvents.length, 20, 'the 20 events are queued for the loop')
})
