import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { snapVisualState } from '../web/hooks/simulation/snap-visual-state'
import { archivedToEvict, MAX_ARCHIVED_PER_SESSION, ARCHIVED_OPACITY } from '../web/hooks/simulation/archive'
import {
  sanitizeTeamInfo, parseTeammateExtras, sanitizeColor, createTeamTracker, teamSessionIds, MAX_TEAM_MEMBERS,
} from '../web/hooks/simulation/team-info'
import { effectiveSpeed, computeSessionOffsets, applySessionOffsets, stampEventTimes } from '../web/hooks/simulation/stamp-time'
import { buildTabModel, formatTeamSummary, runtimeBadge, formatAgentCounts } from '../web/lib/chrome-utils'
import { teamSelectionId, parseTeamSelection, isUnionSelection, ALL_SESSIONS_ID, isSessionInfo } from '../web/lib/bridge-types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string; time?: number }>, start = createEmptyState()): SimulationState {
  let state = start
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const frameOptions = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

// ─── team_info / teammate spawn ─────────────────────────────────────────────

test('team_info is stored sanitised: control chars, caps, colors, member limit', () => {
  const members = Array.from({ length: MAX_TEAM_MEMBERS + 20 }, (_, i) => ({ name: `m${i}`, color: i === 0 ? 'red' : '#aabbcc' }))
  const s = run([{ type: 'team_info', payload: { teamName: 'alpha\u0000\n', leadSessionId: 'L', members: [{ name: 'a\u001b[31m', color: 'url(x)' }, 42, null, { name: '' }, ...members] } }])
  const team = s.teams.get('alpha')!
  assert.ok(team)
  assert.equal(team.members[0].name, 'a[31m')
  assert.equal(team.members[0].color, undefined)
  assert.ok(team.members.length <= MAX_TEAM_MEMBERS && team.members.length > 90)
  assert.equal(sanitizeTeamInfo({ members: [] }), null)
  assert.equal(sanitizeTeamInfo({ teamName: 5 }), null)
})

test('sanitizeColor accepts only #rrggbb', () => {
  assert.equal(sanitizeColor('#A1b2C3'), '#A1b2C3')
  for (const bad of ['#abc', 'red', '#12345g', 'javascript:1', '#aabbccdd', 5, undefined, '#aabbcc;x']) assert.equal(sanitizeColor(bad), undefined)
})

test('agent_spawn with teammate extras sets kind, team, color, type and backend', () => {
  const s = run([
    { sessionId: 'L', type: 'agent_spawn', payload: { name: 'lead', isMain: true } },
    { sessionId: 'L', type: 'agent_spawn', payload: { name: 'reviewer', parent: 'lead', kind: 'teammate', teamName: 'alpha', color: '#112233', agentType: 'general-purpose', backendType: 'in-process' } },
    { sessionId: 'L', type: 'agent_spawn', payload: { name: 'evil', parent: 'lead', kind: 'teammate', teamName: 'alpha', color: 'expression(1)' } },
    { sessionId: 'L', type: 'agent_spawn', payload: { name: 'plain', parent: 'lead' } },
  ])
  const r = s.agents.get(agentKeyOf('L', 'reviewer'))!
  assert.equal(r.kind, 'teammate')
  assert.equal(r.teamName, 'alpha')
  assert.equal(r.teamColor, '#112233')
  assert.equal(r.agentType, 'general-purpose')
  assert.equal(r.backend, 'in-process')
  assert.equal(r.activity, 'working')
  assert.equal(s.agents.get(agentKeyOf('L', 'evil'))!.teamColor, undefined)
  assert.equal(s.agents.get(agentKeyOf('L', 'plain'))!.kind, undefined)
  assert.equal(parseTeammateExtras({ kind: 'subagent', teamName: 'x' }), null)
  assert.equal(parseTeammateExtras({ kind: 'teammate' }), null)
})

test('agent_activity sets the activity; idle teammates stay and unknown values are ignored', () => {
  const base = [{ sessionId: 'L', type: 'agent_spawn' as const, payload: { name: 'bob', kind: 'teammate', teamName: 't' } }]
  let s = run([...base, { sessionId: 'L', type: 'agent_activity', payload: { name: 'bob', activity: 'idle' } }])
  assert.equal(s.agents.get('L:bob')!.activity, 'idle')
  assert.equal(s.agents.get('L:bob')!.archived, undefined)
  s = run([{ sessionId: 'L', type: 'agent_activity', payload: { name: 'bob', activity: 'dancing' } }, { sessionId: 'L', type: 'agent_activity', payload: { name: 'ghost', activity: 'idle' } }], s)
  assert.equal(s.agents.get('L:bob')!.activity, 'idle')
  assert.equal(s.agents.size, 1)
})

