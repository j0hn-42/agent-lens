// Phases of a workflow (#146): grouping, stamping from team_info (never inferred) and canvas layout.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import { phaseAnchors, layoutInfo } from '../web/hooks/simulation/fleet-layout'
import { groupByPhase, phaseSegmentLabel } from '../web/lib/phase-groups'
import { CLUSTER_LAYOUT } from '../web/lib/canvas-constants'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 1
  for (const e of events) state = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: t++ }, ctx)
  return state
}

const wfAgent = (n: string): Ev => ({ type: 'agent_spawn', sessionId: 'S', payload: { name: n, kind: 'teammate', teamName: 'wf', teamKind: 'workflow', parent: 'orch' } })
const orch: Ev = { type: 'agent_spawn', sessionId: 'S', payload: { name: 'orch', isMain: true } }
const info = (members: Array<{ name: string; phase?: string }>): Ev =>
  ({ type: 'team_info', sessionId: 'S', payload: { teamName: 'wf', teamKind: 'workflow', leadSessionId: 'S', members } })

// ─── groupByPhase ────────────────────────────────────────────────────────────

test('groupByPhase: phases in order of first appearance, plain items first, phase-less workflow agents in a named group', () => {
  const items = [
    { id: 'orch' },
    { id: 'a', teamKind: 'workflow' as const, phase: 'Review' },
    { id: 'b', teamKind: 'workflow' as const, phase: 'Implement' },
    { id: 'c', teamKind: 'workflow' as const },
    { id: 'd', teamKind: 'workflow' as const, phase: 'Review' },
  ]
  const segs = groupByPhase(items)
  assert.deepEqual(segs.map(s => [s.kind, s.kind === 'phase' ? s.phase : '', s.items.map(i => i.id)]), [
    ['plain', '', ['orch']], ['phase', 'Review', ['a', 'd']], ['phase', 'Implement', ['b']], ['none', '', ['c']],
  ])
  assert.deepEqual(segs.map(s => phaseSegmentLabel(s)), ['', 'Phase Review', 'Phase Implement', 'No phase'])
})

test('groupByPhase: without any announced phase nothing is grouped and no phase is invented', () => {
  const items = [{ id: 'orch' }, { id: 'a', teamKind: 'workflow' as const }, { id: 'b', teamKind: 'workflow' as const }]
  const segs = groupByPhase(items)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'plain')
  assert.deepEqual(segs[0].items, items)
  assert.deepEqual(groupByPhase([]), [])
})

test('groupByPhase: a phase on an Agent Team member is ignored (phases are a workflow notion)', () => {
  const segs = groupByPhase([{ id: 'a', phase: 'X' }, { id: 'b', teamKind: 'team' as const, phase: 'Y' }])
  assert.deepEqual(segs.map(s => s.kind), ['plain'])
})

// ─── Stamping from team_info ─────────────────────────────────────────────────

test('the phase of an agent comes only from team_info, whatever the order of events', () => {
  const before = run([orch, info([{ name: 'x', phase: 'Implement' }, { name: 'y' }]), wfAgent('x'), wfAgent('y'), wfAgent('z')])
  assert.equal(before.agents.get('S:x')?.phase, 'Implement')
  assert.equal(before.agents.get('S:y')?.phase, undefined, 'member announced without phase')
  assert.equal(before.agents.get('S:z')?.phase, undefined, 'agent unknown to team_info')
  const after = run([orch, wfAgent('x'), wfAgent('y'), info([{ name: 'x', phase: 'Review' }, { name: 'y' }])])
  assert.equal(after.agents.get('S:x')?.phase, 'Review')
  assert.equal(after.agents.get('S:y')?.phase, undefined)
  assert.equal(after.agents.get('S:orch')?.phase, undefined)
  // A later team_info that drops the phase removes it
  const dropped = run([orch, wfAgent('x'), info([{ name: 'x', phase: 'Review' }]), info([{ name: 'x' }])])
  assert.equal(dropped.agents.get('S:x')?.phase, undefined)
})

test('an Agent Team member never gets a phase, even if its member entry carries one', () => {
  const s = run([
    orch,
    { type: 'agent_spawn', sessionId: 'S', payload: { name: 'm', kind: 'teammate', teamName: 'tm', parent: 'orch' } },
    { type: 'team_info', sessionId: 'S', payload: { teamName: 'tm', leadSessionId: 'S', members: [{ name: 'm', phase: 'Oops' }] } },
  ])
  assert.equal(s.agents.get('S:m')?.phase, undefined)
})

