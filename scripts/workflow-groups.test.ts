// Workflow groups (#79): a Workflow-tool run is displayed through the team machinery with
// teamKind 'workflow'. Wording, sanitising, grouping, activity and halo rules. Synthetic data only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatTeamSummary } from '../web/lib/chrome-utils'
import { groupNoun, groupHeading, memberNoun, normalizeGroupKind } from '../web/lib/ui-glossary'
import {
  sanitizeTeamInfo, parseTeammateExtras, createTeamTracker, isGroupActive, MAX_PHASE_LEN, type GroupSummary,
} from '../web/hooks/simulation/team-info'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { activeSessionIds } from '../web/hooks/simulation/session-visibility'
import { filterActiveTeams, selectionLabel } from '../web/lib/session-tree'
import { visibleAgents } from '../web/lib/inactive-agents'
import { teamChipGroups } from '../web/lib/feed-utils'
import {
  computeClusters, clusterLabelLines, clusterAnnouncement, clusterNoun, haloAlphas, isFinishedWorkflow,
} from '../web/components/agent-visualizer/canvas/cluster-model'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import type { SimulationEvent } from '../web/lib/agent-types'
import { WORKFLOW_PHASE_MAX } from '../extension/src/constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent({ time: 1, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: 1 }, ctx)
  return state
}
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
const wf = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  agent({ id, name: id.split(':')[1], kind: 'teammate', teamName: name, teamKind: 'workflow', activity: 'working', state: 'thinking', ...extra })

// ─── Wording ────────────────────────────────────────────────────────────────

test('formatTeamSummary: wording table (kind x counts)', () => {
  const table: Array<[string | undefined, number, number, string]> = [
    [undefined, 1, 0, 'Team x: 1 member, 0 working'],
    ['team', 3, 2, 'Team x: 3 members, 2 working'],
    ['workflow', 1, 1, 'Workflow x: 1 agent, 1 working'],
    ['workflow', 0, 0, 'Workflow x: 0 agents, 0 working'],
    ['workflow', 5, 3, 'Workflow x: 5 agents, 3 working'],
    ['bogus', 2, 1, 'Team x: 2 members, 1 working'],
  ]
  for (const [kind, n, w, expected] of table) assert.equal(formatTeamSummary('x', n, w, kind as any), expected)
})

test('glossary: unknown kinds fall back to team, workflow vocabulary', () => {
  assert.equal(normalizeGroupKind('workflow'), 'workflow')
  for (const v of [undefined, null, 'Workflow', 'wf', 3, {}]) assert.equal(normalizeGroupKind(v), 'team')
  assert.equal(groupNoun('workflow'), 'Workflow')
  assert.equal(groupHeading('workflow', 'tempo'), 'Workflow tempo')
  assert.equal(memberNoun('workflow', 2), 'agents')
  assert.equal(memberNoun('team', 2), 'members')
})

// ─── Sanitising ─────────────────────────────────────────────────────────────

test('team_info: teamKind workflow is kept, anything else becomes a team; phase is cleaned and capped', () => {
  const info = sanitizeTeamInfo({
    teamName: 'tempo-wave-a', leadSessionId: 'L', teamKind: 'workflow',
    members: [{ name: 'impl:a', agentType: 'workflow-subagent', phase: 'Impl\u0000ement' + 'x'.repeat(100) }],
  })!
  assert.equal(info.kind, 'workflow')
  assert.ok(info.members[0].phase!.length <= MAX_PHASE_LEN)
  assert.ok(!/\u0000/.test(info.members[0].phase!))
  for (const bad of ['team', 'WORKFLOW', 7, null, { x: 1 }]) {
    assert.equal(sanitizeTeamInfo({ teamName: 'a', leadSessionId: 'L', teamKind: bad, members: [] })!.kind, undefined)
  }
})

