import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  computeClusterAnchors, clusterKeyOf, clustersOf, clusterRadius, spawnPosition, createClusterForce, layoutInfo,
  type ClusterInput,
} from '../web/hooks/simulation/fleet-layout'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { archivedToEvict, MAX_ARCHIVED_PER_SESSION } from '../web/hooks/simulation/archive'
import { createTeamTracker, MAX_TEAM_MEMBERS } from '../web/hooks/simulation/team-info'
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
function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  let t = 1
  for (const e of events) state = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: t++ }, ctx)
  return state
}
const main = (sessionId: string): Ev => ({ type: 'agent_spawn', sessionId, payload: { name: 'main', isMain: true } })
const child = (sessionId: string, name: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'agent_spawn', sessionId, payload: { name, parent: 'main', ...extra } })

function assertNoOverlap(clusters: ClusterInput[]): void {
  const anchors = Array.from(computeClusterAnchors(clusters).values())
  assert.equal(anchors.length, clusters.length)
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const d = Math.hypot(anchors[i].x - anchors[j].x, anchors[i].y - anchors[j].y)
      assert.ok(d >= anchors[i].radius + anchors[j].radius, `clusters ${i},${j} overlap (${d})`)
    }
  }
}

test('a single cluster is centred on (0,0)', () => {
  const a = computeClusterAnchors([{ key: 's1', size: 5 }]).get('s1')!
  assert.equal(a.x, 0)
  assert.equal(a.y, 0)
  assert.equal(a.radius, clusterRadius(5))
})

test('anchors never overlap for 1..12 clusters of varying sizes', () => {
  for (let n = 1; n <= 12; n++) {
    const clusters = Array.from({ length: n }, (_, i) => ({ key: `c${i}`, size: 1 + ((i * 7) % 13) * (i % 3 === 0 ? 4 : 1) }))
    assertNoOverlap(clusters)
    assertNoOverlap(clusters.map(c => ({ ...c, size: 1 })))
    assertNoOverlap(clusters.map((c, i) => ({ ...c, size: i === 0 ? 100 : 1 })))
  }
})

test('radius grows with the number of members', () => {
  assert.ok(clusterRadius(10) > clusterRadius(2))
  assert.equal(clusterRadius(1000), clusterRadius(CLUSTER_LAYOUT.maxMembers))
  assert.equal(clusterRadius(Number.NaN), clusterRadius(1))
})

test('anchors are deterministic and spiral anchors are stable when a cluster is added', () => {
  const base = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, size: 3 }))
  assert.deepEqual(computeClusterAnchors(base), computeClusterAnchors(base))
  const before = computeClusterAnchors(base)
  const after = computeClusterAnchors([...base, { key: 'new', size: 4 }])
  for (const [k, a] of before) assert.deepEqual(after.get(k), a, `${k} jumped`)
})

test('ring anchors keep their order and angular sequence when a cluster is added', () => {
  const two = computeClusterAnchors([{ key: 'a', size: 2 }, { key: 'b', size: 2 }])
  assert.equal(two.size, 2)
  const a = two.get('a')!
  assert.ok(Math.hypot(a.x, a.y) > 0, 'with several clusters no anchor sits on the shared origin')
  const three = computeClusterAnchors([{ key: 'a', size: 2 }, { key: 'b', size: 2 }, { key: 'c', size: 2 }])
  // first cluster keeps the top-of-ring slot
  assert.ok(three.get('a')!.y < 0)
  assert.ok(two.get('a')!.y < 0)
})

test('duplicate keys are ignored, empty input gives no anchors', () => {
  assert.equal(computeClusterAnchors([]).size, 0)
  assert.equal(computeClusterAnchors([{ key: 'x', size: 1 }, { key: 'x', size: 9 }]).size, 1)
})

test('cluster key: team name, team membership of the session, else session id', () => {
  assert.equal(clusterKeyOf({ sessionId: 's1', teamName: 'alpha' }), 'team:alpha')
  assert.equal(clusterKeyOf({ sessionId: 's1' }), 'session:s1')
  const teams = new Map([['alpha', { name: 'alpha', leadSessionId: 'lead', members: [{ name: 'bob', sessionId: 'tmux1' }] }]])
  assert.equal(clusterKeyOf({ sessionId: 'lead' }, teams), 'team:alpha')
  assert.equal(clusterKeyOf({ sessionId: 'tmux1' }, teams), 'team:alpha')
  assert.equal(clusterKeyOf({ sessionId: 'other' }, teams), 'session:other')
})

