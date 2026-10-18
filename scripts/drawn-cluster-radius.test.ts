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
import { clusterRadius } from '../web/hooks/simulation/fleet-layout'
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
  /** Agents the canvas draws although hidden (selected, hovered, keyboard focus), as sceneAgents does */
  let keep: string[] = []
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
    /** Select / hover / focus: the canvas draws these agents even when hidden, the layout is told the same ids */
    keepDrawn(ids: string[]) { keep = ids; layout.setKeepIds(ids) },
    shown(): Map<string, Agent> { return visibleAgents(frame.agents, hide, keep) },
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

// ─── Sessions without phases: unchanged but for the case of 4 at work ────────

// Bounds about 5 % above the values measured with #554 (max 247 / 555 / 1071, median 244 / 420 / 737)
for (const [total, active, maxBound, medianBound] of [[83, 4, 260, 256], [31, 30, 585, 441], [81, 80, 1100, 774]] as const) {
  test(`a session of ${active} children at work out of ${total - 1} (no phases) keeps its placement`, async (t) => {
    const rig = createRig(true)
    try {
      await grow(rig, { sid: 'S', total, active })
      const ticks = rig.settle()
      const d = childDistances(rig, 'S')
      t.diagnostic(`children at ${Math.round(d[0])}-${Math.round(d[d.length - 1])}, median ${Math.round(d[Math.floor(d.length / 2)])}, rest after ${ticks} frames`)
      assert.equal(d.length, active)
      // Before #554 (develop): 4 at work 210-277, median 212 (with #554: 239-247, median 244, a slight change);
      // 30 at work median 420, max 555; 80 at work median 737, max 1071 (collision limit)
      const median = d[Math.floor(d.length / 2)]
      assert.ok(Math.max(...d) < maxBound, `children at ${Math.round(median)} (median) / ${Math.round(Math.max(...d))} (max)`)
      assert.ok(median < medianBound, `median ${Math.round(median)}`)
      assert.ok(Math.min(...d) > FORCE.collideRadius, `no child on top of the orchestrator (${Math.round(Math.min(...d))})`)
      assert.ok(ticks < SETTLE_BOUND, `the layout comes to rest (${ticks} frames)`)
    } finally { rig.destroy() }
  })
}

// ─── Disc radius ─────────────────────────────────────────────────────────────

/** Radius holding n agents packed hexagonally at the collision distance: n circles of radius r cover n * pi r^2 at a density of pi / (2 sqrt 3) */
const hexPackRadius = (n: number) => FORCE.collideRadius * Math.sqrt(n / (Math.PI / (2 * Math.sqrt(3))))

