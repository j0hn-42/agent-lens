// Orchestrator centred on its children (#151): real events -> processEvent -> force layout, frame by frame
// (same wiring as fleet-layout-integration.test.ts). A parent sits in the middle of the extent of its drawn children,
// whether they are 2, 3 or n, also for sub-orchestrators, and follows them when they appear, finish or get hidden.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import { centredChildren, extentCentre } from '../web/hooks/simulation/fleet-layout'
import { CLUSTER_LAYOUT } from '../web/lib/canvas-constants'
import type { SimulationEvent } from '../web/lib/agent-types'

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
const SID = 's'

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
        frame = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId ?? SID }, { ...frame, currentTime: t }, ctx)
        t += 0.01
      }
    },
    /** Layout steps only (the agents' own animation is irrelevant here) */
    frames(n: number) { for (let i = 0; i < n; i++) frame = layout.stepState(frame) },
    /** Change the state of an agent (e.g. 'complete') the way the simulation does between two events */
    setState(id: string, state: 'complete' | 'idle' | 'thinking') {
      const agents = new Map(frame.agents)
      agents.set(id, { ...agents.get(id)!, state })
      frame = { ...frame, agents }
    },
    setHideInactive: layout.setHideInactive,
    flush: () => new Promise<void>(r => setTimeout(r, 0)),
    destroy: () => layout.destroy(),
  }
}

const spawn = (name: string, parent?: string): Ev => ({ type: 'agent_spawn', payload: { name, ...(parent ? { parent } : { isMain: true }) } })
/** Largest side of the extent of the given agents */
const spreadOf = (rig: ReturnType<typeof createRig>, names: string[]): number => {
  const ps = names.map(n => rig.frame.agents.get(`${SID}:${n}`)!)
  return Math.max(Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)), Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)))
}
const id = (name: string) => `${SID}:${name}`

/** Gap between an agent and the middle of the extent of the given children */
function gapToMiddle(rig: ReturnType<typeof createRig>, parent: string, children: string[]): number {
  const c = extentCentre(children.map(n => rig.frame.agents.get(id(n))!))!
  const p = rig.frame.agents.get(id(parent))!
  return Math.hypot(c.x - p.x, c.y - p.y)
}

for (const n of [2, 3, 4, 5, 8]) {
  test(`the orchestrator is in the middle of its ${n} children (${n % 2 ? 'odd' : 'even'})`, async () => {
    const rig = createRig()
    try {
      rig.push([spawn('main'), ...Array.from({ length: n }, (_, i) => spawn(`w${i}`, 'main'))])
      await rig.flush()
      rig.frames(600)
      const kids = Array.from({ length: n }, (_, i) => `w${i}`)
      assert.ok(gapToMiddle(rig, 'main', kids) < 1.5, `gap ${gapToMiddle(rig, 'main', kids)}`)
      const lead = rig.frame.agents.get(id('main'))!
      assert.deepEqual([lead.x, lead.y], [0, 0], 'the lead stays on the anchor of its cluster')
    } finally { rig.destroy() }
  })
}

test('one child: nothing to centre on, the orchestrator is not dragged onto it', async () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('w0', 'main')])
    await rig.flush()
    rig.frames(600)
    const a = rig.frame.agents.get(id('main'))!, b = rig.frame.agents.get(id('w0'))!
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 100, 'still apart')
  } finally { rig.destroy() }
})

test('a sub-orchestrator is in the middle of its own children', async () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('sub', 'main'), spawn('o1', 'main'), spawn('o2', 'main'),
      spawn('a', 'sub'), spawn('b', 'sub'), spawn('c', 'sub')])
    await rig.flush()
    rig.frames(900)
    assert.ok(gapToMiddle(rig, 'sub', ['a', 'b', 'c']) < 0.05 * spreadOf(rig, ['a', 'b', 'c']), `sub gap ${gapToMiddle(rig, 'sub', ['a', 'b', 'c'])}`)
    assert.ok(gapToMiddle(rig, 'main', ['sub', 'o1', 'o2']) < 0.05 * spreadOf(rig, ['sub', 'o1', 'o2']), `main gap ${gapToMiddle(rig, 'main', ['sub', 'o1', 'o2'])}`)
  } finally { rig.destroy() }
})

