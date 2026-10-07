// D8 (#36): teams are keyed per (lead session, name); layout and tracker agree on membership.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { createTeamTracker, MAX_TEAMS } from '../web/hooks/simulation/team-info'
import { teamKeyFor, findTeam, teamOfAgent, keyOfTeam, teamHaloStatus } from '../web/hooks/simulation/team-key'
import { clusterKeyOf, clustersOf, layoutInfo } from '../web/hooks/simulation/fleet-layout'
import type { SimulationEvent, TeamSummary } from '../web/lib/agent-types'

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
const lead = (sid: string): Ev => ({ type: 'agent_spawn', sessionId: sid, payload: { name: 'main', isMain: true } })
const mate = (sid: string, name: string, team: string): Ev => ({ type: 'agent_spawn', sessionId: sid, payload: { name, parent: 'main', kind: 'teammate', teamName: team } })
const teamInfo = (sid: string, team: string, members: Array<{ name: string; sessionId?: string }> = []): Ev =>
  ({ type: 'team_info', sessionId: sid, payload: { teamName: team, leadSessionId: sid, members } })

test('teamKeyFor: plain name for the first team, unique suffix for a same-named team of another lead, stable on update', () => {
  const teams = new Map<string, TeamSummary>()
  const a: TeamSummary = { name: 'alpha', leadSessionId: 'L1', members: [] }
  teams.set(teamKeyFor(teams, 'alpha', 'L1'), a)
  assert.equal(keyOfTeam(teams, a), 'alpha')
  const b: TeamSummary = { name: 'alpha', leadSessionId: 'L3', members: [] }
  const kb = teamKeyFor(teams, 'alpha', 'L3')
  assert.notEqual(kb, 'alpha')
  teams.set(kb, b)
  assert.equal(teamKeyFor(teams, 'alpha', 'L1'), 'alpha', 'existing key is reused')
  assert.equal(teamKeyFor(teams, 'alpha', 'L3'), kb)
  // a team literally named like a generated key never collides
  const evil = teamKeyFor(teams, kb, 'L9')
  assert.ok(!teams.has(evil))
})

test('same-named teams under different leads do not overwrite each other in the simulation', () => {
  const s = run([
    lead('L1'), mate('L1', 'a', 'alpha'), teamInfo('L1', 'alpha', [{ name: 'a' }]),
    lead('L3'), mate('L3', 'b', 'alpha'), teamInfo('L3', 'alpha', [{ name: 'b' }]),
  ])
  assert.equal(s.teams.size, 2)
  assert.deepEqual(Array.from(s.teams.values(), t => [t.name, t.leadSessionId]).sort(), [['alpha', 'L1'], ['alpha', 'L3']])
  // re-sending a team_info updates in place
  const again = run([teamInfo('L1', 'alpha', [{ name: 'a' }]), teamInfo('L3', 'alpha'), teamInfo('L1', 'alpha', [{ name: 'a' }, { name: 'z' }])])
  assert.equal(again.teams.size, 2)
  assert.equal(findTeam(again.teams, 'alpha', 'L1')!.members.length, 2)
  assert.equal(findTeam(again.teams, 'alpha', 'L3')!.members.length, 0)
})

test('layout cluster membership agrees with the teams for same-named teams (leads and teammates)', () => {
  const s = run([
    lead('L1'), mate('L1', 'a', 'alpha'), teamInfo('L1', 'alpha'),
    lead('L3'), mate('L3', 'b', 'alpha'), teamInfo('L3', 'alpha'),
  ])
  const key = (id: string) => s.agents.get(id)!.clusterKey
  assert.equal(key('L1:main'), 'team:L1:alpha', 'the lead is in the cluster of its own team, not of the one that overwrote it')
  assert.equal(key('L1:a'), 'team:L1:alpha')
  assert.equal(key('L3:main'), 'team:L3:alpha')
  assert.equal(key('L3:b'), 'team:L3:alpha')
  for (const a of s.agents.values()) assert.equal(a.clusterKey, clusterKeyOf(a, s.teams), `${a.id}: stamped key matches the computed one`)
  assert.deepEqual(clustersOf(s.agents.values(), s.teams).map(c => [c.key, c.size]), [['team:L1:alpha', 2], ['team:L3:alpha', 2]])
  const { info, anchors } = layoutInfo(s.agents, s.teams)
  assert.equal(anchors.size, 2)
  assert.equal(info.get('L1:main')!.role, 'lead')
  assert.equal(info.get('L3:main')!.role, 'lead')
  assert.equal(teamOfAgent(s.teams, s.agents.get('L3:b')!)!.leadSessionId, 'L3')
  assert.equal(teamOfAgent(s.teams, s.agents.get('L1:main')!)!.leadSessionId, 'L1')
})

test('a member session of a same-named team resolves to the team it belongs to', () => {
  const s = run([
    lead('L1'), teamInfo('L1', 'alpha'),
    lead('L3'), teamInfo('L3', 'alpha', [{ name: 'tm', sessionId: 'M3' }]),
    lead('M3'),
  ])
  assert.equal(s.agents.get('M3:main')!.clusterKey, 'team:L3:alpha')
  assert.equal(teamOfAgent(s.teams, { sessionId: 'M3' })!.leadSessionId, 'L3')
  assert.equal(teamOfAgent(s.teams, { sessionId: 'nobody' }), undefined)
})