test('clusterRadius: never below the hexagonal packing of its members plus one collision radius', () => {
  for (let n = 1; n <= CLUSTER_LAYOUT.maxMembers; n++) {
    assert.ok(clusterRadius(n) >= hexPackRadius(n) + FORCE.collideRadius - 1e-9, `${n} members`)
    assert.ok(clusterRadius(n) >= CLUSTER_LAYOUT.baseRadius + n * CLUSTER_LAYOUT.memberSpacing - 1e-9)
  }
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

// ─── One agent finishing (review of #564) ────────────────────────────────────

/**
 * Bound on how far one agent finishing may move the other drawn agents. Measured on develop (before #554) with the same
 * scenarios: 0.10 (All view, 20 children at work) and 6.23 (All view, workflow of 4 at work, phase ring); with the first
 * version of #564: 133 and 101, the layout awake for 228-230 frames. 10 covers develop with a margin.
 */
const FINISH_MOVE_BOUND = 10
/** Frames the layout may stay awake after one agent finished: develop rests in 4, one second is the bound */
const FINISH_FRAMES_BOUND = 60

const finishCases: Array<[string, (rig: Rig) => Promise<void>, string]> = [
  ['All view, 20 children at work out of 29 next to a session of 10', async rig => { await grow(rig, { sid: 'N', total: 11, active: 10 }); await grow(rig, { sid: 'S', total: 30, active: 20 }) }, 'w20'],
  ['All view, a workflow of 83 agents with 4 at work next to a session of 10', async rig => { await grow(rig, { sid: 'N', total: 11, active: 10 }); await grow(rig, { sid: 'S', total: 83, active: 4, workflow: true }) }, 'w80'],
]
for (const [label, setup, finish] of finishCases) {
  test(`${label}: one agent finishing does not move the other drawn agents more than ${FINISH_MOVE_BOUND}`, async (t) => {
    const rig = createRig(true)
    try {
      await setup(rig)
      rig.settle()
      const ids = Array.from(rig.shown().keys()).filter(id => id !== `S:${finish}`)
      const before = new Map(ids.map(id => [id, { x: rig.frame.agents.get(id)!.x, y: rig.frame.agents.get(id)!.y }]))
      rig.push([{ type: 'agent_complete', sessionId: 'S', payload: { name: finish } }])
      assert.equal(rig.shown().has(`S:${finish}`), false, 'the finished agent is hidden')
      let worst = 0
      let frames = 0
      while (frames < SETTLE_BOUND) {
        rig.frames(1)
        frames++
        for (const id of ids) {
          const a = rig.frame.agents.get(id)!
          worst = Math.max(worst, Math.hypot(a.x - before.get(id)!.x, a.y - before.get(id)!.y))
        }
        if (!rig.layout.active) break
      }
      t.diagnostic(`other drawn agents moved up to ${worst.toFixed(2)}, layout awake for ${frames} frames`)
      assert.ok(worst < FINISH_MOVE_BOUND, `moved up to ${worst.toFixed(2)} (develop: 0.10 / 6.23)`)
      assert.ok(frames < FINISH_FRAMES_BOUND, `awake for ${frames} frames (develop: 4)`)
    } finally { rig.destroy() }
  })
}

// ─── Hidden agents the canvas still draws (selected, hovered, keyboard focus) ─

test('a finished agent hidden, then selected, is drawn next to its parent, not at its last position', async () => {
  const rig = createRig(true)
  try {
    await grow(rig, { sid: 'S', total: 6, active: 5 })
    rig.settle()
    const id = 'S:w1'
    rig.push([{ type: 'agent_complete', sessionId: 'S', payload: { name: 'w1' } }])
    // A new agent appears: the layout is rebuilt on the drawn agents, the finished one leaves it
    rig.push([{ type: 'agent_spawn', sessionId: 'S', payload: { name: 'late', parent: 'orch' } }])
    rig.setState('S:late', 'thinking')
    await rig.flush()
    rig.settle()
    // While hidden, its last position is far away (as after the clusters moved)
    rig.patch(id, { x: 3000, y: -2500 })
    rig.keepDrawn([id])
    assert.equal(rig.shown().has(id), true, 'selected: drawn although finished')
    rig.frames(1)
    const orch = rig.frame.agents.get('S:orch')!
    const kept = rig.frame.agents.get(id)!
    const d = Math.hypot(kept.x - orch.x, kept.y - orch.y)
    assert.ok(d < AGENT_SPAWN_DISTANCE + 60, `drawn at ${Math.round(d)} from its parent`)
    rig.settle()
    assert.equal(closePairs(rig), 0, 'the collisions part it from the other drawn agents')
    // Deselected: hidden again, the drawn agents do not move
    const snap = new Map(Array.from(rig.shown().keys(), k => [k, { x: rig.frame.agents.get(k)!.x, y: rig.frame.agents.get(k)!.y }]))
    rig.keepDrawn([])
    rig.settle()
    for (const [k, p] of snap) {
      if (k === id) continue
      const a = rig.frame.agents.get(k)!
      assert.ok(Math.hypot(a.x - p.x, a.y - p.y) < FINISH_MOVE_BOUND, `${k} stays`)
    }
  } finally { rig.destroy() }
})