test('agent_activity done archives the teammate (kept, complete)', () => {
  const s = run([
    { sessionId: 'L', type: 'agent_spawn', payload: { name: 'bob', kind: 'teammate', teamName: 't' } },
    { sessionId: 'L', type: 'agent_activity', payload: { name: 'bob', activity: 'done' } },
  ])
  const bob = s.agents.get('L:bob')!
  assert.equal(bob.state, 'complete')
  assert.equal(bob.archived, true)
  assert.equal(bob.activity, 'done')
})

// ─── archived agents (#40) ──────────────────────────────────────────────────

test('a completed agent is archived and survives the fade-out cleanup', () => {
  let s = run([
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'message', payload: { agent: 'worker', role: 'assistant', content: 'result text' } },
    { type: 'agent_complete', payload: { name: 'worker' } },
  ])
  const key = agentKeyOf('default', 'worker')
  assert.equal(s.agents.get(key)!.archived, true)
  for (let i = 0; i < 400; i++) s = computeNextFrame(s, 0.1, s.currentTime + 0.1, 100, s, frameOptions)
  const w = s.agents.get(key)
  assert.ok(w, 'archived agent must not be removed by the animation loop')
  assert.ok(Math.abs(w.opacity - ARCHIVED_OPACITY) < 1e-9)
  assert.equal(s.conversations.get(key)!.length, 1)
  assert.ok(s.edges.some(e => e.to === key), 'edge to the archived agent is kept')
})

test('a non-archived completed sub-agent is still removed once faded (legacy rule)', () => {
  let s = run([
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
  ])
  const key = agentKeyOf('default', 'worker')
  s.agents.set(key, { ...s.agents.get(key)!, state: 'complete' })
  for (let i = 0; i < 400; i++) s = computeNextFrame(s, 0.1, s.currentTime + 0.1, 100, s, frameOptions)
  assert.equal(s.agents.has(key), false)
})

test('seek keeps archived agents at reduced opacity', () => {
  const s = run([
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'agent_complete', payload: { name: 'worker' } },
  ])
  const snapped = snapVisualState(s, 5)
  assert.equal(snapped.agents.get(agentKeyOf('default', 'worker'))!.opacity, ARCHIVED_OPACITY)
})

test('archived agents are capped per session, oldest evicted with their data', () => {
  const events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string; time?: number }> = [
    { sessionId: 's', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 'other', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 'other', type: 'agent_spawn', payload: { name: 'keep', parent: 'orchestrator' } },
    { sessionId: 'other', type: 'agent_complete', payload: { name: 'keep' }, time: 1 },
  ]
  const total = MAX_ARCHIVED_PER_SESSION + 5
  for (let i = 0; i < total; i++) {
    events.push({ sessionId: 's', type: 'agent_spawn', payload: { name: `w${i}`, parent: 'orchestrator' }, time: i + 1 })
    events.push({ sessionId: 's', type: 'agent_complete', payload: { name: `w${i}` }, time: i + 1 })
  }
  const s = run(events)
  const archived = Array.from(s.agents.values()).filter(a => a.archived && a.sessionId === 's')
  assert.equal(archived.length, MAX_ARCHIVED_PER_SESSION)
  assert.equal(s.agents.has('s:w0'), false)
  assert.equal(s.conversations.has('s:w0'), false)
  assert.equal(s.timelineEntries.has('s:w0'), false)
  assert.ok(s.agents.has(`s:w${total - 1}`))
  assert.ok(s.agents.has('other:keep'), 'other sessions are not evicted')
  assert.ok(!s.edges.some(e => e.to === 's:w0'))
  assert.deepEqual(archivedToEvict(s.agents.values(), 's'), [])
})

test('a returning agent (spawn again) is un-archived', () => {
  const s = run([
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'w', parent: 'orchestrator' } },
    { type: 'agent_complete', payload: { name: 'w' } },
    { type: 'agent_spawn', payload: { name: 'w', parent: 'orchestrator' } },
  ])
  const w = s.agents.get('default:w')!
  assert.equal(w.archived, false)
  assert.equal(w.state, 'idle')
  assert.equal(w.completeTime, undefined)
})

test('top bar counts archived agents as done', () => {
  assert.equal(formatAgentCounts(2, 3), '5 agents: 2 active - 3 done')
})