// ─── Layout ──────────────────────────────────────────────────────────────────

test('phaseAnchors: one centre per distinct phase, in order, on a ring inside the cluster disc, deterministic', () => {
  const a = phaseAnchors({ x: 10, y: 20 }, 400, ['A', 'B', 'A', 'C'])
  assert.deepEqual([...a.keys()], ['A', 'B', 'C'])
  for (const p of a.values()) assert.ok(Math.abs(Math.hypot(p.x - 10, p.y - 20) - 400 * CLUSTER_LAYOUT.phaseRingFactor) < 1e-6)
  const [pa, pb, pc] = [...a.values()]
  assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) > 100 && Math.hypot(pb.x - pc.x, pb.y - pc.y) > 100)
  assert.deepEqual(phaseAnchors({ x: 10, y: 20 }, 400, ['A', 'B', 'A', 'C']), a)
  assert.equal(phaseAnchors({ x: 0, y: 0 }, 400, []).size, 0)
})

test('layoutInfo: members of a phase are pulled to that phase, the lead and phase-less members to the cluster anchor', () => {
  const s = run([orch, wfAgent('a'), wfAgent('b'), wfAgent('c'), wfAgent('d'),
    info([{ name: 'a', phase: 'P1' }, { name: 'b', phase: 'P1' }, { name: 'c', phase: 'P2' }, { name: 'd' }])])
  const { info: li, anchors } = layoutInfo(s.agents, s.teams)
  const pull = (id: string) => li.get(`S:${id}`)?.pull
  assert.deepEqual(pull('a'), pull('b'))
  assert.notDeepEqual(pull('a'), pull('c'))
  assert.ok(pull('a') && pull('c'))
  assert.equal(pull('d'), undefined, 'no phase announced: no pull to any phase')
  assert.equal(pull('orch'), undefined)
  assert.ok(anchors.size === 1)
})

test('layoutInfo: no phase announced anywhere gives exactly the layout of before (no pull)', () => {
  const s = run([orch, wfAgent('a'), wfAgent('b'), info([{ name: 'a' }, { name: 'b' }])])
  for (const i of layoutInfo(s.agents, s.teams).info.values()) assert.equal(i.pull, undefined)
})

test('force layout: after settling, each member is closer to its own phase centroid than to the other phase', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const phaseOf = (n: string) => (['a', 'b', 'c'].includes(n) ? 'P1' : 'P2')
  let state = run([orch, ...names.map(wfAgent), info(names.map(n => ({ name: n, phase: phaseOf(n) })))])
  const layout = createForceLayout()
  state = layout.syncState(state)
  for (let i = 0; i < 400; i++) state = layout.stepState(state)
  layout.destroy()
  const centroid = (p: string) => {
    const m = names.filter(n => phaseOf(n) === p).map(n => state.agents.get(`S:${n}`)!)
    return { x: m.reduce((s, a) => s + a.x, 0) / m.length, y: m.reduce((s, a) => s + a.y, 0) / m.length }
  }
  const c1 = centroid('P1'), c2 = centroid('P2')
  assert.ok(Math.hypot(c1.x - c2.x, c1.y - c2.y) > 300, 'the two phases form two separate sub-groups')
  for (const n of names) {
    const a = state.agents.get(`S:${n}`)!
    const own = phaseOf(n) === 'P1' ? c1 : c2
    const other = phaseOf(n) === 'P1' ? c2 : c1
    assert.ok(Math.hypot(a.x - own.x, a.y - own.y) < Math.hypot(a.x - other.x, a.y - other.y), `${n} sits with its phase`)
  }
})

test('team_info that changes a phase after the spawn asks for a layout resync; an unchanged one does not', async () => {
  let syncs = 0
  const live: ProcessEventContext = { ...ctx, skipForceSync: false, syncForceSimulation: () => { syncs++ } }
  let state = createEmptyState()
  let t = 1
  const feed = (e: Ev) => { state = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: t++ }, live) }
  const settle = () => new Promise(r => setTimeout(r, 5))
  for (const e of [orch, wfAgent('x')]) feed(e)
  await settle()
  const afterSpawn = syncs
  feed(info([{ name: 'x', phase: 'Implement' }]))
  await settle()
  assert.equal(syncs, afterSpawn + 1, 'the phase arrived after the spawn: the members must move')
  feed(info([{ name: 'x', phase: 'Implement' }]))
  await settle()
  assert.equal(syncs, afterSpawn + 1, 'same phase again: nothing to move')
})