test('single session: main spawns at (0,0), children around it, none superimposed', () => {
  const s = run([main('s1'), child('s1', 'a'), child('s1', 'b'), child('s1', 'c')])
  const m = s.agents.get('s1:main')!
  assert.deepEqual([m.x, m.y], [0, 0])
  const kids = ['a', 'b', 'c'].map(n => s.agents.get(`s1:${n}`)!)
  for (const k of kids) assert.ok(Math.hypot(k.x, k.y) > 100)
  const pts = kids.map(k => `${Math.round(k.x)},${Math.round(k.y)}`)
  assert.equal(new Set(pts).size, 3)
  assert.equal(m.clusterKey, 'session:s1')
})

test('several sessions: each main spawns at its own cluster anchor, not at the origin', () => {
  const s = run([main('s1'), main('s2'), main('s3')])
  const pos = ['s1', 's2', 's3'].map(id => s.agents.get(`${id}:main`)!)
  const set = new Set(pos.map(p => `${Math.round(p.x)},${Math.round(p.y)}`))
  assert.equal(set.size, 3, 'mains are not superimposed')
  // s1 spawned alone at the origin and glides to its anchor in the simulation; later ones start at theirs
  for (const p of pos.slice(1)) assert.ok(Math.hypot(p.x, p.y) > 100)
})

test('team members spawn around the team lead (one cluster), not at a second anchor', () => {
  const s = run([
    main('lead'),
    { type: 'team_info', sessionId: 'lead', payload: { teamName: 'alpha', leadSessionId: 'lead', members: [{ name: 'bob', sessionId: 'tmux1' }] } },
    main('tmux1'),
  ])
  const lead = s.agents.get('lead:main')!
  const tm = s.agents.get('tmux1:main')!
  assert.equal(lead.clusterKey, 'team:alpha')
  assert.equal(tm.clusterKey, 'team:alpha')
  const d = Math.hypot(tm.x - lead.x, tm.y - lead.y)
  assert.ok(Math.abs(d - 250) < 1, `teammate main spawned ${d}px from its lead`)
})

test('teammates spread on an arc around their lead', () => {
  const evs = [main('s1')]
  for (const n of ['a', 'b', 'c', 'd']) evs.push(child('s1', n, { kind: 'teammate', teamName: 'alpha' }))
  const s = run(evs)
  const lead = s.agents.get('s1:main')!
  const angles = ['a', 'b', 'c', 'd'].map(n => { const t = s.agents.get(`s1:${n}`)!; return Math.atan2(t.y - lead.y, t.x - lead.x) }).sort((x, y) => x - y)
  for (let i = 1; i < angles.length; i++) assert.ok(angles[i] - angles[i - 1] > 0.3, 'teammates are spread, not stacked')
})

test('spawnPosition is pure: same input, same output', () => {
  const s = run([main('s1'), child('s1', 'a')])
  const cand = { id: 's1:z', sessionId: 's1', isMain: false, localId: 'z', parentId: 's1:main' }
  assert.deepEqual(spawnPosition(s.agents, cand), spawnPosition(s.agents, cand))
})

test('layout roles: lead held, archived agents flagged, others members', () => {
  const s = run([main('s1'), child('s1', 'a'), child('s1', 'b'), { type: 'agent_complete', sessionId: 's1', payload: { name: 'b' } }])
  const { info } = layoutInfo(s.agents)
  assert.equal(info.get('s1:main')!.role, 'lead')
  assert.equal(info.get('s1:a')!.role, 'member')
  assert.equal(info.get('s1:b')!.role, 'archived')
  assert.deepEqual(clustersOf(s.agents.values()), [{ key: 'session:s1', size: 3 }])
})

test('cluster force holds the lead at its anchor and pulls archived agents to the outer ring', () => {
  const lead = { id: 'l', x: 40, y: -30, vx: 0, vy: 0 }
  const arch = { id: 'x', x: 0, y: 0.5, vx: 0, vy: 0 }
  const infos = new Map([
    ['l', { key: 'k', anchor: { x: 0, y: 0 }, radius: 500, role: 'lead' as const }],
    ['x', { key: 'k', anchor: { x: 0, y: 0 }, radius: 500, role: 'archived' as const }],
  ])
  const f = createClusterForce(id => infos.get(id))
  f.initialize([lead, arch])
  f(1)
  assert.ok(lead.vx < 0 && lead.vy > 0, 'lead is pulled back to the anchor')
  assert.ok(arch.vy > 0, 'archived agent is pushed outward from the anchor')
  lead.x = 0.1; lead.y = 0.1
  f(1)
  assert.deepEqual([lead.x, lead.y], [0, 0], 'lead snaps exactly to the anchor')
})

