// Zones (halos) of the clusters fit their agents (#146, #151): the smallest circle around the drawn agents with their
// labels and a fixed margin, whatever their number, following them when they appear, finish or get hidden, never
// overlapping another zone, with the orchestrator in the middle of its zone. Pure geometry first, then the real
// force layout (events -> processEvent -> d3), frame by frame, as in centred-orchestrator.test.ts.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import { phaseAnchors, extentCentre } from '../web/hooks/simulation/fleet-layout'
import { computeClusters, phaseLabels, type Cluster } from '../web/components/agent-visualizer/canvas/cluster-model'
import { fitHalo, createHaloEaser, HALO_MARGIN, HALO_LABEL_ROOM } from '../web/components/agent-visualizer/canvas/halo-geometry'
import { agentDrawRadius } from '../web/components/agent-visualizer/canvas/team-style'
import { visibleAgents } from '../web/lib/inactive-agents'
import type { Agent, SimulationEvent } from '../web/lib/agent-types'

// ─── fitHalo: pure geometry ──────────────────────────────────────────────────

const disc = (x: number, y: number, r = 20) => ({ x, y, r })

/** True when the circle wraps every disc (the halo never cuts an agent) */
function wraps(c: { cx: number; cy: number; r: number }, discs: Array<{ x: number; y: number; r: number }>, margin = 0): boolean {
  return discs.every(d => Math.hypot(d.x - c.cx, d.y - c.cy) + d.r + margin <= c.r + 1e-6)
}

test('no agent, no zone', () => {
  assert.equal(fitHalo([]), undefined)
})

test('1 agent: a circle of its radius plus the margin, centred on it', () => {
  const c = fitHalo([disc(30, -10, 28)])!
  assert.deepEqual([c.cx, c.cy], [30, -10])
  assert.equal(c.r, 28 + HALO_MARGIN)
})

test('2 agents: the circle is centred between them and just reaches their far sides', () => {
  const c = fitHalo([disc(-100, 0), disc(100, 0)])!
  assert.ok(Math.abs(c.cx) < 1e-6 && Math.abs(c.cy) < 1e-6)
  assert.ok(Math.abs(c.r - (100 + 20 + HALO_MARGIN)) < 1e-6, `r ${c.r}`)
})

test('3 agents: tighter than a circle centred on their centroid, and still wrapping them', () => {
  const discs = [disc(0, 0), disc(300, 0), disc(20, 30)]
  const c = fitHalo(discs)!
  assert.ok(wraps(c, discs, HALO_MARGIN))
  const gx = (0 + 300 + 20) / 3, gy = (0 + 0 + 30) / 3
  const centroidR = Math.max(...discs.map(d => Math.hypot(d.x - gx, d.y - gy) + d.r)) + HALO_MARGIN
  assert.ok(c.r < centroidR - 20, `fit ${c.r} vs centroid ${centroidR}`)
})

test('n agents on a ring: radius = ring + node + margin, whatever n', () => {
  for (const n of [4, 6, 9, 16]) {
    const discs = Array.from({ length: n }, (_, i) => disc(Math.cos((i / n) * 2 * Math.PI) * 200, Math.sin((i / n) * 2 * Math.PI) * 200))
    const c = fitHalo(discs)!
    assert.ok(wraps(c, discs, HALO_MARGIN), `n=${n} wraps`)
    assert.ok(c.r <= 200 + 20 + HALO_MARGIN + 6, `n=${n}: r ${c.r}`)
  }
})

test('the zone follows the size of the nodes, not a fixed minimum: bigger nodes, bigger zone; one node stays small', () => {
  const small = fitHalo([disc(0, 0, 20), disc(150, 0, 20)])!
  const big = fitHalo([disc(0, 0, 40), disc(150, 0, 40)])!
  assert.ok(big.r > small.r)
  assert.ok(fitHalo([disc(0, 0, 20)])!.r < 80, 'a lone agent has a small zone')
})

test('a random cloud is always wrapped', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 40; k++) {
    const discs = Array.from({ length: 1 + Math.floor(rnd() * 15) }, () => disc(rnd() * 800 - 400, rnd() * 800 - 400, 15 + rnd() * 30))
    assert.ok(wraps(fitHalo(discs)!, discs, HALO_MARGIN))
  }
})

test('an agent appearing grows the zone, one leaving shrinks it back (exactly, no memory)', () => {
  const base = [disc(0, 0), disc(160, 0)]
  const before = fitHalo(base)!
  const grown = fitHalo([...base, disc(80, 260)])!
  assert.ok(grown.r > before.r)
  assert.deepEqual(fitHalo(base), before)
})

// ─── easing of the drawn zones ───────────────────────────────────────────────

const circle = (key: string, cx: number, cy: number, r: number) => ({ key, cx, cy, r })