test('MAX_TEAMS still bounds the simulation teams, counting same-named teams separately', () => {
  const evs: Ev[] = []
  for (let i = 0; i < MAX_TEAMS + 5; i++) evs.push(teamInfo(`L${i}`, 'same'))
  assert.equal(run(evs).teams.size, MAX_TEAMS)
})

test('tracker: same-named teams of different lead sessions keep separate sessions, members and working counts', () => {
  const t = createTeamTracker()
  t.ingest({ type: 'team_info', sessionId: 'L1', payload: { teamName: 'alpha', leadSessionId: 'L1', members: [{ name: 'a', sessionId: 'M1' }] } })
  t.ingest({ type: 'agent_spawn', sessionId: 'L1', payload: { name: 'a', kind: 'teammate', teamName: 'alpha' } })
  t.ingest({ type: 'team_info', sessionId: 'L3', payload: { teamName: 'alpha', leadSessionId: 'L3', members: [] } })
  t.ingest({ type: 'agent_spawn', sessionId: 'L3', payload: { name: 'b', kind: 'teammate', teamName: 'alpha' } })
  t.ingest({ type: 'agent_spawn', sessionId: 'L3', payload: { name: 'c', kind: 'teammate', teamName: 'alpha' } })
  assert.equal(t.teams.size, 2)
  const keyOfLead = (sid: string) => Array.from(t.teams).find(([, tm]) => tm.leadSessionId === sid)![0]
  const k1 = keyOfLead('L1'), k3 = keyOfLead('L3')
  assert.notEqual(k1, k3)
  assert.deepEqual([...t.sessionsOf(k1)].sort(), ['L1', 'M1'])
  assert.deepEqual([...t.sessionsOf(k3)], ['L3'])
  assert.equal(t.working(k1), 1)
  assert.equal(t.working(k3), 2)
  t.ingest({ type: 'agent_activity', sessionId: 'L3', payload: { name: 'b', activity: 'idle' } })
  assert.equal(t.working(k3), 1)
  assert.equal(t.working(k1), 1, 'the other team is untouched')
  assert.equal(t.memberCount(k3), 2)
  // a plain name still addresses the first team of that name (tabs select by name)
  assert.equal(t.teams.get('alpha')!.leadSessionId, 'L1')
  assert.equal(t.working('alpha'), 1)
})

test('tracker: a teammate spawn before its team_info creates a provisional team that the team_info adopts', () => {
  const t = createTeamTracker()
  t.ingest({ type: 'agent_spawn', sessionId: 'L', payload: { name: 'a', kind: 'teammate', teamName: 'alpha', memberSessionId: 'M' } })
  assert.equal(t.teams.size, 1)
  t.ingest({ type: 'team_info', sessionId: 'L', payload: { teamName: 'alpha', leadSessionId: 'L', members: [{ name: 'a', sessionId: 'M' }] } })
  assert.equal(t.teams.size, 1, 'no duplicate team')
  assert.equal(t.working('alpha'), 1)
  assert.equal(t.teams.get('alpha')!.members.length, 1)
  // a team_info that names another lead (the spawn was seen in a member session) still adopts it
  const u = createTeamTracker()
  u.ingest({ type: 'agent_spawn', sessionId: 'M', payload: { name: 'a', kind: 'teammate', teamName: 'beta' } })
  u.ingest({ type: 'team_info', sessionId: 'M', payload: { teamName: 'beta', leadSessionId: 'REALLEAD', members: [] } })
  assert.equal(u.teams.size, 1)
  assert.equal(u.teams.get('beta')!.leadSessionId, 'REALLEAD')
})

test('tracker: a spawn of the same team name in an unrelated session is a separate team', () => {
  const t = createTeamTracker()
  t.ingest({ type: 'team_info', sessionId: 'L1', payload: { teamName: 'alpha', leadSessionId: 'L1', members: [] } })
  t.ingest({ type: 'agent_spawn', sessionId: 'X', payload: { name: 'a', kind: 'teammate', teamName: 'alpha' } })
  assert.equal(t.teams.size, 2)
})

test('teamHaloStatus: working when any teammate is working, even when its agent state is idle', () => {
  assert.equal(teamHaloStatus([]), 'idle')
  assert.equal(teamHaloStatus([{ state: 'idle' }, { state: 'idle', activity: 'idle' }]), 'idle')
  assert.equal(teamHaloStatus([{ state: 'idle' }, { state: 'idle', activity: 'working' }]), 'working')
  assert.equal(teamHaloStatus([{ state: 'complete', activity: 'working' }]), 'complete', 'a finished agent is not working')
  assert.equal(teamHaloStatus([{ state: 'tool_calling' }, { state: 'idle' }]), 'working')
  assert.equal(teamHaloStatus([{ state: 'complete' }, { state: 'complete', activity: 'done' }]), 'complete')
  assert.equal(teamHaloStatus([{ state: 'waiting_permission' }, { state: 'thinking' }]), 'waiting')
  assert.equal(teamHaloStatus([{ state: 'error' }, { state: 'waiting_permission' }]), 'error')
})
