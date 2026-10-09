// #105: a new sessionProjects Map with the same content must not run the full fleet layout again
// (it rebuilds every node, runs 30 synchronous ticks and shakes a settled layout). Real hook, rAF by hand.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { SimulationEvent } from '@/lib/agent-types'

type Projects = ReadonlyMap<string, { projectId: string; projectName: string }>

const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown }
const realRaf = g.requestAnimationFrame
const realCaf = g.cancelAnimationFrame
let pending = new Map<number, FrameRequestCallback>()
let nextId = 1
let clock = 0

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

const projects = (entries: Array<[string, string]>): Projects =>
  new Map(entries.map(([id, project]) => [id, { projectId: project, projectName: project }]))

function spawns(sid: string, n: number): SimulationEvent[] {
  const evs: Array<Record<string, unknown>> = [{ time: 0, type: 'agent_spawn', sessionId: sid, payload: { name: 'main', isMain: true } }]
  for (let i = 1; i < n; i++) evs.push({ time: 0, type: 'agent_spawn', sessionId: sid, payload: { name: `w${i}`, parent: 'main' } })
  return evs as unknown as SimulationEvent[]
}

async function settledFleet(initial: Projects) {
  let events: SimulationEvent[] = []
  let consumed = false
  const hook = renderHook((props: { events: SimulationEvent[]; sessionProjects: Projects }) => useAgentSimulation({
    useMockData: false, externalEvents: props.events, onExternalEventsConsumed: () => { consumed = true }, sessionProjects: props.sessionProjects,
  }), { initialProps: { events, sessionProjects: initial } })
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      const entry = pending.entries().next().value
      assert.ok(entry)
      pending.delete(entry[0])
      clock += 17
      act(() => { entry[1](clock) })
      if (consumed) { consumed = false; events = []; hook.rerender({ events, sessionProjects: current }) }
    }
  }
  let current = initial
  await act(async () => { hook.result.current.play() })
  frames(2)
  events = [...spawns('a', 5), ...spawns('b', 5), ...spawns('c', 4)]
  consumed = false
  hook.rerender({ events, sessionProjects: current })
  frames(3)
  await act(async () => { await new Promise<void>(r => setTimeout(r, 0)) })
  frames(600)
  return {
    positions: () => [...hook.result.current.frameRef.current.agents.values()].map(a => `${a.id}:${a.x.toFixed(4)},${a.y.toFixed(4)}`).join('|'),
    setProjects(next: Projects) { current = next; act(() => { hook.rerender({ events, sessionProjects: next }) }) },
  }
}

test('same content, new Map: the settled layout is left alone', async () => {
  const sim = await settledFleet(projects([['a', 'P1'], ['b', 'P1'], ['c', 'P2']]))
  const before = sim.positions()
  sim.setProjects(projects([['a', 'P1'], ['b', 'P1'], ['c', 'P2']]))
  assert.equal(sim.positions(), before, 'no resync, nothing moved')
})

test('a changed project still resyncs the layout', async () => {
  const sim = await settledFleet(projects([['a', 'P1'], ['b', 'P2'], ['c', 'P3']]))
  const before = sim.positions()
  sim.setProjects(projects([['a', 'P1'], ['b', 'P1'], ['c', 'P1']]))
  assert.notEqual(sim.positions(), before, 'grouping the three sessions into one project lays them out again')
})