test('easer: a new zone is drawn as it is, then moves a fraction of the gap per frame without overshooting', () => {
  const easer = createHaloEaser()
  const first = [circle('a', 0, 0, 100)]
  easer.apply(first, 1 / 60)
  assert.equal(first[0].r, 100)
  const grow = [circle('a', 0, 0, 300)]
  easer.apply(grow, 1 / 60)
  assert.ok(grow[0].r > 100 && grow[0].r < 300, `r ${grow[0].r}`)
  assert.ok(grow[0].r - 100 < 0.25 * 200, 'a frame closes at most a quarter of the gap: no jump')
  let r = grow[0].r
  for (let i = 0; i < 120; i++) { const c = [circle('a', 0, 0, 300)]; easer.apply(c, 1 / 60); assert.ok(c[0].r >= r - 1e-9 && c[0].r <= 300 + 1e-9); r = c[0].r }
  assert.ok(300 - r < 1, `converges: ${r}`)
})

test('easer: shrinking is eased too, a removed zone is forgotten, reduced motion snaps', () => {
  const easer = createHaloEaser()
  easer.apply([circle('a', 0, 0, 300)], 1 / 60)
  const shrink = [circle('a', 10, 0, 100)]
  easer.apply(shrink, 1 / 60)
  assert.ok(shrink[0].r > 100 && shrink[0].r < 300)
  easer.apply([], 1 / 60)
  const back = [circle('a', 0, 0, 50)]
  easer.apply(back, 1 / 60)
  assert.equal(back[0].r, 50, 'forgotten: starts on its target')
  const snapped = [circle('a', 0, 0, 500)]
  easer.apply(snapped, 1 / 60, true)
  assert.equal(snapped[0].r, 500)
})

// ─── Zones of the real layout ────────────────────────────────────────────────

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }

function createRig(hideInactive = false) {
  const layout = createForceLayout()
  layout.setHideInactive(hideInactive)
  let frame: SimulationState = createEmptyState()
  let t = 1
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => { frame = layout.syncState(frame) },
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: false,
  }
  return {
    get frame() { return frame },
    push(events: Ev[]) {
      for (const e of events) {
        frame = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId ?? 's' }, { ...frame, currentTime: t }, ctx)
        t += 0.01
      }
    },
    frames(n: number) { for (let i = 0; i < n; i++) frame = layout.stepState(frame) },
    setState(id: string, state: 'complete' | 'idle' | 'thinking') {
      const agents = new Map(frame.agents)
      agents.set(id, { ...agents.get(id)!, state })
      frame = { ...frame, agents }
    },
    flush: () => new Promise<void>(r => setTimeout(r, 0)),
    destroy: () => layout.destroy(),
    /** Zones as drawn: the agents fade in over a few frames, so they are taken as fully visible */
    clusters(minMembers = 1): Cluster[] {
      const agents = Array.from(visibleAgents(frame.agents, hideInactive).values()).map((a: Agent) => ({ ...a, opacity: 1 }))
      return computeClusters(agents, frame.teams, { minMembers })
    },
  }
}

const spawn = (name: string, parent?: string, sessionId?: string): Ev =>
  ({ type: 'agent_spawn', payload: { name, ...(parent ? { parent } : { isMain: true }) }, ...(sessionId ? { sessionId } : {}) })

async function session(n: number): Promise<ReturnType<typeof createRig>> {
  const rig = createRig()
  rig.push([spawn('main'), ...Array.from({ length: n - 1 }, (_, i) => spawn(`w${i}`, 'main'))])
  await rig.flush()
  rig.frames(700)
  return rig
}

/** Radius of the smallest circle wrapping the agents, by brute force over candidate centres (reference for "tight") */
function bruteForceRadius(rig: ReturnType<typeof createRig>): number {
  const discs = Array.from(rig.frame.agents.values()).map(a => ({ x: a.x, y: a.y, r: agentDrawRadius(a) + HALO_LABEL_ROOM }))
  let best = Infinity
  const xs = discs.map(d => d.x), ys = discs.map(d => d.y)
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 60; j++) {
      const cx = x0 + ((x1 - x0) * i) / 60, cy = y0 + ((y1 - y0) * j) / 60
      best = Math.min(best, Math.max(...discs.map(d => Math.hypot(d.x - cx, d.y - cy) + d.r)))
    }
  }
  return best + HALO_MARGIN
}

for (const n of [1, 2, 3, 4, 7, 12]) {
  test(`a zone of ${n} agent${n > 1 ? 's' : ''} wraps them and stays within a few percent of the smallest circle`, async () => {
    const rig = await session(n)
    try {
      const [z] = rig.clusters()
      assert.ok(z, 'one zone')
      assert.ok(wraps(z, Array.from(rig.frame.agents.values()).map(a => ({ x: a.x, y: a.y, r: agentDrawRadius(a) })), HALO_MARGIN), 'every agent inside')
      const ref = bruteForceRadius(rig)
      assert.ok(z.r <= ref * 1.03 + 2, `zone ${Math.round(z.r)} vs smallest ${Math.round(ref)}`)
    } finally { rig.destroy() }
  })
}

