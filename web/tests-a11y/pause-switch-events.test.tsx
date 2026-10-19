// #248: events that arrived while the view was paused (queued, never handed to the simulation) must
// survive a session switch, and a switch must not leave the UI claiming "review" over a playing view.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderHook, render, act, cleanup, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

const realGetContext = window.HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  const ctx: any = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
})

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, time: number, type = 'agent_activity') => ({
  type: 'agent-event', event: { time, type, payload: { name: `main-${sessionId}`, isMain: true }, sessionId },
})
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

test('events queued while paused are not counted as consumed when the session is left', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')); post(ev('b', 2)) })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b') })
  act(() => { result.current.consumeEvents() }) // the simulation took the two events
  act(() => { post(ev('b', 3)); post(ev('b', 4)) }) // paused: they stay queued
  assert.equal(result.current.pendingEvents.length, 2)
  act(() => { result.current.selectSession('a') })
  assert.equal(result.current.getSessionEventCount('b'), 2, 'only the two consumed events are behind the cursor')
  act(() => { result.current.flushSessionEvents('a') })
  act(() => { post(ev('b', 5)) })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b', 2) })
  assert.deepEqual(result.current.pendingEvents.map(e => e.time), [3, 4, 5], 'nothing received while paused is lost')
})

test('events arriving between the switch and the state swap are not skipped either', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')) })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b') })
  act(() => { result.current.consumeEvents() })
  act(() => { result.current.selectSession('a') })
  act(() => { post(ev('b', 2)) }) // switch pending: not delivered to any queue
  assert.equal(result.current.getSessionEventCount('b'), 1)
  act(() => { result.current.flushSessionEvents('a') })
  assert.equal(result.current.getSessionEventCount('b'), 2, 'once the swap is done the live count is back')
})

test("the 'All' view keeps the cursor of what it really consumed, paused events included", () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('a', 1, 'agent_spawn')); post(ev('b', 2, 'agent_spawn')) })
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
  act(() => { result.current.consumeEvents() })
  act(() => { post(ev('a', 3)); post(ev('b', 4)) })
  act(() => { result.current.selectSession('a') })
  assert.equal(result.current.getSessionEventCount(ALL_SESSIONS_ID), 2)
})

test('a replay flush still waiting in the queue is not counted as consumed', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')); post(ev('b', 2)) })
  act(() => { result.current.selectSession('b') })
  act(() => { result.current.flushSessionEvents('b') }) // paused before the loop took them
  act(() => { result.current.selectSession('a') })
  assert.equal(result.current.getSessionEventCount('b'), 0)
})

test('leaving the review when the session changes: the view plays, the bar says live again', async () => {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
  })
  await wait(100)
  await act(async () => { post(ev('a', 1, 'agent_spawn')); post(ev('b', 1, 'agent_spawn')) })
  // A message gives the timeline an event: Review is unavailable on an empty one (#383)
  await act(async () => { post({ type: 'agent-event', event: { time: 2, type: 'message', payload: { agent: 'main-a', role: 'assistant', content: 'hello' }, sessionId: 'a' } }) })
  // #440: the message reaches the timeline with the simulation's throttled UI commit (UI_THROTTLE_MS after the
  // previous one), not at a fixed time: wait until Review is available, a click on the grayed button does nothing
  const review = () => r.getByRole('button', { name: 'Pause and review history' })
  const deadline = Date.now() + 20_000
  while (review().getAttribute('aria-disabled') === 'true' && Date.now() < deadline) await wait(50)
  assert.notEqual(review().getAttribute('aria-disabled'), 'true', 'the message reached the timeline: Review is available')
  await act(async () => { fireEvent.click(review()) })
  assert.ok(r.queryByRole('button', { name: 'Resume live' }), 'review mode is on')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions:/ })) })
  await wait(100)
  const rows = Array.from(r.container.querySelectorAll<HTMLElement>('[data-row-main]'))
  await act(async () => { fireEvent.click(rows[rows.length - 1]) })
  await wait(300)
  assert.equal(r.queryByRole('button', { name: 'Resume live' }), null, 'no review bar over a playing view')
  assert.ok(r.queryByRole('button', { name: 'Pause and review history' }))
  assert.match(r.container.ownerDocument.body.textContent ?? '', /Review ended/, 'announced in the status region')
})
