// Integration test (#36, D3) on the REAL useAgentSimulation hook: events go in through externalEvents,
// requestAnimationFrame is driven by hand with deterministic timestamps, and the assertions are on the
// agent positions the hook publishes (frameRef). Deleting the layoutRef.current.stepState(...) call of
// animate() (the D3 wiring bug) makes these tests fail.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { layoutInfo } from '@/hooks/simulation/fleet-layout'
import { CLUSTER_LAYOUT } from '@/lib/canvas-constants'
import type { SimulationEvent } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }

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

/** Mounts the real hook and gives a handle to feed events and run animation frames */
function mount() {
  let events: SimulationEvent[] = []
  let consumed = false
  const hook = renderHook((props: { events: SimulationEvent[] }) => useAgentSimulation({
    useMockData: false,
    externalEvents: props.events,
    onExternalEventsConsumed: () => { consumed = true },
  }), { initialProps: { events } })
  return {
    get frame(): SimulationState { return hook.result.current.frameRef.current },
    play: () => act(() => { hook.result.current.play() }),
    /** Hand events to the hook; they are consumed by the next frame */
    push(evs: Ev[]) {
      events = evs.map((e, i) => ({ time: i, type: e.type, payload: e.payload, sessionId: e.sessionId }) as SimulationEvent)
      consumed = false
      hook.rerender({ events })
    },
    /** Run n animation frames with deterministic timestamps; consumed events are cleared like the bridge does */
    frames(n: number) {
      for (let i = 0; i < n; i++) {
        const entry = pending.entries().next().value
        assert.ok(entry, 'the animation loop keeps a frame requested')
        pending.delete(entry[0])
        clock += FRAME_MS
        act(() => { entry[1](clock) })
        if (consumed) { consumed = false; events = []; hook.rerender({ events }) }
      }
    },
    /** Let the deferred (setTimeout 0) force syncs after spawns run */
    flush: () => act(async () => { await new Promise<void>(r => setTimeout(r, 0)) }),
  }
}

function sessionEvents(sid: string, size: number, opts: { team?: string; grandchildren?: boolean } = {}): Ev[] {
  const evs: Ev[] = [{ type: 'agent_spawn', sessionId: sid, payload: { name: 'main', isMain: true } }]
  for (let i = 1; i < size; i++) {
    const parent = opts.grandchildren && i > 2 ? `w${i - 2}` : 'main'
    const teammate = opts.team ? { kind: 'teammate', teamName: opts.team } : {}
    evs.push({ type: 'agent_spawn', sessionId: sid, payload: { name: `w${i}`, parent, ...teammate } })
  }
  return evs
}

function assertLayoutInvariants(state: SimulationState, label: string): void {
  const { info, anchors } = layoutInfo(state.agents, state.teams)
  assert.ok(state.agents.size > 0, `${label}: there are agents`)
  assert.equal(info.size, state.agents.size, `${label}: every agent has a cluster`)
  const leads = new Map<string, { id: string; x: number; y: number }>()
  for (const a of state.agents.values()) {
    const i = info.get(a.id)!
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `${label}: ${a.id} has finite position`)
    if (i.role === 'lead') {
      leads.set(i.key, a)
      assert.ok(Math.hypot(a.x - i.anchor.x, a.y - i.anchor.y) < 1,
        `${label}: lead ${a.id} reached its anchor (at ${a.x.toFixed(1)},${a.y.toFixed(1)}, anchor ${i.anchor.x.toFixed(1)},${i.anchor.y.toFixed(1)})`)
    } else {
      const d = Math.hypot(a.x - i.anchor.x, a.y - i.anchor.y)
      assert.ok(d <= i.radius * CLUSTER_LAYOUT.containFactor + 1e-6, `${label}: ${a.id} inside its own disc (${d.toFixed(1)} > ${i.radius})`)
    }
    for (const other of anchors.values()) {
      if (other.key === i.key) continue
      assert.ok(Math.hypot(a.x - other.x, a.y - other.y) > other.radius, `${label}: ${a.id} (${i.key}) sits inside foreign cluster ${other.key}`)
    }
  }
  const list = Array.from(anchors.values())
  assert.equal(leads.size, list.length, `${label}: one lead per cluster`)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = leads.get(list[i].key)!, b = leads.get(list[j].key)!
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= list[i].radius + list[j].radius, `${label}: leads of ${list[i].key} and ${list[j].key} are too close`)
    }
  }
}