test('agent_spawn extras: teamKind survives only as workflow', () => {
  assert.equal(parseTeammateExtras({ kind: 'teammate', teamName: 'w', teamKind: 'workflow' })!.teamKind, 'workflow')
  assert.equal(parseTeammateExtras({ kind: 'teammate', teamName: 'w', teamKind: 'evil' })!.teamKind, undefined)
  assert.equal(parseTeammateExtras({ kind: 'teammate', teamName: 'w' })!.teamKind, undefined)
})

// ─── Events -> state ────────────────────────────────────────────────────────

test('workflow agents are teammates carrying teamKind, stay visible when idle, and a team_info marks the group', () => {
  const s = run([
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'impl:a', kind: 'teammate', teamName: 'tempo-wave-a', teamKind: 'workflow', agentType: 'workflow-subagent', parent: 'orch' } },
    { sessionId: 'S', type: 'team_info', payload: { teamName: 'tempo-wave-a', teamKind: 'workflow', leadSessionId: 'S', members: [{ name: 'impl:a', phase: 'Implement' }] } },
    { sessionId: 'S', type: 'agent_activity', payload: { name: 'impl:a', activity: 'idle' } },
  ])
  const a = s.agents.get('S:impl:a')!
  assert.equal(a.kind, 'teammate')
  assert.equal(a.teamKind, 'workflow')
  assert.equal(a.activity, 'idle')
  assert.equal(a.archived ?? false, false)
  assert.equal(s.teams.get('tempo-wave-a')!.kind, 'workflow')
})

test('tracker: a workflow spawn without team_info already makes a workflow group; counts feed isGroupActive', () => {
  const t = createTeamTracker()
  const spawn = (n: string) => t.ingest({ type: 'agent_spawn', sessionId: 'S', payload: { name: n, kind: 'teammate', teamName: 'w1', teamKind: 'workflow' } })
  spawn('a'); spawn('b')
  assert.equal(t.teams.get('w1')!.kind, 'workflow')
  assert.equal(t.memberCount('w1'), 2)
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), true)
  t.ingest({ type: 'agent_activity', sessionId: 'S', payload: { name: 'a', activity: 'done' } })
  t.ingest({ type: 'agent_activity', sessionId: 'S', payload: { name: 'b', activity: 'done' } })
  assert.equal(t.working('w1'), 0)
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), false)
  // team_info replaces the summary: its kind comes from its own payload
  t.ingest({ type: 'team_info', sessionId: 'S', payload: { teamName: 'w1', teamKind: 'workflow', leadSessionId: 'S', members: [] } })
  assert.equal(t.teams.get('w1')!.kind, 'workflow')
})

// ─── Activity / finished logic ──────────────────────────────────────────────

test('isGroupActive: only a working member keeps a group without summary active', () => {
  assert.equal(isGroupActive(undefined, undefined), false)
  assert.equal(isGroupActive(undefined, 0), false)
  assert.equal(isGroupActive(undefined, 2), true)
})

test('a finished workflow (no member working) does not keep its sessions or its row in the active view', () => {
  const sessions = [{ id: 'S', label: 'orch', status: 'completed' as const, startTime: 0, lastActivityTime: 0 }]
  const input = (working: number) => ({
    sessions, now: 100 * 60_000, teamSessions: new Map([['w1', new Set(['S'])]]), teamWorking: new Map([['w1', working]]),
  })
  assert.equal(activeSessionIds(input(0)).has('S'), false)
  assert.equal(activeSessionIds(input(3)).has('S'), true)
  assert.deepEqual(filterActiveTeams(['w1'], [], new Map([['w1', 0]])), [])
  assert.deepEqual(filterActiveTeams(['w1'], [], new Map([['w1', 1]])), ['w1'])
})

// ─── Clusters, halos, outline ───────────────────────────────────────────────