test('the zone grows with the number of agents and a small team gets a small zone (no fixed minimum)', async () => {
  const radii: number[] = []
  for (const n of [2, 3, 5, 8, 12]) {
    const rig = await session(n)
    try { radii.push(rig.clusters()[0].r) } finally { rig.destroy() }
  }
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1] - 1, `radii ${radii.map(Math.round)}`)
  assert.ok(radii[0] < 200, `2 agents: ${Math.round(radii[0])}`)
  assert.ok(radii[1] < 300, `3 agents: ${Math.round(radii[1])}`)
  assert.ok(radii[3] < 340, `8 agents: ${Math.round(radii[3])}`)
})

for (const n of [3, 4, 5, 8]) {
  test(`the orchestrator is in the middle of the zone of its ${n - 1} children`, async () => {
    const rig = await session(n)
    try {
      const z = rig.clusters()[0]
      const lead = rig.frame.agents.get('s:main')!
      assert.ok(Math.hypot(lead.x - z.cx, lead.y - z.cy) < 0.12 * z.r, `lead ${Math.round(Math.hypot(lead.x - z.cx, lead.y - z.cy))}px from the middle of a zone of ${Math.round(z.r)}`)
    } finally { rig.destroy() }
  })
}

test('agents appearing grow the zone, finishing under Hide inactive agents shrinks it again, the orchestrator stays centred', async () => {
  const rig = createRig(true)
  try {
    const ids = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']
    rig.push([spawn('main'), ...ids.slice(0, 2).map(n => spawn(n, 'main'))])
    await rig.flush()
    for (const n of ids.slice(0, 2)) rig.setState(`s:${n}`, 'thinking')
    rig.frames(700)
    const two = rig.clusters()[0].r
    rig.push(ids.slice(2).map(n => spawn(n, 'main')))
    await rig.flush()
    for (const n of ids) rig.setState(`s:${n}`, 'thinking')
    rig.frames(900)
    const six = rig.clusters()[0]
    assert.ok(six.r > two + 15, `grew from ${Math.round(two)} to ${Math.round(six.r)}`)
    for (const n of ids.slice(2)) rig.setState(`s:${n}`, 'complete')
    rig.frames(900)
    const back = rig.clusters()[0]
    assert.ok(back.r < six.r - 15, `shrank to ${Math.round(back.r)}`)
    assert.equal(back.memberIds.length, 3, 'the finished agents are not in the zone')
    const lead = rig.frame.agents.get('s:main')!
    assert.ok(Math.hypot(lead.x - back.cx, lead.y - back.cy) < 0.12 * back.r)
  } finally { rig.destroy() }
})

test('an agent joining moves the zone by a fraction of the layout per frame: no jump', async () => {
  const rig = await session(3)
  try {
    const before = rig.clusters()[0]
    rig.push([spawn('late', 'main')])
    await rig.flush()
    rig.frames(1)
    const after = rig.clusters()[0]
    assert.ok(Math.abs(after.r - before.r) < 160 && Math.hypot(after.cx - before.cx, after.cy - before.cy) < 160)
  } finally { rig.destroy() }
})

test('empty zone: no agent, or every agent hidden, draws nothing', async () => {
  assert.deepEqual(computeClusters([]), [])
  const rig = await session(3)
  try {
    const hidden = Array.from(rig.frame.agents.values()).map(a => ({ ...a, opacity: 0 }))
    assert.deepEqual(computeClusters(hidden, rig.frame.teams, { minMembers: 1 }), [])
  } finally { rig.destroy() }
})

test('zones of several sessions do not overlap each other', async () => {
  const rig = createRig()
  try {
    const sizes: Array<[string, number]> = [['a', 2], ['b', 7], ['c', 4], ['d', 1], ['e', 5]]
    for (const [sid, n] of sizes) rig.push([spawn(`${sid}-main`, undefined, sid), ...Array.from({ length: n - 1 }, (_, i) => spawn(`${sid}-w${i}`, `${sid}-main`, sid))])
    await rig.flush()
    rig.frames(900)
    const zones = rig.clusters()
    assert.equal(zones.length, sizes.length)
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
      const d = Math.hypot(zones[i].cx - zones[j].cx, zones[i].cy - zones[j].cy)
      assert.ok(d >= zones[i].r + zones[j].r, `${zones[i].key} / ${zones[j].key}: ${Math.round(d)} < ${Math.round(zones[i].r + zones[j].r)}`)
    }
  } finally { rig.destroy() }
})

