// #660 on the REAL useAgentSimulation hook: once the live scene is at rest, the animation loop skips its work
// (no event batch, no computeNextFrame, no layout step) while the clock keeps running, and a received event is
// still played on the very next frame (the gate never delays it).
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { simLoopStats } from '@/hooks/simulation/idle-gate'
import type { SimulationEvent } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'

const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown }
const realRaf = g.requestAnimationFrame
const realCaf = g.cancelAnimationFrame
let pending = new Map<number, FrameRequestCallback>()
let nextId = 1
let clock = 0
const FRAME_MS = 17

beforeEach(() => {
  pending = new Map(); nextId = 1; clock = 0
  g.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = nextId++; pending.set(id, cb); return id }
  g.cancelAnimationFrame = (id: number) => { pending.delete(id) }
})
afterEach(() => {
  cleanup()
  g.requestAnimationFrame = realRaf
  g.cancelAnimationFrame = realCaf
  document.body.replaceChildren()
})

function mount() {
  // One queue, pushed in place like the bridge does (#645): the frame already requested sees what is pushed
  const queue: SimulationEvent[] = []
  const hook = renderHook(() => useAgentSimulation({
    useMockData: false,
    externalEvents: queue,
    onExternalEventsConsumed: () => { queue.length = 0 },
  }))
  return {
    get frame(): SimulationState { return hook.result.current.frameRef.current },
    play: () => act(() => { hook.result.current.play() }),
    push(evs: SimulationEvent[]) { queue.push(...evs) },
    frames(n: number) {
      for (let i = 0; i < n; i++) {
        const entry = pending.entries().next().value
        assert.ok(entry, 'the animation loop keeps a frame requested')
        pending.delete(entry[0])
        clock += FRAME_MS
        act(() => { entry[1](clock) })
      }
    },
    flush: () => act(async () => { await new Promise<void>(r => setTimeout(r, 0)) }),
  }
}

test('at rest the live loop skips its work, the clock keeps running, and an event is played on the next frame (#660)', async () => {
  const sim = mount()
  sim.play()
  sim.push([
    { time: 0, type: 'agent_spawn', sessionId: 's', payload: { name: 'main', isMain: true } },
    { time: 0, type: 'agent_spawn', sessionId: 's', payload: { name: 'w1', parent: 'main' } },
    { time: 0, type: 'agent_spawn', sessionId: 's', payload: { name: 'w2', parent: 'main' } },
  ] as SimulationEvent[])
  sim.frames(1)
  await sim.flush()
  // Fade-in and layout settle
  sim.frames(3000)
  const agents = sim.frame.agents
  const t0 = sim.frame.currentTime
  const before = { ...simLoopStats }
  sim.frames(300)
  const skipped = simLoopStats.skipped - before.skipped
  const computed = simLoopStats.computed - before.computed
  assert.ok(skipped >= 295, `frames skipped at rest: ${skipped} of 300 (${computed} computed)`)
  assert.equal(sim.frame.agents, agents, 'the agents keep their identity at rest')
  assert.ok(Math.abs(sim.frame.currentTime - t0 - 300 * FRAME_MS / 1000) < 1e-6, 'the clock advanced by every frame')

  // A received event: played by the very next frame, no frame of delay
  sim.push([{ time: 0, type: 'agent_spawn', sessionId: 's', payload: { name: 'w3', parent: 'main' } }] as SimulationEvent[])
  const size = sim.frame.agents.size
  sim.frames(1)
  assert.equal(sim.frame.agents.size, size + 1, 'the new agent exists after one frame')
})