test('workflow cluster: kind team + teamKind workflow, label, announcement and noun say Workflow', () => {
  const agents = map(
    agent({ id: 'S:orch', sessionId: 'S', isMain: true, name: 'orch' }),
    wf('S:impl:a', 'tempo-wave-a', { sessionId: 'S', x: 50 }),
    wf('S:impl:b', 'tempo-wave-a', { sessionId: 'S', x: 90 }),
  )
  const clusters = computeClusters(agents.values())
  const c = clusters.find(x => x.kind === 'team')!
  assert.equal(c.teamKind, 'workflow')
  assert.equal(clusterNoun(c), 'Workflow')
  assert.match(clusterLabelLines(c).title, /^Workflow tempo-wave-a \(\d+\)$/)
  assert.match(clusterAnnouncement(c), /^Workflow tempo-wave-a, /)
  // A plain team keeps its wording
  const plain = computeClusters(map(agent({ id: 's1:l', isMain: true }), agent({ id: 's1:t', kind: 'teammate', teamName: 'alpha' })).values())
  assert.equal(clusterLabelLines(plain.find(x => x.kind === 'team')!).title.startsWith('Team alpha'), true)
})

test('the workflow kind also comes from the team summary', () => {
  const agents = map(
    agent({ id: 'S:a', sessionId: 'S', kind: 'teammate', teamName: 'w9' }),
    agent({ id: 'S:b', sessionId: 'S', kind: 'teammate', teamName: 'w9', x: 40 }),
  )
  const teams = new Map([['w9', { name: 'w9', leadSessionId: 'S', kind: 'workflow' as const, members: [] }]])
  assert.equal(computeClusters(agents.values(), teams).find(c => c.kind === 'team')!.teamKind, 'workflow')
})

test('same workflow name in two sessions, and two workflows in one session, stay distinct groups', () => {
  const sameName = map(
    wf('S1:a', 'tempo', { sessionId: 'S1' }), wf('S1:b', 'tempo', { sessionId: 'S1', x: 40 }),
    wf('S2:a', 'tempo', { sessionId: 'S2', x: 900 }), wf('S2:b', 'tempo', { sessionId: 'S2', x: 940 }),
  )
  const clusters = computeClusters(sameName.values()).filter(c => c.kind === 'team')
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters.map(c => c.key).sort(), ['team:S1:tempo', 'team:S2:tempo'])

  const twoInOne = map(
    wf('S:a', 'wave-a', { sessionId: 'S' }), wf('S:b', 'wave-a', { sessionId: 'S', x: 40 }),
    wf('S:c', 'wave-b', { sessionId: 'S', x: 600 }), wf('S:d', 'wave-b', { sessionId: 'S', x: 640 }),
  )
  const two = computeClusters(twoInOne.values()).filter(c => c.kind === 'team')
  assert.deepEqual(two.map(c => c.title).sort(), ['wave-a', 'wave-b'])
  assert.ok(two.every(c => c.memberIds.length === 2))
})

test('finished workflow halos are drawn reduced; live workflows and finished teams are not', () => {
  const done = (id: string, name: string, kind: 'workflow' | 'team') =>
    agent({ id, sessionId: 'S', kind: 'teammate', teamName: name, teamKind: kind, state: 'complete', activity: 'done', archived: true, opacity: 0.55, x: id.length * 10 })
  const finished = computeClusters(map(done('S:a', 'w', 'workflow'), done('S:bb', 'w', 'workflow')).values()).find(c => c.kind === 'team')!
  assert.equal(finished.status, 'complete')
  assert.equal(isFinishedWorkflow(finished), true)
  const live = computeClusters(map(wf('S:a', 'w'), wf('S:b', 'w', { x: 40 })).values()).find(c => c.kind === 'team')!
  const team = computeClusters(map(done('S:a', 't', 'team'), done('S:bb', 't', 'team')).values()).find(c => c.kind === 'team')!
  assert.equal(isFinishedWorkflow(live), false)
  assert.equal(isFinishedWorkflow(team), false)
  assert.notDeepEqual(haloAlphas(finished, false), haloAlphas(live, false))
  assert.deepEqual(haloAlphas(team, false), haloAlphas(live, false))
  // Reduced means fainter on both fill and outline
  assert.ok(parseInt(haloAlphas(finished, false).stroke, 16) < parseInt(haloAlphas(live, false).stroke, 16))
  assert.ok(parseInt(haloAlphas(finished, false).fill, 16) < parseInt(haloAlphas(live, false).fill, 16))
})

