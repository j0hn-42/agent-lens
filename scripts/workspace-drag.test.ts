// Workspaces moved with the mouse: the force layout follows the drag and lays the other workspaces out around it.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import { layoutInfo, type SessionProjects } from '../web/hooks/simulation/fleet-layout'
import type { SimulationEvent } from '../web/lib/agent-types'

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
const DT = 1 / 60

const PROJECTS: SessionProjects = new Map([
  ['a1', { projectId: 'A', projectName: 'alpha' }],
  ['a2', { projectId: 'A', projectName: 'alpha' }],
  ['b1', { projectId: 'B', projectName: 'beta' }],
  ['c1', { projectId: 'C', projectName: 'gamma' }],
])

/** Same wiring as useAgentSimulation (see fleet-layout-integration.test.ts), with the projects of the sessions */
function createRig() {
  const layout = createForceLayout()
  let frame: SimulationState = createEmptyState()
  let t = 1
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => { frame = layout.syncState(frame, PROJECTS) },
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: false,
  }
  return {
    layout,
    get frame() { return frame },
    set frame(f: SimulationState) { frame = f },
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
        frame = layout.stepState(next)
      }
    },
    flush: () => new Promise<void>(r => setTimeout(r, 0)),
  }
}

function session(sid: string, size: number): Ev[] {
  const evs: Ev[] = [{ type: 'agent_spawn', sessionId: sid, payload: { name: 'main', isMain: true } }]
  for (let i = 1; i < size; i++) evs.push({ type: 'agent_spawn', sessionId: sid, payload: { name: `w${i}`, parent: 'main' } })
  return evs
}

async function settledRig() {
  const rig = createRig()
  for (const [sid, n] of [['a1', 3], ['a2', 2], ['b1', 4], ['c1', 2]] as const) rig.push(session(sid, n))
  await rig.flush()
  rig.frames(900)
  return rig
}

const agentsOf = (state: SimulationState, project: string) =>
  Array.from(state.agents.values()).filter(a => PROJECTS.get(a.sessionId)?.projectId === project)

test('moveWorkspace: the agents of the workspace follow the pointer at once, by the same offset', async () => {
  const rig = await settledRig()
  try {
    const from = rig.layout.workspaceCentre('A')!
    assert.ok(from, 'A has a zone')
    const before = new Map(agentsOf(rig.frame, 'A').map(a => [a.id, { x: a.x, y: a.y }]))
    rig.layout.moveWorkspace('A', from.x + 800, from.y - 300)
    rig.frames(1)
    for (const a of agentsOf(rig.frame, 'A')) {
      const b = before.get(a.id)!
      assert.ok(Math.abs(a.x - b.x - 800) < 5 && Math.abs(a.y - b.y + 300) < 5, `${a.id} moved by ${a.x - b.x},${a.y - b.y}`)
    }
    const to = rig.layout.workspaceCentre('A')!
    assert.ok(Math.hypot(to.x - from.x - 800, to.y - from.y + 300) < 1e-6, 'the zone is centred where it was put')
  } finally { rig.layout.destroy() }
})

test('moveWorkspace: dropped onto another workspace, the other one moves aside and the layout settles without overlap', async () => {
  const rig = await settledRig()
  try {
    const target = rig.layout.workspaceCentre('B')!
    rig.layout.moveWorkspace('A', target.x, target.y)
    rig.frames(1200)
    const { info, anchors } = layoutInfo(rig.frame.agents, rig.frame.teams, PROJECTS, false, rig.layout.placements)
    for (const a of rig.frame.agents.values()) {
      const own = info.get(a.id)!
      if (own.role === 'lead') assert.ok(Math.hypot(a.x - own.anchor.x, a.y - own.anchor.y) < 1, `lead ${a.id} reached its anchor`)
      for (const other of anchors.values()) {
        if (other.key === own.key) continue
        assert.ok(Math.hypot(a.x - other.x, a.y - other.y) > other.radius, `${a.id} sits inside ${other.key}`)
      }
    }
    assert.equal(rig.layout.active, false, 'the layout comes to rest')
  } finally { rig.layout.destroy() }
})

test('moveWorkspace: an agent pinned by hand in the workspace moves with it', async () => {
  const rig = await settledRig()
  try {
    const pinned = agentsOf(rig.frame, 'A').find(a => !a.isMain)!
    const at = { x: pinned.x + 20, y: pinned.y + 20 }
    const agents = new Map(rig.frame.agents)
    agents.set(pinned.id, { ...pinned, ...at, pinned: true })
    rig.frame = { ...rig.frame, agents }
    rig.layout.pin(pinned.id, at.x, at.y)
    rig.frames(2)
    const from = rig.layout.workspaceCentre('A')!
    rig.layout.moveWorkspace('A', from.x - 500, from.y)
    rig.frames(1)
    const now = rig.frame.agents.get(pinned.id)!
    assert.ok(Math.abs(now.x - (at.x - 500)) < 1e-6 && Math.abs(now.y - at.y) < 1e-6, `pinned agent at ${now.x},${now.y}`)
    assert.equal(now.pinned, true, 'it stays pinned')
  } finally { rig.layout.destroy() }
})

test('resetWorkspaces: every workspace goes back to its automatic place', async () => {
  const rig = await settledRig()
  try {
    const auto = rig.layout.workspaceCentre('B')!
    rig.layout.moveWorkspace('B', auto.x + 3000, auto.y + 3000)
    rig.frames(5)
    assert.equal(rig.layout.placements.size, 1)
    rig.layout.resetWorkspaces()
    assert.equal(rig.layout.placements.size, 0)
    const back = rig.layout.workspaceCentre('B')!
    assert.ok(Math.hypot(back.x - auto.x, back.y - auto.y) < 1e-6, 'B is back in its slot')
  } finally { rig.layout.destroy() }
})

test('workspaceCentre: none for an unknown project', async () => {
  const rig = await settledRig()
  try { assert.equal(rig.layout.workspaceCentre('Z'), undefined) } finally { rig.layout.destroy() }
})
