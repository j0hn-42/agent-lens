// Disc of a cluster sized on the DRAWN agents (#554): real events -> processEvent -> computeNextFrame -> force layout,
// frame by frame, with the wiring of fleet-layout-integration.test.ts. Under 'Hide inactive agents' the finished agents
// no longer widen the disc (220 + 30 x members) nor the ring of the workflow phases (half that radius), and they leave
// the simulation. Before: the 4 drawn children of an 83-agent workflow sat 1250-1434 away from their orchestrator.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { createForceLayout, type ForceLayout } from '../web/hooks/simulation/force-layout'
import { clusterRadius, hexPackRadius } from '../web/hooks/simulation/fleet-layout'
import { visibleAgents } from '../web/lib/inactive-agents'
import { AGENT_SPAWN_DISTANCE, CLUSTER_LAYOUT, FORCE } from '../web/lib/canvas-constants'
import type { Agent, SimulationEvent } from '../web/lib/agent-types'

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
const DT = 1 / 60
/** Bound on the frames a layout may take to come to rest (the base cases settle in 242 to 615) */
const SETTLE_BOUND = 4000

function createRig(hideInactive = true) {
  const layout: ForceLayout = createForceLayout()
  layout.setHideInactive(hideInactive)
  let hide = hideInactive
  let frame: SimulationState = createEmptyState()
  let t = 1
  let tickMs = 0
  let ticks = 0
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => { frame = layout.syncState(frame) },
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: false,
  }
  const rig = {
    layout,
    get frame() { return frame },
    get hide() { return hide },
    /** Mean time of one layout step so far (ms) */
    get msPerTick() { return ticks ? tickMs / ticks : 0 },
    push(events: Ev[]) {
      for (const e of events) {
        frame = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...frame, currentTime: t }, ctx)
        t += 0.01
      }
    },
    frames(n: number) {
      for (let i = 0; i < n; i++) {
        const next = computeNextFrame(frame, DT, frame.currentTime + DT, Math.max(frame.maxTimeReached, frame.currentTime + DT), frame,
          { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
        const t0 = performance.now()
        frame = layout.stepState(next)
        tickMs += performance.now() - t0
        ticks++
      }
    },
    /** Frames until the layout rests; returns how many it took (SETTLE_BOUND when it never does) */
    settle(): number {
      for (let i = 1; i <= SETTLE_BOUND; i++) {
        rig.frames(1)
        if (!layout.active) return i
      }
      return SETTLE_BOUND
    },
    setState(id: string, state: Agent['state']) {
      const agents = new Map(frame.agents)
      agents.set(id, { ...agents.get(id)!, state })
      frame = { ...frame, agents }
    },
    patch(id: string, over: Partial<Agent>) {
      const agents = new Map(frame.agents)
      agents.set(id, { ...agents.get(id)!, ...over })
      frame = { ...frame, agents }
    },
    setHideInactive(h: boolean) { hide = h; layout.setHideInactive(h) },
    shown(): Map<string, Agent> { return visibleAgents(frame.agents, hide) },
    flush: () => new Promise<void>(r => setTimeout(r, 0)),
    destroy: () => layout.destroy(),
  }
  return rig
}
type Rig = ReturnType<typeof createRig>

interface Shape { sid: string; total: number; active: number; workflow?: boolean }

/**
 * A session of `total` agents (one orchestrator), children appearing one by one 10 frames apart; the oldest finish so
 * that `active` stay at work. A workflow announces its members on two phases (team_info), as the user's case did.
 */
async function grow(rig: Rig, { sid, total, active, workflow }: Shape): Promise<void> {
  const name = (i: number) => `w${i}`
  rig.push([{ type: 'agent_spawn', sessionId: sid, payload: { name: 'orch', isMain: true } }])
  rig.setState(`${sid}:orch`, 'thinking')
  if (workflow) {
    const members = Array.from({ length: total - 1 }, (_, i) => ({ name: name(i), phase: i % 2 ? 'Review' : 'Implement' }))
    rig.push([{ type: 'team_info', sessionId: sid, payload: { teamName: 'wf', teamKind: 'workflow', leadSessionId: sid, members } }])
  }
  const member = workflow ? { kind: 'teammate', teamName: 'wf', teamKind: 'workflow' } : {}
  for (let i = 0; i < total - 1; i++) {
    rig.push([{ type: 'agent_spawn', sessionId: sid, payload: { name: name(i), parent: 'orch', ...member } }])
    rig.setState(`${sid}:${name(i)}`, 'thinking')
    if (i - active >= 0) rig.push([{ type: 'agent_complete', sessionId: sid, payload: { name: name(i - active) } }])
    await rig.flush()
    rig.frames(10)
  }
}

/** Distances from the orchestrator of `sid` to its drawn direct children, sorted */
function childDistances(rig: Rig, sid: string): number[] {
  const orch = rig.frame.agents.get(`${sid}:orch`)!
  return Array.from(rig.shown().values())
    .filter(a => a.parentId === orch.id)
    .map(a => Math.hypot(a.x - orch.x, a.y - orch.y))
    .sort((a, b) => a - b)
}

