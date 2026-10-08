// Wiring of active time (#59) in the REAL useAgentSimulation hook: events go in through externalEvents,
// time comes from a fake clock. Deleting trackActiveTime / carryActiveTime from the hook must fail here.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { observedSessions } from '@/lib/session-model'
import type { SimulationEvent, Agent } from '@/lib/agent-types'

const T0 = 1_700_000_000_000
const FRAME_MS = 20

const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
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
type Props = { events: readonly SimulationEvent[] }

function mount() {
  const view = renderHook(
    (p: Props) => useAgentSimulation({
      useMockData: false, externalEvents: p.events, sessionFilter: null, onExternalEventsConsumed: () => { consumed++ },
    }),
    { initialProps: { events: [] } as Props },
  )
  act(() => { view.result.current.play() })
  return view
}
type View = ReturnType<typeof mount>

function frames(n = 4) {
  for (let i = 0; i < n; i++) act(() => { mock.timers.tick(FRAME_MS) })
}
function advance(ms: number) {
  act(() => { mock.timers.tick(ms) })
}
function send(view: View, events: SimulationEvent[]) {
  consumed = 0
  view.rerender({ events })
  for (let i = 0; i < 5 && consumed === 0; i++) frames(1)
  assert.equal(consumed, 1, 'the batch was consumed by exactly one frame')
  view.rerender({ events: [] })
  frames(3)
}
function byName(view: View, name: string): Agent {
  const found = [...view.result.current.frameRef.current.agents.values()].find(a => a.localId === name)
  assert.ok(found, `agent ${name} exists`)
  return found
}

const spawn = (name: string, time = 0): SimulationEvent =>
  ({ sessionId: 's1', time, type: 'agent_spawn', payload: { name, isMain: true, task: 't' } })
const toolStart = (name: string, time: number): SimulationEvent =>
  ({ sessionId: 's1', time, type: 'tool_call_start', payload: { agent: name, tool: 'Read', args: 'a.ts' } })
const complete = (name: string, time: number): SimulationEvent =>
  ({ sessionId: 's1', time, type: 'agent_complete', payload: { name } })

test('a never-working agent has no active time (unknown, not 0)', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  assert.equal(byName(view, 'alpha').activeMs, undefined)
  assert.equal(byName(view, 'alpha').activeSince, undefined)
})

test('working opens a span, a pause closes it, the pause itself is not counted', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  send(view, [toolStart('alpha', 1)])
  const a1 = byName(view, 'alpha')
  assert.equal(a1.state, 'tool_calling')
  assert.ok(a1.activeSince !== undefined && a1.activeSince >= T0, 'span opened with the wall clock')
  const started = a1.activeSince!

  advance(4_000)
  send(view, [complete('alpha', 2)])
  const a2 = byName(view, 'alpha')
  assert.equal(a2.activeSince, undefined, 'span closed')
  const closed = a2.activeMs!
  assert.ok(closed >= 4_000 && closed < 6_000, `about 4 s of work, got ${closed}`)
  assert.ok(Date.now() - started >= closed)

  advance(60_000)   // a long pause between two turns
  assert.equal(byName(view, 'alpha').activeMs, closed, 'the pause adds nothing')
})

test('seeking to a moment where the agent was idle drops the running span (no counter for an idle agent)', () => {
  const view = mount()
  send(view, [spawn('alpha', 1), toolStart('alpha', 2)])
  assert.ok(byName(view, 'alpha').activeSince !== undefined)
  advance(5_000)
  act(() => { view.result.current.seekToTime(1.5) })
  assert.equal(byName(view, 'alpha').state, 'idle')
  assert.equal(byName(view, 'alpha').activeSince, undefined)
})

test('replayed (history) events leave the active time unknown, even in one batch', () => {
  const view = mount()
  const replay = (e: SimulationEvent): SimulationEvent => ({ ...e, replayed: true })
  send(view, [replay(spawn('alpha', 1)), replay(toolStart('alpha', 2)), replay(complete('alpha', 1200))])
  assert.equal(byName(view, 'alpha').activeMs, undefined, 'not 0:00')
  assert.equal(byName(view, 'alpha').activeSince, undefined)
})

test('an agent left working by a replay does not get an invented span from the next live event', () => {
  const view = mount()
  send(view, [{ ...spawn('alpha', 1), replayed: true }, { ...toolStart('alpha', 2), replayed: true }])
  assert.equal(byName(view, 'alpha').activeSince, undefined)
  const thinkingAgain: SimulationEvent = { sessionId: 's1', time: 3, type: 'tool_call_end', payload: { agent: 'alpha', tool: 'Read', result: 'ok' } }
  send(view, [thinkingAgain])
  assert.equal(byName(view, 'alpha').activeSince, undefined, 'start of the span is unproven')
})

test('a spawned agent has no reported tokens until an event reports them (unknown, not 0)', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  assert.equal(byName(view, 'alpha').tokenStatus ?? 'unavailable', 'unavailable')
  send(view, [{ sessionId: 's1', time: 2, type: 'context_update', payload: { agent: 'alpha', tokens: 0 } }])
  assert.equal(byName(view, 'alpha').tokenStatus, 'available', 'a reported 0 is a real 0')
})

const turnEnd = (name: string, time: number): SimulationEvent =>
  ({ sessionId: 's1', time, type: 'agent_idle', payload: { name, turnEnd: true } })

test('end of turn (#107): the orchestrator is paused, the reading time after it is not counted', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  send(view, [toolStart('alpha', 1)])
  advance(4_000)
  send(view, [turnEnd('alpha', 2)])
  const paused = byName(view, 'alpha')
  assert.equal(paused.state, 'idle', 'a finished turn is a pause')
  assert.equal(paused.activeSince, undefined, 'span closed')
  const closed = paused.activeMs!
  assert.ok(closed >= 4_000 && closed < 6_000, `about 4 s of work, got ${closed}`)
  advance(40 * 60_000)
  assert.equal(byName(view, 'alpha').activeMs, closed, 'the reading pause adds nothing')
})

test('an agent_idle without turnEnd keeps the agent working (permission answered: back to thinking)', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  send(view, [toolStart('alpha', 1)])
  send(view, [{ sessionId: 's1', time: 2, type: 'agent_idle', payload: { name: 'alpha' } }])
  assert.equal(byName(view, 'alpha').state, 'thinking')
  assert.ok(byName(view, 'alpha').activeSince !== undefined)
})

test('the inactivity completion closes the span at the last event, not at its own reception (#107)', () => {
  const view = mount()
  send(view, [spawn('alpha')])
  send(view, [toolStart('alpha', 1)])
  advance(2_000)
  send(view, [{ sessionId: 's1', time: 2, type: 'tool_call_end', payload: { agent: 'alpha', tool: 'Read', result: 'ok' } }])
  advance(5 * 60_000)
  send(view, [{ ...complete('alpha', 3), payload: { name: 'alpha', inactivity: true } }])
  const a = byName(view, 'alpha')
  assert.equal(a.state, 'complete')
  assert.ok(a.activeMs! >= 2_000 && a.activeMs! < 4_000, `about 2 s of work, not 5 minutes, got ${a.activeMs}`)
})