test('children added later: the orchestrator follows without ever jumping', async () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('w0', 'main'), spawn('w1', 'main')])
    await rig.flush()
    rig.frames(600)
    rig.push([spawn('w2', 'main'), spawn('w3', 'main'), spawn('w4', 'main')])
    await rig.flush()
    const before = Array.from(rig.frame.agents.values()).map(a => ({ id: a.id, x: a.x, y: a.y }))
    rig.frames(1)
    const maxStep = Math.max(...before.map(p => { const a = rig.frame.agents.get(p.id)!; return Math.hypot(a.x - p.x, a.y - p.y) }))
    assert.ok(maxStep < 150, `one frame moves an agent by ${maxStep}px at most`)
    rig.frames(1500)
    assert.ok(gapToMiddle(rig, 'main', ['w0', 'w1', 'w2', 'w3', 'w4']) < 1.5)
  } finally { rig.destroy() }
})

test('a sub-orchestrator eases to its new middle: a child appearing moves it by a fraction of the gap per frame', async () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('o1', 'main'), spawn('o2', 'main'), spawn('sub', 'main'), spawn('a', 'sub'), spawn('b', 'sub')])
    await rig.flush()
    rig.frames(1500)
    rig.push([spawn('c', 'sub'), spawn('d', 'sub')])
    await rig.flush()
    rig.frames(1500)
    const gap = gapToMiddle(rig, 'sub', ['a', 'b', 'c', 'd'])
    assert.ok(gap < 0.05 * spreadOf(rig, ['a', 'b', 'c', 'd']), `sub gap ${gap}`)
  } finally { rig.destroy() }
})

test('Hide inactive agents: finished children no longer count, the orchestrator re-centres on the visible ones', async () => {
  const rig = createRig(true)
  try {
    rig.push([spawn('main'), ...['w0', 'w1', 'w2', 'w3', 'w4'].map(n => spawn(n, 'main'))])
    await rig.flush()
    for (const n of ['w0', 'w1', 'w2', 'w3', 'w4']) rig.setState(id(n), 'thinking')
    rig.frames(600)
    rig.setState(id('w3'), 'complete')
    rig.setState(id('w4'), 'complete')
    rig.frames(600)
    assert.ok(gapToMiddle(rig, 'main', ['w0', 'w1', 'w2']) < 1.5, `gap ${gapToMiddle(rig, 'main', ['w0', 'w1', 'w2'])}`)
    // Showing them again brings the five back into the count
    rig.setHideInactive(false)
    rig.frames(600)
    assert.ok(gapToMiddle(rig, 'main', ['w0', 'w1', 'w2', 'w3', 'w4']) < 1.5)
  } finally { rig.destroy() }
})

test('centredChildren: direct, drawn, non archived children of parents with at least two', () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('a', 'main'), spawn('b', 'main'), spawn('c', 'a')])
    const groups = centredChildren(rig.frame.agents, false)
    assert.deepEqual(groups.get(id('main')), [id('a'), id('b')])
    assert.equal(groups.has(id('a')), false, 'a single child is not enough')
    assert.ok(CLUSTER_LAYOUT.minCentredChildren >= 2)
  } finally { rig.destroy() }
})

test('centredChildren leaves out a parent whose children span several workflow phases (#146), not one with a single phase', () => {
  const rig = createRig()
  try {
    rig.push([spawn('main'), spawn('a', 'main'), spawn('b', 'main')])
    const agents = new Map(rig.frame.agents)
    agents.set(id('a'), { ...agents.get(id('a'))!, teamKind: 'workflow', phase: 'Implement' })
    assert.deepEqual(centredChildren(agents, false).get(id('main')), [id('a'), id('b')], 'one phase: centred like any parent')
    agents.set(id('b'), { ...agents.get(id('b'))!, teamKind: 'workflow', phase: 'Review' })
    assert.equal(centredChildren(agents, false).has(id('main')), false, 'two phases: laid out by phase')
  } finally { rig.destroy() }
})

test('extentCentre: middle of the bounding box, undefined without points', () => {
  assert.deepEqual(extentCentre([{ x: 0, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 2 }]), { x: 5, y: 2 })
  assert.equal(extentCentre([]), undefined)
})