const r0 = (xs: number[]) => xs.map(Math.round).join(',')

/** Drawn agents closer to one another than one collision radius (labels on top of each other) */
function closePairs(rig: Rig): number {
  const ps = Array.from(rig.shown().values())
  let n = 0
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) < FORCE.collideRadius) n++
  return n
}

// ─── The reported case ───────────────────────────────────────────────────────

for (const view of ['session', 'all'] as const) {
  test(`#554 ${view} view: a workflow of 83 agents, 4 at work on 2 phases, finished ones hidden: the drawn children stay near the orchestrator`, async (t) => {
    const rig = createRig(true)
    try {
      if (view === 'all') await grow(rig, { sid: 'N', total: 11, active: 10 })
      await grow(rig, { sid: 'S', total: 83, active: 4, workflow: true })
      const ticks = rig.settle()
      const d = childDistances(rig, 'S')
      t.diagnostic(`drawn children at ${r0(d)}, rest after ${ticks} frames, ${rig.msPerTick.toFixed(3)} ms per step`)
      assert.equal(d.length, 4, 'four drawn children')
      assert.ok(Math.max(...d) < 400, `drawn children at ${r0(d)} (before #554: 1250-1434)`)
      assert.ok(ticks < SETTLE_BOUND, `the layout comes to rest (${ticks} frames)`)
      assert.equal(closePairs(rig), 0, 'no two drawn agents on top of each other')
      if (view === 'all') {
        const n = childDistances(rig, 'N')
        assert.equal(n.length, 10)
        assert.ok(Math.max(...n) < 450, `neighbour children at ${r0(n)}`)
      }
    } finally { rig.destroy() }
  })
}

// ─── Sessions without phases: unchanged ──────────────────────────────────────

for (const [total, active, maxBound] of [[83, 4, 300], [31, 30, 600], [81, 80, 1100]] as const) {
  test(`a session of ${active} children at work out of ${total - 1} (no phases) keeps its placement`, async (t) => {
    const rig = createRig(true)
    try {
      await grow(rig, { sid: 'S', total, active })
      const ticks = rig.settle()
      const d = childDistances(rig, 'S')
      t.diagnostic(`children at ${Math.round(d[0])}-${Math.round(d[d.length - 1])}, median ${Math.round(d[Math.floor(d.length / 2)])}, rest after ${ticks} frames`)
      assert.equal(d.length, active)
      // Before #554: 4 at work 210-231; 30 at work median 420, max 555; 80 at work median 737, max 1071 (collision limit)
      assert.ok(Math.max(...d) < maxBound, `children at ${Math.round(d[Math.floor(d.length / 2)])} (median) / ${Math.round(Math.max(...d))} (max)`)
      assert.ok(Math.min(...d) > FORCE.collideRadius, `no child on top of the orchestrator (${Math.round(Math.min(...d))})`)
      assert.ok(ticks < SETTLE_BOUND, `the layout comes to rest (${ticks} frames)`)
    } finally { rig.destroy() }
  })
}

// ─── Disc radius ─────────────────────────────────────────────────────────────

test('clusterRadius: never below the hexagonal packing of its members plus one collision radius', () => {
  for (let n = 1; n <= CLUSTER_LAYOUT.maxMembers; n++) {
    assert.ok(clusterRadius(n) >= hexPackRadius(n) + FORCE.collideRadius - 1e-9, `${n} members`)
    assert.ok(clusterRadius(n) >= CLUSTER_LAYOUT.baseRadius + n * CLUSTER_LAYOUT.memberSpacing - 1e-9)
  }
  // n circles of radius r packed hexagonally cover n * pi r^2 at a density of pi / (2 sqrt 3)
  assert.ok(Math.abs(hexPackRadius(81) - FORCE.collideRadius * Math.sqrt(81 / (Math.PI / (2 * Math.sqrt(3))))) < 1e-9)
})

// ─── Risks ───────────────────────────────────────────────────────────────────

