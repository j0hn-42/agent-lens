// Simulation loop at rest (#660), not a test: it prints a line, it asserts nothing.
//
//   pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-sim-loop.ts            # with the idle gate
//   pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-sim-loop.ts --no-gate  # every frame computed
//   PERF_AGENTS=10 pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-sim-loop.ts
//
// Does what one frame of useAgentSimulation.animate() does in live mode (event batch, computeNextFrame, layout step,
// or the idle gate), on a settled scene: PERF_AGENTS agents (200 by default) faded in, laid out, spawned at fractional
// times like real sessions, no particle, no bubble, no tool card. Prints the frames computed, how many frames changed
// the identity of the agents Map (the draw loop caches key on it) and the mean JS time of a frame. See docs/performance.md.
import { processEvent, processEventBatch, type ProcessEventContext } from '@/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '@/hooks/simulation/types'
import { computeNextFrame } from '@/hooks/simulation/animate'
import { createForceLayout } from '@/hooks/simulation/force-layout'
import { isSimulationIdle, idleFrame } from '@/hooks/simulation/idle-gate'

const N = Number(process.env.PERF_AGENTS ?? 200)
const FRAMES = Number(process.env.PERF_FRAMES ?? 510)
const gate = !process.argv.includes('--no-gate')
const DT = 1 / 60
const EXPIRY_S = 600

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 }, skipForceSync: true,
}
const layout = createForceLayout()
let s: SimulationState = createEmptyState()
let t = 1.37
s = processEvent({ time: t, type: 'agent_spawn', sessionId: 's', payload: { name: 'main', isMain: true } }, { ...s, currentTime: t }, ctx)
for (let i = 1; i < N; i++) {
  t += 0.0173
  s = processEvent({ time: t, type: 'agent_spawn', sessionId: 's', payload: { name: `w${i}`, parent: 'main' } }, { ...s, currentTime: t }, ctx)
}
s = {
  ...s, agents: new Map([...s.agents].map(([id, a]) => [id, { ...a, opacity: 1, scale: 1, messageBubbles: [] }])),
  particles: [], discoveries: [], edges: s.edges.map(e => ({ ...e, opacity: 1 })), toolCalls: new Map(),
  currentTime: t + 5, maxTimeReached: t + 5, isPlaying: true, eventLog: [], eventIndex: 0,
}
s = layout.syncState(s)
for (let i = 0; i < 5000 && layout.active; i++) s = layout.stepState(s)

let computed = 0
function frame(prev: SimulationState): SimulationState {
  const newTime = prev.currentTime + DT
  const maxT = Math.max(prev.maxTimeReached, newTime)
  if (gate && isSimulationIdle(prev, newTime, { queued: false, layoutSettled: layout.isSettled(prev), toolExpiryS: EXPIRY_S })) {
    return idleFrame(prev, newTime, maxT)
  }
  computed++
  const current = { ...processEventBatch([], prev, ctx).state, eventIndex: prev.eventIndex }
  const next = computeNextFrame(prev, DT, newTime, maxT, current, { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0, speed: 1, toolExpiryS: EXPIRY_S })
  return layout.stepState(next)
}

for (let i = 0; i < 200; i++) s = frame(s)
computed = 0
let identityChanges = 0
const t0 = process.hrtime.bigint()
for (let i = 0; i < FRAMES; i++) {
  const next = frame(s)
  if (next.agents !== s.agents) identityChanges++
  s = next
}
const us = Number(process.hrtime.bigint() - t0) / FRAMES / 1000
console.log(`| ${gate ? 'with the idle gate' : 'no gate'} | ${N} | ${FRAMES} | ${computed} | ${identityChanges} | ${us.toFixed(1)} |`)
layout.destroy()
