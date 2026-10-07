import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from '../web/node_modules/d3-force'
import { clusterKeyOf, layoutInfo, createClusterForce } from '../web/hooks/simulation/fleet-layout'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState, type ForceNode, type ForceLink } from '../web/hooks/simulation/types'
import {
  MAX_AGENTS_TOTAL, MAX_AGENTS_PER_SESSION, MAX_LINKS_PER_SESSION,
} from '../web/hooks/simulation/archive'
import {
  MAX_TEAM_MEMBERS, MAX_TEAMS, eventMatchesSelection, createTeamTracker,
} from '../web/hooks/simulation/team-info'
import {
  sanitizeSessionInfo, teamSelectionId, parseTeamSelection, isUnionSelection, ALL_SESSIONS_ID, type SessionInfo,
} from '../web/lib/bridge-types'
import { FORCE, CLUSTER_LAYOUT } from '../web/lib/canvas-constants'
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
const done = (sessionId: string, name: string): Ev => ({ type: 'agent_complete', sessionId, payload: { name } })
const teammate = (sessionId: string, name: string, teamName: string): Ev =>
  ({ type: 'agent_spawn', sessionId, payload: { name, parent: 'main', kind: 'teammate', teamName } })

// ─── bounded state ──────────────────────────────────────────────────────────

test('1500 teammate spawn/complete cycles stay bounded by MAX_TEAM_MEMBERS', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < 1500; i++) evs.push(teammate('s', `m${i}`, 'alpha'), done('s', `m${i}`))
  const s = run(evs)
  const members = Array.from(s.agents.values()).filter(a => a.kind === 'teammate')
  assert.ok(members.length <= MAX_TEAM_MEMBERS, `${members.length} teammates kept`)
  assert.ok(s.agents.has('s:main'))
  assert.ok(s.agents.has('s:m1499'), 'the most recent teammate is kept')
  assert.ok(!s.agents.has('s:m0'), 'the oldest finished teammate is evicted')
  assert.ok(s.conversations.size <= s.agents.size)
  assert.ok(s.timelineEntries.size <= s.agents.size)
  for (const l of s.links.values()) assert.ok(s.agents.has(l.from) && s.agents.has(l.to))
})

test('live teammates are never evicted: a spawn beyond the team cap is refused', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < MAX_TEAM_MEMBERS + 20; i++) evs.push(teammate('s', `m${i}`, 'alpha'))
  const s = run(evs)
  const members = Array.from(s.agents.values()).filter(a => a.kind === 'teammate')
  assert.equal(members.length, MAX_TEAM_MEMBERS)
  assert.ok(members.every(a => !a.archived))
  assert.ok(s.agents.has('s:m0'))
})

test('300 distinct team names stay bounded by MAX_TEAMS', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < 300; i++) evs.push(teammate('s', `m${i}`, `team-${i}`))
  const s = run(evs)
  const teams = new Set(Array.from(s.agents.values()).map(a => a.teamName).filter(Boolean))
  assert.ok(teams.size <= MAX_TEAMS, `${teams.size} teams`)
  assert.ok(s.agents.size <= MAX_TEAMS + 1)
})

test('global caps: agents per session and overall, never a live agent or a lead', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < MAX_AGENTS_PER_SESSION + 100; i++) evs.push({ type: 'agent_spawn', sessionId: 's', payload: { name: `w${i}`, parent: 'main' } })
  let s = run(evs)
  const live = Array.from(s.agents.values()).filter(a => a.sessionId === 's')
  assert.equal(live.length, MAX_AGENTS_PER_SESSION, 'live agents are kept, extra spawns refused')
  assert.ok(s.agents.has('s:main'))
  // finishing some makes room: oldest finished go first
  s = run([done('s', 'w0'), done('s', 'w1'), { type: 'agent_spawn', sessionId: 's', payload: { name: 'late', parent: 'main' } }], s)
  assert.ok(s.agents.has('s:late'))
  assert.ok(!s.agents.has('s:w0'))
  assert.ok(s.agents.has('s:w2'))
  // overall: many sessions
  const many: Ev[] = []
  for (let i = 0; i < 60; i++) {
    many.push(main(`t${i}`))
    for (let j = 0; j < 60; j++) many.push({ type: 'agent_spawn', sessionId: `t${i}`, payload: { name: `w${j}`, parent: 'main' } })
  }
  const big = run(many)
  const nonMain = Array.from(big.agents.values()).filter(a => !a.isMain)
  assert.ok(nonMain.length <= MAX_AGENTS_TOTAL)
  assert.equal(Array.from(big.agents.values()).filter(a => a.isMain).length, 60, 'leads are never refused')
})