test('toggling Hide inactive agents resizes the discs: the layout moves, then comes to rest again without oscillating', async (t) => {
  const rig = createRig(true)
  try {
    await grow(rig, { sid: 'N', total: 11, active: 10 })
    await grow(rig, { sid: 'S', total: 83, active: 4, workflow: true })
    rig.settle()
    const pos = () => new Map(Array.from(rig.frame.agents.values(), a => [a.id, { x: a.x, y: a.y }]))
    const moved = (a: Map<string, { x: number; y: number }>, b: Map<string, { x: number; y: number }>, ids: string[]) =>
      Math.max(...ids.map(id => Math.hypot(a.get(id)!.x - b.get(id)!.x, a.get(id)!.y - b.get(id)!.y)))
    const drawnBefore = Array.from(rig.shown().keys())
    const before = pos()
    rig.setHideInactive(false)
    const showTicks = rig.settle()
    assert.ok(showTicks < SETTLE_BOUND, `shown: rest after ${showTicks} frames`)
    const shownAll = pos()
    const all = childDistances(rig, 'S')
    t.diagnostic(`shown: ${all.length} children of the workflow at ${Math.round(all[0])}-${Math.round(all[all.length - 1])}, median ${Math.round(all[Math.floor(all.length / 2)])}, ${closePairs(rig)} drawn pairs closer than ${FORCE.collideRadius}`)
    const still = (label: string) => {
      const snap = pos()
      rig.frames(30)
      assert.ok(moved(snap, pos(), Array.from(snap.keys())) < 1e-9, `${label}: nothing moves once at rest`)
    }
    still('shown')
    rig.setHideInactive(true)
    const hideTicks = rig.settle()
    assert.ok(hideTicks < SETTLE_BOUND, `hidden again: rest after ${hideTicks} frames`)
    still('hidden again')
    const d = childDistances(rig, 'S')
    assert.ok(Math.max(...d) < 400, `drawn children back near the orchestrator: ${r0(d)}`)
    const nLead = (p: Map<string, { x: number; y: number }>) => p.get('N:orch')!
    // Documented in docs/reading-the-ui.md: the clusters move when the discs are resized
    const shift = Math.hypot(nLead(before).x - nLead(shownAll).x, nLead(before).y - nLead(shownAll).y)
    t.diagnostic(`toggle: shown in ${showTicks} frames, hidden in ${hideTicks}; neighbour lead moved ${Math.round(shift)}; drawn agents moved up to ${Math.round(moved(before, pos(), drawnBefore))} after the round trip`)
  } finally { rig.destroy() }
})

test('an agent hidden then shown again comes back next to its parent, not at its last, stale position', async () => {
  const rig = createRig(true)
  try {
    await grow(rig, { sid: 'S', total: 5, active: 4 })
    rig.settle()
    const id = 'S:w0'
    rig.setState(id, 'idle')
    rig.settle()
    assert.equal(rig.shown().has(id), false, 'idle: hidden')
    // While hidden, its last position is far away (as after the clusters moved)
    rig.patch(id, { x: 3000, y: -2500 })
    rig.setState(id, 'thinking')
    rig.frames(1)
    const orch = rig.frame.agents.get('S:orch')!
    const back = rig.frame.agents.get(id)!
    const d = Math.hypot(back.x - orch.x, back.y - orch.y)
    assert.ok(d < AGENT_SPAWN_DISTANCE + 60, `re-placed at ${Math.round(d)} from its parent`)
    rig.settle()
    assert.ok(Math.max(...childDistances(rig, 'S')) < 400)
    assert.equal(closePairs(rig), 0, 'the collisions still part it from its siblings')
  } finally { rig.destroy() }
})

test('a pinned (dragged) agent keeps its place when it is hidden and shown again, and while others come and go', async () => {
  const rig = createRig(true)
  try {
    await grow(rig, { sid: 'S', total: 6, active: 5 })
    rig.settle()
    const id = 'S:w1'
    // The drag: the hook stamps pinned on the agent and holds the node
    rig.patch(id, { x: 600, y: 120, pinned: true })
    rig.layout.pin(id, 600, 120)
    rig.settle()
    // Another child finishes (hidden: the simulation is rebuilt) and a new one appears
    rig.push([{ type: 'agent_complete', sessionId: 'S', payload: { name: 'w2' } }])
    rig.push([{ type: 'agent_spawn', sessionId: 'S', payload: { name: 'late', parent: 'orch' } }])
    rig.setState('S:late', 'thinking')
    await rig.flush()
    rig.settle()
    assert.deepEqual([rig.frame.agents.get(id)!.x, rig.frame.agents.get(id)!.y], [600, 120], 'stays where it was dropped')
    rig.setState(id, 'idle')
    rig.settle()
    rig.setState(id, 'thinking')
    rig.settle()
    assert.deepEqual([rig.frame.agents.get(id)!.x, rig.frame.agents.get(id)!.y], [600, 120], 'not re-placed: the user put it there')
    // A drag on an agent that is drawn still moves only that agent
    const other = 'S:w3'
    rig.patch(other, { x: -500, y: 40, pinned: true })
    rig.layout.pin(other, -500, 40)
    rig.settle()
    assert.deepEqual([rig.frame.agents.get(other)!.x, rig.frame.agents.get(other)!.y], [-500, 40])
  } finally { rig.destroy() }
})

test('cost per layout step: hidden agents left out of the simulation do not make a step dearer', async (t) => {
  const rig = createRig(true)
  try {
    await grow(rig, { sid: 'N', total: 11, active: 10 })
    await grow(rig, { sid: 'S', total: 83, active: 4, workflow: true })
    rig.settle()
    // Measured, not asserted against a fixed time (shared machine): reported in the PR. Sanity bound only.
    t.diagnostic(`mean layout step ${rig.msPerTick.toFixed(3)} ms`)
    assert.ok(rig.msPerTick < 20, `${rig.msPerTick.toFixed(3)} ms per step`)
  } finally { rig.destroy() }
})
