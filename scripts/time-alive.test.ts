import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame, type AnimateOptions } from '../web/hooks/simulation/animate'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const options: AnimateOptions = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

function spawned(time: number): SimulationState {
  return processEvent({ time, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } }, { ...createEmptyState(), currentTime: time }, ctx)
}
const alive = (s: SimulationState) => Array.from(s.agents.values())[0].timeAlive

test('timeAlive follows the simulation clock, not the number of frames (#383)', () => {
  const s0 = spawned(10)
  // Hidden tab: the clock jumped 60 s in one frame while the frame delta stayed capped
  const s1 = computeNextFrame(s0, 0.1, 70, 70, s0, options)
  assert.equal(alive(s1), 60)
})

test('timeAlive does not grow when the clock does not move, whatever the frame delta (#383)', () => {
  const s0 = spawned(10)
  const s1 = computeNextFrame(s0, 0.1, 10, 10, s0, options)
  assert.equal(alive(s1), 0)
})

test('timeAlive stops when the agent is complete (#383)', () => {
  const s0 = spawned(10)
  const agent = Array.from(s0.agents.values())[0]
  s0.agents.set(agent.id, { ...agent, state: 'complete', timeAlive: 5 })
  const s1 = computeNextFrame(s0, 0.1, 100, 100, s0, options)
  assert.equal(alive(s1), 5)
})