// ─── Workflow zones (phases) ─────────────────────────────────────────────────

function workflow(phases: string[], perPhase: number): Ev[] {
  const names = phases.flatMap(p => Array.from({ length: perPhase }, (_, i) => ({ name: `${p}:${i}`, phase: p })))
  return [
    { type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
    ...names.map(m => ({ type: 'agent_spawn' as const, payload: { name: m.name, kind: 'teammate', teamName: 'wf', teamKind: 'workflow', parent: 'orch' } })),
    { type: 'team_info', payload: { teamName: 'wf', teamKind: 'workflow', leadSessionId: 's', members: names.map(m => ({ name: m.name, phase: m.phase })) } },
  ]
}

test('phaseAnchors: a single phase stays on the anchor, several sit on a ring', () => {
  const one = phaseAnchors({ x: 5, y: 7 }, 400, ['Build'])
  assert.deepEqual(one.get('Build'), { x: 5, y: 7 })
  const two = phaseAnchors({ x: 0, y: 0 }, 400, ['Plan', 'Build'])
  assert.ok(Math.hypot(two.get('Plan')!.x, two.get('Plan')!.y) > 100)
})

test('workflow with one phase: a small zone with the orchestrator in the middle', async () => {
  const rig = createRig()
  try {
    rig.push(workflow(['Build'], 3))
    await rig.flush()
    rig.frames(900)
    const z = rig.clusters().find(c => c.kind === 'team')!
    assert.equal(z.memberIds.length, 4)
    assert.ok(z.r < 300, `zone ${Math.round(z.r)}`)
    const lead = rig.frame.agents.get('s:orch')!
    assert.ok(Math.hypot(lead.x - z.cx, lead.y - z.cy) < 0.12 * z.r, `lead ${Math.round(Math.hypot(lead.x - z.cx, lead.y - z.cy))}px off a zone of ${Math.round(z.r)}`)
  } finally { rig.destroy() }
})

test('workflow with one phase: the phase label does not sit on the orchestrator in the middle of the zone', async () => {
  const rig = createRig()
  try {
    rig.push(workflow(['Build'], 3))
    await rig.flush()
    rig.frames(900)
    const agents = Array.from(rig.frame.agents.values()).map(a => ({ ...a, opacity: 1 }))
    const [label] = phaseLabels(agents)
    assert.ok(label, 'one label')
    const lead = rig.frame.agents.get('s:orch')!
    const r = agentDrawRadius(lead)
    assert.ok(!(Math.abs(lead.x - label.x) < 60 + r && lead.y - r < label.y && lead.y + r > label.y - 20), `label at ${Math.round(label.x)},${Math.round(label.y)} over the lead at ${Math.round(lead.x)},${Math.round(lead.y)}`)
  } finally { rig.destroy() }
})

test('workflow with two phases: the zone wraps both, the orchestrator stays near the middle', async () => {
  const rig = createRig()
  try {
    rig.push(workflow(['Plan', 'Build'], 2))
    await rig.flush()
    rig.frames(1200)
    const z = rig.clusters().find(c => c.kind === 'team')!
    assert.equal(z.memberIds.length, 5)
    const lead = rig.frame.agents.get('s:orch')!
    assert.ok(Math.hypot(lead.x - z.cx, lead.y - z.cy) < 0.3 * z.r, `lead ${Math.round(Math.hypot(lead.x - z.cx, lead.y - z.cy))}px off a zone of ${Math.round(z.r)}`)
  } finally { rig.destroy() }
})

test('workflow whose first phase is finished and hidden: the remaining phase gathers around the orchestrator, which is centred on it', async () => {
  const rig = createRig(true)
  try {
    rig.push(workflow(['Plan', 'Build'], 3))
    await rig.flush()
    for (const p of ['Plan', 'Build']) for (let i = 0; i < 3; i++) rig.setState(`s:${p}:${i}`, 'thinking')
    rig.frames(900)
    for (let i = 0; i < 3; i++) rig.setState(`s:Plan:${i}`, 'complete')
    rig.frames(1200)
    const z = rig.clusters().find(c => c.kind === 'team')!
    assert.equal(z.memberIds.length, 4, 'the finished phase is not in the zone')
    const lead = rig.frame.agents.get('s:orch')!
    const middle = extentCentre([0, 1, 2].map(i => rig.frame.agents.get(`s:Build:${i}`)!))!
    assert.ok(Math.hypot(lead.x - middle.x, lead.y - middle.y) < 2, `lead ${Math.round(Math.hypot(lead.x - middle.x, lead.y - middle.y))}px from the middle of its children`)
    assert.ok(z.r < 300, `zone ${Math.round(z.r)}`)
  } finally { rig.destroy() }
})