// ─── speed outside review (#31) ─────────────────────────────────────────────

test('speed only applies while reviewing', () => {
  assert.equal(effectiveSpeed(4, true), 4)
  assert.equal(effectiveSpeed(4, false), 1)
  assert.equal(effectiveSpeed(0.5, false), 1)
  assert.equal(effectiveSpeed(NaN, true), 1)
  assert.equal(effectiveSpeed(-2, true), 1)
})

test('particles animate at the effective speed, not the stored one', () => {
  const particle = { id: 'p', edgeId: 'e', progress: 0, type: 'dispatch', label: '', color: '#fff', size: 1 } as unknown as SimulationState['particles'][number]
  const base = { ...createEmptyState({ speed: 4 }), particles: [particle] }
  const live = computeNextFrame(base, 0.05, 0.05, 1, base, { ...frameOptions, speed: effectiveSpeed(base.speed, false) })
  const review = computeNextFrame(base, 0.05, 0.05, 1, base, { ...frameOptions, speed: effectiveSpeed(base.speed, true) })
  assert.ok(live.particles[0].progress < review.particles[0].progress)
})

// ─── union time offsets (#31/#36) ───────────────────────────────────────────

test('session offsets put sessions on one wall-clock axis', () => {
  const offsets = computeSessionOffsets([{ id: 'old', startTime: 10_000 }, { id: 'young', startTime: 70_000 }, { id: 'bad', startTime: 0 }])
  assert.equal(offsets.get('old'), 0)
  assert.equal(offsets.get('young'), 60)
  assert.equal(offsets.has('bad'), false)
  assert.equal(computeSessionOffsets([]).size, 0)
})

test('a younger session no longer collapses onto the older timeline', () => {
  const offsets = computeSessionOffsets([{ id: 'old', startTime: 0 + 1000 }, { id: 'young', startTime: 1000 + 60_000 }])
  const events = [
    { time: 100, sessionId: 'old' },
    { time: 2, sessionId: 'young' },
    { time: 0, sessionId: 'young' },
    { time: 5 },
  ]
  const shifted = applySessionOffsets(events, offsets)
  assert.deepEqual(shifted.map(e => e.time), [100, 62, 0, 5])
  // without offsets the younger event would be clamped to 100; with them it lands at 62 before the clamp
  const stamped = stampEventTimes(applySessionOffsets([{ time: 50, sessionId: 'old' }, { time: 2, sessionId: 'young' }], offsets), 0, 1)
  assert.deepEqual(stamped.map(e => e.time), [50, 62])
  assert.deepEqual(applySessionOffsets(events, undefined).map(e => e.time), [100, 2, 0, 5])
})

// ─── tabs, team selection, tracker ──────────────────────────────────────────

test('team pseudo selection ids round-trip', () => {
  assert.equal(parseTeamSelection(teamSelectionId('alpha')), 'alpha')
  assert.equal(parseTeamSelection('team:'), null)
  assert.equal(parseTeamSelection(ALL_SESSIONS_ID), null)
  assert.equal(parseTeamSelection(null), null)
  assert.equal(isUnionSelection(teamSelectionId('x')), true)
  assert.equal(isUnionSelection(ALL_SESSIONS_ID), true)
  assert.equal(isUnionSelection('abc'), false)
})

test('buildTabModel: All, then teams with their member sessions, then plain sessions', () => {
  const sessions = [{ id: 's1' }, { id: 'm1', teamName: 'alpha' }, { id: 's2' }, { id: 'm2', teamName: 'alpha' }, { id: 'o1', teamName: 'beta' }]
  const tabs = buildTabModel(sessions, ['alpha'])
  assert.deepEqual(tabs.map(t => t.id), [ALL_SESSIONS_ID, 'team:alpha', 'm1', 'm2', 'team:beta', 'o1', 's1', 's2'])
  assert.deepEqual(tabs.map(t => t.kind), ['all', 'team', 'session', 'session', 'team', 'session', 'session', 'session'])
  assert.deepEqual(buildTabModel([{ id: 'a' }], []).map(t => t.id), [ALL_SESSIONS_ID, 'a'])
  assert.deepEqual(buildTabModel([], ['t']).map(t => t.id), [ALL_SESSIONS_ID, 'team:t'])
})

