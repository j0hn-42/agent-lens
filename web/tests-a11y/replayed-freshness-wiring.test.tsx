// Replayed history (#361) in the REAL useAgentSimulation hook: a replayed event is not a live one. The agents it
// touches get a history status (never silent), and only a non-replayed event makes them live again.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { deriveFreshness, deriveSilence } from '@/hooks/simulation/freshness'
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
const replay = (e: SimulationEvent): SimulationEvent => ({ ...e, replayed: true })

test('a replayed event gives the agent a history status, not a live one', () => {
  const view = mount()
  send(view, [replay(spawn('alpha', 1)), replay(toolStart('alpha', 2))])
  const alpha = byName(view, 'alpha')
  assert.equal(alpha.freshnessSource, 'history', 'what a replay says was not heard live')
  assert.equal(typeof alpha.lastEventAt, 'number', 'stamped with the reception time, so the status can expire')
})

test('docs/reading-the-ui.md: a status that comes from a replayed history is never reported as silent', () => {
  const view = mount()
  send(view, [replay(spawn('alpha', 1)), replay(toolStart('alpha', 2))])
  const alpha = byName(view, 'alpha')
  const later = Date.now() + 40 * 60_000
  assert.equal(deriveSilence(alpha, later), null, 'its age is not a wall-clock silence')
  assert.equal(deriveFreshness(alpha, later), 'stale', 'an expired history status is only the last known one')
})

test('the next non-replayed event makes the agent live again', () => {
  const view = mount()
  send(view, [replay(spawn('alpha', 1))])
  assert.equal(byName(view, 'alpha').freshnessSource, 'history')
  send(view, [toolStart('alpha', 2)])
  assert.equal(byName(view, 'alpha').freshnessSource, 'live')
})

test('an imported event stays imported, even though it is also replayed', () => {
  const view = mount()
  send(view, [{ ...replay(spawn('alpha', 1)), imported: true }])
  assert.equal(byName(view, 'alpha').freshnessSource, 'imported')
})