test('outline model: workflow group text starts with Workflow and lists every agent with its state', () => {
  const agents = map(
    agent({ id: 'S:orch', sessionId: 'S', isMain: true, name: 'orch' }),
    wf('S:impl:a', 'tempo-wave-a', { sessionId: 'S', x: 50, name: 'impl:a', activity: 'working' }),
    wf('S:impl:b', 'tempo-wave-a', { sessionId: 'S', x: 90, name: 'impl:b', activity: 'idle', state: 'idle' }),
    wf('S:impl:c', 'tempo-wave-a', { sessionId: 'S', x: 130, name: 'impl:c', activity: 'done', state: 'complete', archived: true }),
  )
  const model = buildA11yModel(agents, new Map(), [], new Map(), {})
  const team = model.teams.find(t => t.teamKind === 'workflow')!
  assert.match(team.text, /^Workflow tempo-wave-a: /)
  for (const frag of ['impl:a (working)', 'impl:b (idle)', 'impl:c (done)']) assert.ok(team.text.includes(frag), frag)
  assert.equal(model.clusters.find(c => c.kind === 'team')!.teamKind, 'workflow')
  assert.equal(model.agents.find(a => a.id === 'S:impl:a')!.teamKind, 'workflow')
})

// ─── isGroupActive: table-driven ─────────────────────────────────────────────

test('isGroupActive: working members, idle-between-calls workflows and finished groups (table)', () => {
  type Row = [string, GroupSummary | undefined, number | undefined, boolean]
  const wfSum = (members: number, done: number): GroupSummary => ({ kind: 'workflow', members, done })
  const table: Row[] = [
    ['nothing known', undefined, undefined, false],
    ['no summary, one working', undefined, 1, true],
    ['no summary, none working', undefined, 0, false],
    ['workflow, one working, others done', wfSum(5, 4), 1, true],
    ['workflow, all idle between calls, none done', wfSum(5, 0), 0, true],
    ['workflow, some done, rest idle', wfSum(5, 3), 0, true],
    ['workflow, all but one done', wfSum(5, 4), 0, true],
    ['workflow, all done, nobody working', wfSum(5, 5), 0, false],
    ['workflow, done count above members (stale)', wfSum(2, 3), 0, false],
    ['workflow, no member tracked', wfSum(0, 0), 0, false],
    ['team, all idle, none done (only working counts for Agent Teams)', { kind: undefined, members: 3, done: 0 }, 0, false],
    ['team, one working', { kind: undefined, members: 3, done: 0 }, 1, true],
    ['workflow, working is NaN', wfSum(2, 2), Number.NaN, false],
  ]
  for (const [name, summary, working, expected] of table) assert.equal(isGroupActive(summary, working), expected, name)
})

test('tracker summary feeds isGroupActive: idle workflow stays active until every agent is done', () => {
  const t = createTeamTracker()
  const spawn = (n: string) => t.ingest({ type: 'agent_spawn', sessionId: 'S', payload: { name: n, kind: 'teammate', teamName: 'w1', teamKind: 'workflow' } })
  const act = (n: string, a: string) => t.ingest({ type: 'agent_activity', sessionId: 'S', payload: { name: n, activity: a } })
  spawn('a'); spawn('b')
  assert.deepEqual(t.summary('w1'), { kind: 'workflow', members: 2, done: 0 })
  act('a', 'idle'); act('b', 'idle')
  assert.equal(t.working('w1'), 0)
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), true, 'idle between calls')
  act('a', 'done')
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), true, 'one agent still idle')
  act('b', 'done')
  assert.deepEqual(t.summary('w1'), { kind: 'workflow', members: 2, done: 2 })
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), false, 'all done')
  act('b', 'working')
  assert.equal(t.summary('w1').done, 1, 'a revived agent is no longer done')
  assert.equal(isGroupActive(t.summary('w1'), t.working('w1')), true)
})