test('formatTeamSummary and runtimeBadge', () => {
  assert.equal(formatTeamSummary('X', 3, 2), 'Team X: 3 members, 2 working')
  assert.equal(formatTeamSummary('X', 1, 0), 'Team X: 1 member, 0 working')
  assert.deepEqual(runtimeBadge('codex'), { short: 'CX', label: 'Codex' })
  assert.deepEqual(runtimeBadge('copilot'), { short: 'GC', label: 'GitHub Copilot' })
  assert.equal(runtimeBadge('claude')!.label, 'Claude Code')
  assert.equal(runtimeBadge(undefined), null)
})

test('SessionInfo accepts optional teamName / memberName and rejects bad types', () => {
  const base = { id: 'a', label: 'l', status: 'active', startTime: 1, lastActivityTime: 2 }
  assert.equal(isSessionInfo({ ...base, teamName: 't', memberName: 'm' }), true)
  assert.equal(isSessionInfo(base), true)
  assert.equal(isSessionInfo({ ...base, teamName: 5 }), false)
  assert.equal(isSessionInfo({ ...base, memberName: {} }), false)
})

test('team tracker follows teams, sessions, members and working counts across sessions', () => {
  const t = createTeamTracker()
  assert.equal(t.ingest({ type: 'team_info', sessionId: 'L', payload: { teamName: 'alpha', leadSessionId: 'L', members: [{ name: 'a', sessionId: 'M1' }, { name: 'b' }] } }), true)
  assert.equal(t.ingest({ type: 'agent_spawn', sessionId: 'L', payload: { name: 'a', kind: 'teammate', teamName: 'alpha' } }), true)
  assert.equal(t.ingest({ type: 'agent_spawn', sessionId: 'L', payload: { name: 'b', kind: 'teammate', teamName: 'alpha', memberSessionId: 'M2' } }), true)
  assert.equal(t.working('alpha'), 2)
  assert.equal(t.ingest({ type: 'agent_activity', sessionId: 'L', payload: { name: 'a', activity: 'idle' } }), true)
  assert.equal(t.ingest({ type: 'agent_activity', sessionId: 'L', payload: { name: 'a', activity: 'idle' } }), false)
  assert.equal(t.working('alpha'), 1)
  assert.equal(t.ingest({ type: 'agent_complete', sessionId: 'L', payload: { name: 'b' } }), true)
  assert.equal(t.working('alpha'), 0)
  assert.equal(t.memberCount('alpha'), 2)
  assert.equal(t.ingest({ type: 'message', sessionId: 'L', payload: {} }), false)
  const ids = teamSessionIds('alpha', t, [{ id: 'M3', teamName: 'alpha' }, { id: 'X' }])
  assert.deepEqual([...ids].sort(), ['L', 'M1', 'M2', 'M3'])
  t.clear()
  assert.equal(t.teams.size, 0)
})

// ─── same-name agents rule (#35) ────────────────────────────────────────────

test('same-name sub-agents: plain-name events reach the first holder, name@toolUseId reaches the second', () => {
  const s = run([
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'Explore', parent: 'orchestrator', toolUseId: 'tu1' } },
    { type: 'agent_spawn', payload: { name: 'Explore', parent: 'orchestrator', toolUseId: 'tu2' } },
    { type: 'message', payload: { agent: 'Explore', role: 'assistant', content: 'to first' } },
    { type: 'message', payload: { agent: 'Explore@tu2', role: 'assistant', content: 'to second' } },
  ])
  assert.equal(s.agents.size, 3)
  assert.equal(s.conversations.get('default:Explore')!.map(m => m.content).join(), 'to first')
  assert.equal(s.conversations.get('default:Explore@tu2')!.map(m => m.content).join(), 'to second')
})

test('buildTabModel: two teams with the same name under different leads each keep their own sessions', () => {
  const sessions = [
    { id: 'L1', teamName: 'alpha' }, { id: 'L3', teamName: 'alpha' }, { id: 'plain' },
  ]
  const meta = new Map([
    ['alpha', { name: 'alpha', leadSessionId: 'L1' }],
    ['alpha@L3', { name: 'alpha', leadSessionId: 'L3' }],
  ])
  const tabs = buildTabModel(sessions, meta.keys(), meta)
  const under = (team: string) => {
    const i = tabs.findIndex(t => t.kind === 'team' && t.teamName === team)
    const out: string[] = []
    for (let j = i + 1; j < tabs.length && tabs[j].kind === 'session' && tabs[j].teamName === team; j++) out.push(tabs[j].id)
    return out
  }
  assert.deepEqual(under('alpha'), ['L1'])
  assert.deepEqual(under('alpha@L3'), ['L3'])
  assert.equal(tabs[tabs.length - 1].id, 'plain')
})