test('cluster force pushes overlapping clusters apart', () => {
  const a = { id: 'a', x: 0, y: 0, vx: 0, vy: 0 }
  const b = { id: 'b', x: 100, y: 0, vx: 0, vy: 0 }
  const infos = new Map([
    ['a', { key: 'A', anchor: { x: 0, y: 0 }, radius: 400, role: 'member' as const }],
    ['b', { key: 'B', anchor: { x: 0, y: 0 }, radius: 400, role: 'member' as const }],
  ])
  const f = createClusterForce(id => infos.get(id))
  f.initialize([a, b])
  f(1)
  assert.ok(a.vx < 0 && b.vx > 0)
})

// ─── eviction rule ──────────────────────────────────────────────────────────

test('archive eviction never evicts a finished teammate nor a main agent', () => {
  const evs: Ev[] = [main('s'), child('s', 'tm', { kind: 'teammate', teamName: 'alpha' }), { type: 'agent_activity', sessionId: 's', payload: { name: 'tm', activity: 'done' } }]
  for (let i = 0; i < MAX_ARCHIVED_PER_SESSION + 10; i++) {
    evs.push(child('s', `w${i}`), { type: 'agent_complete', sessionId: 's', payload: { name: `w${i}` } })
  }
  const s = run(evs)
  assert.ok(s.agents.has('s:tm'), 'finished teammate is kept')
  assert.equal(s.agents.get('s:tm')!.archived, true)
  assert.ok(s.conversations.has('s:tm'))
  assert.ok(s.timelineEntries.has('s:tm'))
  assert.ok(s.agents.has('s:main'))
  const workers = Array.from(s.agents.values()).filter(a => a.archived && a.kind !== 'teammate')
  assert.equal(workers.length, MAX_ARCHIVED_PER_SESSION)
  assert.ok(!archivedToEvict(s.agents.values(), 's').includes('s:tm'))
})

test('evicting an agent also drops the links that point at it', () => {
  const evs: Ev[] = [main('s'), child('s', 'old'), { type: 'agent_link', sessionId: 's', payload: { from: 'main', to: 'old', content: 'hi' } }, { type: 'agent_complete', sessionId: 's', payload: { name: 'old' } }]
  for (let i = 0; i < MAX_ARCHIVED_PER_SESSION; i++) evs.push(child('s', `w${i}`), { type: 'agent_complete', sessionId: 's', payload: { name: `w${i}` } })
  const s = run(evs)
  assert.ok(!s.agents.has('s:old'))
  assert.equal(Array.from(s.links.values()).some(l => l.to === 's:old'), false)
})

test('a completing lead marks its teammate children done', () => {
  const s = run([main('s'), child('s', 'tm', { kind: 'teammate', teamName: 'alpha' }), { type: 'agent_complete', sessionId: 's', payload: { name: 'main' } }])
  assert.equal(s.agents.get('s:tm')!.activity, 'done')
})

test('team tracker caps members per team and keeps counts consistent', () => {
  const t = createTeamTracker()
  for (let i = 0; i < MAX_TEAM_MEMBERS + 50; i++) t.ingest({ type: 'agent_spawn', sessionId: 's', payload: { name: `m${i}`, kind: 'teammate', teamName: 'alpha' } })
  assert.equal(t.memberCount('alpha'), MAX_TEAM_MEMBERS)
  assert.equal(t.working('alpha'), MAX_TEAM_MEMBERS)
  t.ingest({ type: 'agent_activity', sessionId: 's', payload: { name: 'm0', activity: 'idle' } })
  t.ingest({ type: 'agent_complete', sessionId: 's', payload: { name: 'm1' } })
  t.ingest({ type: 'agent_complete', sessionId: 's', payload: { name: 'm1' } })
  assert.equal(t.working('alpha'), MAX_TEAM_MEMBERS - 2)
  t.clear()
  assert.equal(t.memberCount('alpha'), 0)
})