// ─── session-visibility: both branches ───────────────────────────────────────

test('activeSessionIds: a team tagged on the session itself keeps it active (second branch, no teamSessions)', () => {
  const sessions = [{ id: 'S', label: 'orch', status: 'completed' as const, startTime: 0, lastActivityTime: 0, teamName: 'w1' }]
  const base = { sessions, now: 100 * 60_000 }
  assert.equal(activeSessionIds({ ...base, teamWorking: new Map([['w1', 2]]) }).has('S'), true)
  assert.equal(activeSessionIds({ ...base, teamWorking: new Map([['w1', 0]]) }).has('S'), false)
  // an idle workflow (not all done) also keeps its tagged session
  const idle = new Map<string, GroupSummary>([['w1', { kind: 'workflow', members: 3, done: 1 }]])
  assert.equal(activeSessionIds({ ...base, teamWorking: new Map([['w1', 0]]), teamSummaries: idle }).has('S'), true)
  const finished = new Map<string, GroupSummary>([['w1', { kind: 'workflow', members: 3, done: 3 }]])
  assert.equal(activeSessionIds({ ...base, teamWorking: new Map([['w1', 0]]), teamSummaries: finished }).has('S'), false)
  // another team's activity does not leak to this session
  assert.equal(activeSessionIds({ ...base, teamWorking: new Map([['other', 5]]) }).has('S'), false)
})

test('activeSessionIds: sessions of an active workflow (teamSessions branch) with an idle-between-calls summary', () => {
  const sessions = [{ id: 'S', label: 'orch', status: 'completed' as const, startTime: 0, lastActivityTime: 0 }]
  const input = (summary: GroupSummary) => ({
    sessions, now: 100 * 60_000, teamSessions: new Map([['w1', new Set(['S'])]]), teamWorking: new Map([['w1', 0]]),
    teamSummaries: new Map([['w1', summary]]),
  })
  assert.equal(activeSessionIds(input({ kind: 'workflow', members: 2, done: 0 })).has('S'), true)
  assert.equal(activeSessionIds(input({ kind: 'workflow', members: 2, done: 2 })).has('S'), false)
})

test('filterActiveTeams: an idle workflow row stays in the active view, a finished one folds away', () => {
  const sums = new Map<string, GroupSummary>([
    ['idle', { kind: 'workflow', members: 2, done: 0 }], ['fin', { kind: 'workflow', members: 2, done: 2 }],
  ])
  const working = new Map([['idle', 0], ['fin', 0]])
  assert.deepEqual(filterActiveTeams(['idle', 'fin'], [], working, sums), ['idle'])
})

// ─── Hide inactive agents keeps live workflow agents ─────────────────────────

function workflowSession(sid: string, name: string): SimulationState {
  const events: Array<{ type: SimulationEvent['type']; payload: Record<string, unknown>; sessionId: string }> = [
    { sessionId: sid, type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
  ]
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    events.push({ sessionId: sid, type: 'agent_spawn', payload: { name: `impl:${n}`, kind: 'teammate', teamName: name, teamKind: 'workflow', agentType: 'workflow-subagent', parent: 'orch' } })
  }
  events.push({ sessionId: sid, type: 'team_info', payload: { teamName: name, teamKind: 'workflow', leadSessionId: sid, members: ['a', 'b', 'c', 'd', 'e'].map(n => ({ name: `impl:${n}` })) } })
  for (const n of ['a', 'b', 'c']) events.push({ sessionId: sid, type: 'agent_activity', payload: { name: `impl:${n}`, activity: 'working' } })
  events.push({ sessionId: sid, type: 'agent_activity', payload: { name: 'impl:d', activity: 'idle' } })
  events.push({ sessionId: sid, type: 'agent_activity', payload: { name: 'impl:e', activity: 'done' } })
  return run(events)
}