const SIZES = [4, 2, 1, 3, 6, 5, 1, 8, 2, 3, 7, 4]
const FRAMES = 1500

for (const count of [1, 3, 5, 12]) {
  test(`hook: ${count} session(s) of varied sizes settle on their anchors with no overlapping clusters`, async () => {
    const sim = mount()
    await sim.play()
    sim.frames(2)
    for (let i = 0; i < count; i++) {
      sim.push(sessionEvents(`sess-${i}`, SIZES[i], { grandchildren: i % 2 === 1 }))
      sim.frames(3)
    }
    await sim.flush()
    sim.frames(FRAMES)
    assert.equal(sim.frame.agents.size, SIZES.slice(0, count).reduce((s, n) => s + n, 0))
    assertLayoutInvariants(sim.frame, `${count} sessions`)
    if (count === 1) {
      const lead = sim.frame.agents.get('sess-0:main')!
      assert.deepEqual([lead.x, lead.y], [0, 0], 'the lead of a single cluster is at (0,0)')
    }
  })
}

test('hook: a team and plain sessions settle together, teammates stay in the team disc', async () => {
  const sim = mount()
  await sim.play()
  sim.frames(2)
  sim.push([
    ...sessionEvents('L', 5, { team: 'alpha' }),
    { type: 'team_info', sessionId: 'L', payload: { teamName: 'alpha', leadSessionId: 'L', members: [] } },
    ...sessionEvents('S1', 3),
    ...sessionEvents('S2', 2),
  ])
  sim.frames(3)
  await sim.flush()
  sim.frames(FRAMES)
  assert.equal(sim.frame.agents.size, 10)
  assert.ok(sim.frame.teams.size >= 1, 'the team is known')
  assertLayoutInvariants(sim.frame, 'team + sessions')
})

test('hook: clusters that grow later push their neighbours, no overlap after late spawns', async () => {
  const sim = mount()
  await sim.play()
  sim.frames(2)
  sim.push([...sessionEvents('s0', 1), ...sessionEvents('s1', 1), ...sessionEvents('s2', 1)])
  sim.frames(3)
  await sim.flush()
  sim.frames(400)
  assertLayoutInvariants(sim.frame, 'before growth')
  for (let k = 1; k <= 9; k++) {
    sim.push([{ type: 'agent_spawn', sessionId: 's1', payload: { name: `late${k}`, parent: 'main' } }])
    sim.frames(20)
  }
  await sim.flush()
  sim.frames(FRAMES)
  assert.equal(sim.frame.agents.size, 12)
  assertLayoutInvariants(sim.frame, 'after growth')
})

test('hook: animation frames keep applying the layout after the initial sync', async () => {
  const sim = mount()
  await sim.play()
  sim.frames(2)
  sim.push([...sessionEvents('a', 6), ...sessionEvents('b', 6)])
  sim.frames(3)
  await sim.flush()
  const before = new Map(Array.from(sim.frame.agents.values(), a => [a.id, [a.x, a.y]]))
  assert.equal(before.size, 12)
  sim.frames(300)
  let moved = 0
  for (const a of sim.frame.agents.values()) {
    const [x, y] = before.get(a.id)!
    if (Math.hypot(a.x - x, a.y - y) > 1) moved++
  }
  assert.ok(moved >= 2, `${moved} agents moved after the initial sync`)
})
