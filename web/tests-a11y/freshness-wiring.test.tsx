// Wiring of freshness (#48) and session observation (#52) in the REAL useAgentSimulation hook:
// events go in through externalEvents, time comes from a fake clock (Date and timers are mocked).
// Deleting stampTouchedAgents, carryFreshness or the observedSessions.mark loop must fail a test here.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { observedSessions } from '@/lib/session-model'
import { deriveFreshness } from '@/hooks/simulation/freshness'
import { STALE_AFTER_MS } from '@/lib/canvas-constants'
import type { SimulationEvent, Agent } from '@/lib/agent-types'

const T0 = 1_700_000_000_000
const FRAME_MS = 20

const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
  // The shared setup schedules frames with setTimeout(0), which a mocked clock would re-run forever
  // inside one tick: use one real-sized frame instead
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => { act(() => { cb(Date.now()) }) }, FRAME_MS) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
  observedSessions.clear()
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  observedSessions.clear()
})

let consumed = 0
type Props = { events: readonly SimulationEvent[]; filter: string | null }

function mount(filter: string | null = null) {
  const view = renderHook(
    (p: Props) => useAgentSimulation({
      useMockData: false, externalEvents: p.events, sessionFilter: p.filter, onExternalEventsConsumed: () => { consumed++ },
    }),
    { initialProps: { events: [], filter } as Props },
  )
  act(() => { view.result.current.play() })
  return view
}
type View = ReturnType<typeof mount>

/** Run a few animation frames of the fake clock (each rAF is a mocked setTimeout). */
function frames(n = 4) {
  for (let i = 0; i < n; i++) act(() => { mock.timers.tick(FRAME_MS) })
}
function advance(ms: number) {
  act(() => { mock.timers.tick(ms) })
}

/** Deliver a batch exactly once, like the bridge does: one frame consumes it, then the queue is emptied. */
function send(view: View, events: SimulationEvent[], filter: string | null = null) {
  consumed = 0
  view.rerender({ events, filter })
  for (let i = 0; i < 5 && consumed === 0; i++) frames(1)
  assert.equal(consumed, 1, 'the batch was consumed by exactly one frame')
  view.rerender({ events: [], filter })
  frames(3)
}

function byName(view: View, name: string): Agent {
  const found = [...view.result.current.frameRef.current.agents.values()].find(a => a.localId === name)
  assert.ok(found, `agent ${name} exists`)
  return found
}

const spawn = (session: string, name: string, time = 0): SimulationEvent =>
  ({ sessionId: session, time, type: 'agent_spawn', payload: { name, isMain: true, task: 't' } })
const tool = (session: string, name: string, time: number): SimulationEvent =>
  ({ sessionId: session, time, type: 'tool_call_start', payload: { agent: name, tool: 'Read', args: 'a.ts' } })

test('live events stamp exactly the agents they touch with the wall clock, and only those', () => {
  const view = mount()
  send(view, [spawn('s1', 'alpha'), spawn('s1', 'beta')])
  const alpha0 = byName(view, 'alpha').lastEventAt
  const beta0 = byName(view, 'beta').lastEventAt
  assert.ok(alpha0 !== undefined && alpha0 >= T0, 'alpha is stamped with the (fake) wall clock')
  assert.ok(beta0 !== undefined && beta0 >= T0, 'beta is stamped with the (fake) wall clock')
  assert.equal(byName(view, 'alpha').freshnessSource, 'live')

  const silence = STALE_AFTER_MS + 5_000
  advance(silence)
  send(view, [tool('s1', 'alpha', 100)])
  const alpha1 = byName(view, 'alpha').lastEventAt!
  assert.ok(alpha1 >= T0 + silence, 'the touched agent is re-stamped with the new wall clock')
  assert.equal(byName(view, 'beta').lastEventAt, beta0, 'an untouched agent keeps its old stamp')
  const now = Date.now()
  assert.equal(deriveFreshness(byName(view, 'alpha'), now), 'fresh')
  assert.equal(deriveFreshness(byName(view, 'beta'), now), 'stale', 'silent for more than 30 s: stale')
})

test('seeking rebuilds the agents from the log but keeps their wall-clock freshness', () => {
  const view = mount()
  send(view, [spawn('s1', 'alpha', 1), tool('s1', 'alpha', 2)])
  const stamp = byName(view, 'alpha').lastEventAt!
  advance(10_000)
  act(() => { view.result.current.seekToTime(1.5) })
  const after = byName(view, 'alpha')
  assert.equal(after.lastEventAt, stamp, 'the stamp survives the replay')
  assert.equal(after.freshnessSource, 'live')
})

test('every received event marks its session observed, even when the view filters it out', () => {
  const view = mount('s1')
  assert.equal(observedSessions.has('s1'), false)
  assert.equal(observedSessions.has('s2'), false)
  send(view, [spawn('s1', 'alpha'), spawn('s2', 'other')], 's1')
  assert.equal(observedSessions.has('s1'), true, 'the viewed session is observed')
  assert.equal(observedSessions.has('s2'), true, 'a session filtered out of the view was still heard from')
  assert.equal(observedSessions.has('s3'), false, 'no event, no mark')
  assert.equal([...view.result.current.frameRef.current.agents.values()].some(a => a.localId === 'other'), false, 'the filtered event is not drawn')
})