test('Hide inactive agents ON: a workflow with 3 working, 1 idle, 1 done agents is not drawn empty', () => {
  const s = workflowSession('S', 'tempo-wave-a')
  const shown = visibleAgents(s.agents, true)
  for (const n of ['a', 'b', 'c', 'd', 'e']) assert.ok(shown.has(`S:impl:${n}`), `impl:${n} stays visible while its workflow is active`)
  assert.ok(shown.has('S:orch'))
})

test('Hide inactive agents ON: an idle-between-calls workflow stays visible, a finished one is hidden', () => {
  const idle = run([
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'w1', kind: 'teammate', teamName: 'wf', teamKind: 'workflow', parent: 'orch' } },
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'w2', kind: 'teammate', teamName: 'wf', teamKind: 'workflow', parent: 'orch' } },
    { sessionId: 'S', type: 'agent_activity', payload: { name: 'w1', activity: 'idle' } },
    { sessionId: 'S', type: 'agent_activity', payload: { name: 'w2', activity: 'idle' } },
  ])
  assert.ok(visibleAgents(idle.agents, true).has('S:w1') && visibleAgents(idle.agents, true).has('S:w2'))
  const fin = run([
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
    { sessionId: 'S', type: 'agent_spawn', payload: { name: 'w1', kind: 'teammate', teamName: 'wf', teamKind: 'workflow', parent: 'orch' } },
    { sessionId: 'S', type: 'agent_activity', payload: { name: 'w1', activity: 'done' } },
  ])
  assert.equal(visibleAgents(fin.agents, true).has('S:w1'), false)
})

test('Hide inactive agents ON: only the active workflow of two sessions keeps its agents', () => {
  const live = workflowSession('S1', 'tempo')
  const done = run([
    { sessionId: 'S2', type: 'agent_spawn', payload: { name: 'orch', isMain: true } },
    { sessionId: 'S2', type: 'agent_spawn', payload: { name: 'x', kind: 'teammate', teamName: 'tempo', teamKind: 'workflow', parent: 'orch' } },
    { sessionId: 'S2', type: 'agent_activity', payload: { name: 'x', activity: 'done' } },
  ])
  const merged = new Map([...live.agents, ...done.agents])
  const shown = visibleAgents(merged, true)
  assert.ok(shown.has('S1:impl:d'), 'idle agent of the live workflow')
  assert.equal(shown.has('S2:x'), false, 'finished workflow of the same name in another session')
})

// ─── Two same-named workflows in two sessions, end to end ────────────────────

test('same-named workflows in two sessions stay two groups through the tracker, the team map, the counters and the chips', () => {
  const events: Array<{ type: SimulationEvent['type']; payload: Record<string, unknown>; sessionId: string }> = []
  const addWf = (sid: string, working: number, idle: number) => {
    events.push({ sessionId: sid, type: 'agent_spawn', payload: { name: 'orch', isMain: true } })
    const names = Array.from({ length: working + idle }, (_, i) => `impl:${i}`)
    for (const n of names) events.push({ sessionId: sid, type: 'agent_spawn', payload: { name: n, kind: 'teammate', teamName: 'tempo', teamKind: 'workflow', parent: 'orch' } })
    events.push({ sessionId: sid, type: 'team_info', payload: { teamName: 'tempo', teamKind: 'workflow', leadSessionId: sid, members: names.map(name => ({ name })) } })
    names.forEach((n, i) => events.push({ sessionId: sid, type: 'agent_activity', payload: { name: n, activity: i < working ? 'working' : 'idle' } }))
  }
  addWf('S1', 2, 0)
  addWf('S2', 3, 0)
  // tracker (counters, team map)
  const t = createTeamTracker()
  for (const e of events) t.ingest(e)
  const keys = [...t.teams.keys()]
  assert.equal(keys.length, 2, 'two entries in the team map')
  const byLead = new Map(keys.map(k => [t.teams.get(k)!.leadSessionId, k]))
  assert.equal(t.working(byLead.get('S1')!), 2)
  assert.equal(t.working(byLead.get('S2')!), 3)
  assert.equal(t.memberCount(byLead.get('S1')!), 2)
  assert.equal(t.memberCount(byLead.get('S2')!), 3)
  assert.deepEqual([...t.sessionsOf(byLead.get('S1')!)].sort(), ['S1'])
  const summaries = keys.map(k => formatTeamSummary(t.teams.get(k)!.name, t.memberCount(k), t.working(k), t.teams.get(k)!.kind)).sort()
  assert.deepEqual(summaries, ['Workflow tempo: 2 agents, 2 working', 'Workflow tempo: 3 agents, 3 working'])
  // simulation state (team map) and clusters
  const s = run(events)
  assert.equal(s.teams.size, 2)
  const clusters = computeClusters(s.agents.values(), s.teams).filter(c => c.kind === 'team')
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters.map(c => c.memberIds.length).sort(), [2, 3])
  // chips of the Conversation panel
  const chips = teamChipGroups([...s.agents.values()].filter(a => a.teamName), s.teams)
  assert.equal(chips.length, 2)
  assert.deepEqual(chips.map(c => c.items.length).sort(), [2, 3])
  assert.notEqual(chips[0].heading, chips[1].heading, 'the duplicate name is told apart')
  assert.ok(chips.every(c => c.heading.startsWith('Workflow tempo')))
  assert.ok(chips.some(c => c.label.endsWith(', 3 agents')) && chips.some(c => c.label.endsWith(', 2 agents')))
})