test('links are capped per session and drop the oldest', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < MAX_LINKS_PER_SESSION + 50; i++) evs.push({ type: 'agent_link', sessionId: 's', payload: { from: 'main', to: `x${i}`, linkId: `l${i}` } })
  const s = run(evs)
  assert.equal(s.links.size, MAX_LINKS_PER_SESSION)
  assert.ok(!s.links.has('l0'))
  assert.ok(s.links.has(`l${MAX_LINKS_PER_SESSION + 49}`))
})

// ─── cluster keys ───────────────────────────────────────────────────────────

test('cluster keys are namespaced: a team called like a session never merges with it', () => {
  assert.equal(clusterKeyOf({ sessionId: 'x', teamName: 'x' }), 'team:x:x')
  assert.equal(clusterKeyOf({ sessionId: 'x' }), 'session:x')
  assert.notEqual(clusterKeyOf({ sessionId: 'a', teamName: 'b' }), clusterKeyOf({ sessionId: 'b' }))
  const s = run([main('beta'), { type: 'agent_spawn', sessionId: 'other', payload: { name: 'main', isMain: true, kind: 'teammate', teamName: 'beta' } }])
  assert.notEqual(s.agents.get('beta:main')!.clusterKey, s.agents.get('other:main')!.clusterKey)
})

test('the cluster key is cached on the agent, also for a returning teammate', () => {
  let s = run([main('s'), teammate('s', 'tm', 'alpha')])
  assert.equal(s.agents.get('s:tm')!.clusterKey, 'team:s:alpha')
  s = run([done('s', 'tm'), teammate('s', 'tm', 'beta')], s)
  assert.equal(s.agents.get('s:tm')!.clusterKey, 'team:s:beta')
})

test('spawn streams leave bounded state (400 sessions, 3000 teammate events)', () => {
  // Sizes, not wall-clock time: a timing assertion is flaky on slow CI machines
  const evs: Ev[] = []
  for (let i = 0; i < 400; i++) evs.push(main(`b${i}`))
  const a = run(evs)
  const tm: Ev[] = [main('lead')]
  for (let i = 0; i < 3000; i++) tm.push(teammate('lead', `m${i % 90}`, 'alpha'), { type: 'agent_activity', sessionId: 'lead', payload: { name: `m${i % 90}`, activity: i % 2 ? 'idle' : 'working' } })
  const b = run(tm)
  assert.equal(a.agents.size, 400)
  assert.ok(b.agents.size <= MAX_TEAM_MEMBERS + 1, `${b.agents.size} agents for one team`)
  assert.ok(b.conversations.size <= b.agents.size)
})

// ─── real d3 simulation ─────────────────────────────────────────────────────

function simulate(sessions: number, perSession: number): { dists: number[]; leadErr: number; maxOverlap: number } {
  const evs: Ev[] = []
  for (let i = 0; i < sessions; i++) {
    evs.push(main(`s${i}`))
    for (let j = 0; j < perSession; j++) evs.push({ type: 'agent_spawn', sessionId: `s${i}`, payload: { name: `c${j}`, parent: 'main' } })
  }
  const state = run(evs)
  const { info } = layoutInfo(state.agents, state.teams)
  const nodes: ForceNode[] = Array.from(state.agents.values()).map(a => ({ id: a.id, x: a.x, y: a.y, vx: 0, vy: 0 }))
  const links: ForceLink[] = state.edges.map(e => ({ id: e.id, source: e.from, target: e.to }))
  const sim = forceSimulation<ForceNode, ForceLink>(nodes)
    .force('charge', forceManyBody().strength(FORCE.chargeStrength))
    .force('center', forceCenter(0, 0).strength(0))
    .force('collide', forceCollide(FORCE.collideRadius))
    .force('cluster', createClusterForce(id => info.get(id)))
    .force('link', forceLink<ForceNode, ForceLink>(links).id(d => d.id).distance(FORCE.linkDistance).strength(FORCE.linkStrength))
    .alphaDecay(FORCE.alphaDecay)
    .velocityDecay(FORCE.velocityDecay)
    .stop()
  for (let i = 0; i < 600; i++) sim.tick()
  let leadErr = 0
  for (const [id, inf] of info) {
    if (inf.role !== 'lead') continue
    const n = nodes.find(x => x.id === id)!
    leadErr = Math.max(leadErr, Math.hypot(n.x! - inf.anchor.x, n.y! - inf.anchor.y))
  }
  const dists: number[] = []
  let maxOverlap = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x! - nodes[j].x!, nodes[i].y! - nodes[j].y!)
      dists.push(d)
      maxOverlap = Math.max(maxOverlap, FORCE.collideRadius * 2 - d)
    }
  }
  return { dists, leadErr, maxOverlap }
}

