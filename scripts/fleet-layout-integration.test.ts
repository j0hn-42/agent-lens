// Pure-parts integration (#36): real events -> processEvent -> force layout -> computeNextFrame, driven
// frame by frame by a hand-written rig that COPIES the wiring of useAgentSimulation.
// It covers only the pure modules; it cannot detect a wiring regression in the hook itself (e.g. a deleted
// layout step in animate(), the D3 bug). That wiring is guarded by the test on the real hook:
// web/tests-a11y/fleet-layout-hook.test.tsx (pnpm test:a11y).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { createForceLayout, type ForceLayout } from '../web/hooks/simulation/force-layout'
import { layoutInfo } from '../web/hooks/simulation/fleet-layout'
import { CLUSTER_LAYOUT } from '../web/lib/canvas-constants'
import type { SimulationEvent } from '../web/lib/agent-types'

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
const DT = 1 / 60

/** Same wiring as useAgentSimulation: frameRef + force layout + deferred sync after spawns */
function createRig(withLayout = true) {
  const layout: ForceLayout = createForceLayout()
  let frame: SimulationState = createEmptyState()
  let t = 1
  const ctx: ProcessEventContext = {
    // The hook syncs from frameRef (positions are current), not from the snapshot handed to the callback
    syncForceSimulation: () => { if (withLayout) frame = layout.syncState(frame) },
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: false,
  }
  return {
    get frame() { return frame },
    push(events: Ev[]) {
      for (const e of events) {
        frame = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...frame, currentTime: t }, ctx)
        t += 0.01
      }
    },
    /** One animation frame: computeNextFrame, then the layout step (as animate() does) */
    frames(n: number) {
      for (let i = 0; i < n; i++) {
        const next = computeNextFrame(frame, DT, frame.currentTime + DT, Math.max(frame.maxTimeReached, frame.currentTime + DT), frame,
          { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
        frame = withLayout ? layout.stepState(next) : next
      }
    },
    /** Let the deferred (setTimeout 0) syncs run */
    flush: () => new Promise<void>(r => setTimeout(r, 0)),
    destroy: () => layout.destroy(),
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
  assert.equal(info.size, state.agents.size, `${label}: every agent has a cluster`)
  const leads = new Map<string, { id: string; x: number; y: number }>()
  for (const a of state.agents.values()) {
    const i = info.get(a.id)!
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `${label}: ${a.id} has finite position`)
    if (i.role === 'lead') {
      leads.set(i.key, a)
      assert.ok(Math.hypot(a.x - i.anchor.x, a.y - i.anchor.y) < 1, `${label}: lead ${a.id} reached its anchor (at ${a.x.toFixed(1)},${a.y.toFixed(1)}, anchor ${i.anchor.x.toFixed(1)},${i.anchor.y.toFixed(1)})`)
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

for (const count of [1, 3, 5, 12]) {
  test(`${count} session(s) of varied sizes settle with no overlapping clusters`, async () => {
    const rig = createRig()
    try {
      for (let i = 0; i < count; i++) {
        rig.push(sessionEvents(`sess-${i}`, SIZES[i], { grandchildren: i % 2 === 1 }))
        rig.frames(3)
      }
      await rig.flush()
      rig.frames(1200)
      assert.equal(rig.frame.agents.size, SIZES.slice(0, count).reduce((s, n) => s + n, 0))
      assertLayoutInvariants(rig.frame, `${count} sessions`)
      if (count === 1) {
        const lead = rig.frame.agents.get('sess-0:main')!
        assert.deepEqual([lead.x, lead.y], [0, 0], 'the lead of a single cluster is at (0,0)')
      }
    } finally { rig.destroy() }
  })
}

test('negative control: without the layout step the same scenario violates the invariants (the check is not vacuous)', async () => {
  const rig = createRig(false)
  for (let i = 0; i < 5; i++) { rig.push(sessionEvents(`sess-${i}`, SIZES[i])); rig.frames(3) }
  await rig.flush()
  rig.frames(600)
  assert.throws(() => assertLayoutInvariants(rig.frame, 'unlaid-out'), /reached its anchor|foreign cluster|too close|inside its own disc/)
})

test('a team and plain sessions settle together, teammates stay in the team disc', async () => {
  const rig = createRig()
  try {
    rig.push(sessionEvents('L', 5, { team: 'alpha' }))
    rig.push([{ type: 'team_info', sessionId: 'L', payload: { teamName: 'alpha', leadSessionId: 'L', members: [] } }])
    rig.push(sessionEvents('S1', 3))
    rig.push(sessionEvents('S2', 2))
    await rig.flush()
    rig.frames(1200)
    assertLayoutInvariants(rig.frame, 'team + sessions')
  } finally { rig.destroy() }
})

test('clusters that grow later push their neighbours: no overlap after late spawns', async () => {
  const rig = createRig()
  try {
    for (let i = 0; i < 3; i++) rig.push(sessionEvents(`s${i}`, 1))
    await rig.flush()
    rig.frames(300)
    assertLayoutInvariants(rig.frame, 'before growth')
    for (let k = 1; k <= 9; k++) {
      rig.push([{ type: 'agent_spawn', sessionId: 's1', payload: { name: `late${k}`, parent: 'main' } }])
      rig.frames(20)
    }
    await rig.flush()
    rig.frames(1200)
    assertLayoutInvariants(rig.frame, 'after growth')
  } finally { rig.destroy() }
})

test('the layout settles: once nothing moves, frames leave the state untouched', async () => {
  const rig = createRig()
  try {
    rig.push(sessionEvents('a', 4)); rig.push(sessionEvents('b', 3))
    await rig.flush()
    rig.frames(2000)
    const snap = Array.from(rig.frame.agents.values(), a => [a.id, a.x, a.y])
    rig.frames(30)
    assert.deepEqual(Array.from(rig.frame.agents.values(), a => [a.id, a.x, a.y]), snap)
  } finally { rig.destroy() }
})
