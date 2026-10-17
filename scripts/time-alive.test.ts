import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, processEventBatch, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame, type AnimateOptions } from '../web/hooks/simulation/animate'
import { snapVisualState } from '../web/hooks/simulation/snap-visual-state'
import { clearHistoryState } from '../web/hooks/simulation/clear-history'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const options: AnimateOptions = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

const spawnEvent = (time: number): SimulationEvent => ({ time, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } })
function spawned(time: number): SimulationState {
  const s = processEvent(spawnEvent(time), { ...createEmptyState(), currentTime: time }, ctx)
  return { ...s, eventLog: [spawnEvent(time)], eventIndex: 1 }
}
/** A received event, played like the live catch-up does: the clock jumps to the event time */
const receive = (s: SimulationState, event: SimulationEvent) => processEventBatch([event], s, ctx, { advanceClock: true }).state
const frame = (s: SimulationState, t: number) => computeNextFrame(s, 0.1, t, t, s, options)
const alive = (s: SimulationState) => Array.from(s.agents.values())[0].timeAlive

test('timeAlive follows the simulation clock when it jumps (event catch-up) (#383)', () => {
  const s0 = spawned(10)
  // A received event moved the clock 60 s in one frame while the frame delta stayed capped
  const s1 = computeNextFrame(s0, 0.1, 70, 70, s0, options)
  assert.equal(alive(s1), 60)
})

test('timeAlive does not grow when the clock does not move, whatever the frame delta (#383)', () => {
  const s0 = spawned(10)
  const s1 = computeNextFrame(s0, 0.1, 10, 10, s0, options)
  assert.equal(alive(s1), 0)
})

test('timeAlive of a complete agent is its lifetime, spawn to completion (#383)', () => {
  const s1 = frame(spawned(10), 15)
  assert.equal(alive(s1), 5)
  const done = frame(receive(s1, { time: 600, type: 'agent_complete', payload: { name: 'orchestrator' } }), 600)
  assert.equal(Array.from(done.agents.values())[0].state, 'complete')
  assert.equal(alive(done), 590)
  // Later frames do not move it
  assert.equal(alive(frame(done, 700)), 590)
})

test('a seek past the end of an agent shows its lifetime, not the seek time (#383)', () => {
  const s1 = frame(spawned(10), 15)
  const done = receive(s1, { time: 600, type: 'agent_complete', payload: { name: 'orchestrator' } })
  assert.equal(alive(snapVisualState(done, 700)), 590)
})

test('after Clear history, the age of a kept agent is measured from its real spawn (#383)', () => {
  const live = frame(spawned(500), 503)
  let s = clearHistoryState(live)
  assert.equal(s.currentTime, 0)
  assert.equal(alive(s), 0)
  // The clock restarts at 0: nothing proves an age until an event brings the session time back
  for (const t of [1, 2, 3]) s = frame(s, t)
  assert.equal(alive(s), 0)
  s = receive(s, { time: 603, type: 'message', payload: { agent: 'orchestrator', role: 'assistant', content: 'still here' } })
  s = frame(s, s.currentTime)
  assert.equal(s.currentTime, 603)
  assert.equal(alive(s), 103)
})