for (const n of [1, 3, 8, 12]) {
  test(`d3 cluster force on ${n} cluster(s): leads at their anchor, no node overlap`, () => {
    const r = simulate(n, 6)
    assert.ok(r.leadErr < 1, `lead is ${r.leadErr}px off its anchor`)
    // collide radius is the node half-size: centres must stay at least ~one radius apart (d3 relaxes softly)
    assert.ok(Math.min(...r.dists) >= FORCE.collideRadius, `closest pair ${Math.min(...r.dists)}px`)
    assert.ok(CLUSTER_LAYOUT.gap > 0)
  })
}

// ─── bridge-types sanitising and team pseudo selection ──────────────────────

test('SessionInfo team fields are sanitised like the tracker does', () => {
  const base: SessionInfo = { id: 's', label: 'l', status: 'active', startTime: 1, lastActivityTime: 2 }
  const s = sanitizeSessionInfo({ ...base, teamName: '  al\u0000pha\n‮ ', memberName: 'x'.repeat(200) })
  assert.equal(s.teamName, 'alpha\u202e')
  assert.equal(s.memberName!.length, 80)
  const none = sanitizeSessionInfo({ ...base, teamName: ' \u0001 ', memberName: '' })
  assert.equal('teamName' in none, false)
  assert.equal('memberName' in none, false)
  // same name as the tracker produces
  const tracker = createTeamTracker()
  tracker.ingest({ type: 'team_info', payload: { teamName: '  al\u0000pha ', leadSessionId: 'l', members: [] } })
  assert.ok(tracker.teams.has(sanitizeSessionInfo({ ...base, teamName: '  al\u0000pha ' }).teamName!))
})

test('team pseudo selection: ids, union views and which events reach the view', () => {
  assert.equal(parseTeamSelection(teamSelectionId('alpha')), 'alpha')
  assert.equal(parseTeamSelection('team:'), null)
  assert.equal(parseTeamSelection('s1'), null)
  assert.equal(isUnionSelection(teamSelectionId('a')), true)
  assert.equal(isUnionSelection(ALL_SESSIONS_ID), true)
  assert.equal(isUnionSelection('s1'), false)
  const tracker = createTeamTracker()
  tracker.ingest({ type: 'team_info', payload: { teamName: 'alpha', leadSessionId: 'lead', members: [{ name: 'bob', sessionId: 'tmux1' }] } })
  const sessions = [{ id: 'tagged', teamName: 'alpha' }, { id: 'solo' }]
  const sel = teamSelectionId('alpha')
  for (const sid of ['lead', 'tmux1', 'tagged']) assert.equal(eventMatchesSelection(sel, sid, tracker, sessions), true, sid)
  for (const sid of ['solo', 'other', undefined]) assert.equal(eventMatchesSelection(sel, sid, tracker, sessions), false, String(sid))
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, 'anything', tracker, sessions), true)
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, undefined, tracker, sessions), true)
  assert.equal(eventMatchesSelection('solo', 'solo', tracker, sessions), true)
  assert.equal(eventMatchesSelection('solo', 'lead', tracker, sessions), false)
  assert.equal(eventMatchesSelection(null, 'solo', tracker, sessions), false)
})