test('chips: a lone workflow reads "Workflow <name>" with an aria label, a team keeps "Team"', () => {
  const s = workflowSession('S', 'tempo-wave-a')
  const chips = teamChipGroups([...s.agents.values()].filter(a => a.teamName), s.teams)
  assert.equal(chips.length, 1)
  assert.equal(chips[0].heading, 'Workflow tempo-wave-a')
  assert.equal(chips[0].label, 'Workflow tempo-wave-a, 5 agents')
  const team = teamChipGroups([{ sessionId: 's', teamName: 'alpha' }], undefined)
  assert.equal(team[0].heading, 'Team alpha')
  assert.equal(team[0].label, 'Team alpha, 1 member')
})

test('selectionLabel names a selected workflow from the team map', () => {
  const teams = new Map([['tempo@S2', { name: 'tempo', leadSessionId: 'S2', kind: 'workflow' as const, members: [] }]])
  assert.equal(selectionLabel('team:tempo@S2', [], teams), 'Workflow tempo')
  assert.equal(selectionLabel('team:alpha', [], new Map([['alpha', { name: 'alpha', leadSessionId: 'S', members: [] }]])), 'Team alpha')
  assert.equal(selectionLabel('team:alpha', []), 'Team alpha')
})

// ─── Contract with the extension (team_info / agent_spawn of a workflow) ─────

test('contract: the web phase cap equals the extension cap, and a "#xxxx" run suffix is an ordinary distinct name', () => {
  assert.equal(MAX_PHASE_LEN, WORKFLOW_PHASE_MAX)
  const phase = sanitizeTeamInfo({ teamName: 'w', leadSessionId: 'L', teamKind: 'workflow', members: [{ name: 'a', phase: 'P'.repeat(500) }] })!.members[0].phase!
  assert.equal(phase.length, WORKFLOW_PHASE_MAX)
  // Two runs of one script in one session: 'tempo' and 'tempo #6af1' are two groups with their own counters
  const t = createTeamTracker()
  const spawn = (team: string, n: string) => t.ingest({ type: 'agent_spawn', sessionId: 'S', payload: { name: n, kind: 'teammate', teamName: team, teamKind: 'workflow' } })
  spawn('tempo', 'a'); spawn('tempo', 'b'); spawn('tempo #6af1', 'c')
  assert.equal(t.teams.size, 2)
  assert.deepEqual([...t.teams.values()].map(x => x.name).sort(), ['tempo', 'tempo #6af1'])
  assert.equal(t.memberCount('tempo'), 2)
  assert.equal(t.memberCount('tempo #6af1'), 1)
})
