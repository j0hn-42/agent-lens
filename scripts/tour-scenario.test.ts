import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TOUR_SCENARIO, tourSessions } from '../web/lib/tour-scenario'
import { processEvent, eventSessionId, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import { listWaste } from '../web/lib/waste'
import { deriveFileConflicts } from '../web/lib/file-conflicts'
import { deriveDelegationReport } from '../web/lib/delegation-report'
import { detectLoops, REPEAT_THRESHOLD } from '../web/lib/loop-detection'

const ALL_TYPES: SimulationEvent['type'][] = [
  'agent_spawn', 'agent_complete', 'agent_idle', 'message', 'context_update', 'model_detected',
  'tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return', 'permission_requested',
  'agent_link', 'message_sent', 'team_info', 'agent_activity', 'context_compacted',
]

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

test('the demo sessions are dated now, not years ago: no "1062 d ago", no "1062d 22h" of runtime (#383)', () => {
  const DAY = 86_400_000
  for (const s of tourSessions()) {
    assert.ok(Math.abs(Date.now() - s.lastActivityTime) < DAY, `${s.id} last activity is within a day of now`)
    assert.ok(Date.now() - s.startTime < DAY, `${s.id} started within a day of now`)
  }
})

function play(events: SimulationEvent[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}

test('the demo sessions are dated from the instant they are asked for, not from the module load (#383 review)', () => {
  const at = Date.parse('2031-01-01T00:00:00Z')
  for (const s of tourSessions(at)) assert.ok(at - s.startTime < 120_000 && s.lastActivityTime <= at, `${s.id} is dated from the given instant`)
})

test('the tour is sorted by time: the player reads it in array order and would stall on a late entry', () => {
  for (let i = 1; i < TOUR_SCENARIO.length; i++) {
    assert.ok(TOUR_SCENARIO[i].time >= TOUR_SCENARIO[i - 1].time, `event ${i} (t=${TOUR_SCENARIO[i].time}) comes after t=${TOUR_SCENARIO[i - 1].time}`)
  }
})

test('the tour plays every event type the simulation understands', () => {
  const played = new Set(TOUR_SCENARIO.map(e => e.type))
  assert.deepEqual(ALL_TYPES.filter(t => !played.has(t)), [])
})

test('every event names a declared session, and every declared session is used', () => {
  const declared = new Set(tourSessions().map(s => s.id))
  const used = new Set(TOUR_SCENARIO.map(e => eventSessionId(e)))
  assert.deepEqual([...used].filter(s => !declared.has(s)), [])
  assert.deepEqual([...declared].filter(s => !used.has(s)), [])
})

test('the sessions cover both runtimes and a project shared by two sessions (Fleet / All grouping)', () => {
  assert.ok(tourSessions().some(s => s.runtime === 'claude') && tourSessions().some(s => s.runtime === 'codex'))
  const byProject = new Map<string, number>()
  for (const s of tourSessions()) if (s.projectId) byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + 1)
  assert.ok([...byProject.values()].some(n => n >= 2))
})

test('the played tour shows what the README promises', () => {
  const s = play(TOUR_SCENARIO)
  const agents = [...s.agents.values()]
  assert.ok(agents.some(a => a.runtime === 'codex'), 'a Codex agent')
  assert.ok(agents.some(a => a.requestedModel && a.model && a.requestedModel !== a.model), 'a requested != actual model')
  assert.ok(agents.some(a => a.effort), 'a reasoning effort')
  assert.ok(agents.some(a => a.kind === 'teammate' && a.teamKind !== 'workflow'), 'an Agent Team member')
  assert.ok(agents.some(a => a.teamKind === 'workflow' && a.phase), 'a workflow member with its phase')
  assert.ok(s.links.size > 0 && [...s.links.values()].some(l => l.messages.length > 0), 'a Comms link with messages')
  assert.ok(s.unattributed.size > 0, 'an unattributed cost')
  assert.ok([...s.toolCalls.values()].some(t => t.state === 'error'), 'a failed tool call')
})

// ── The features the tour added after the README rewrite: each is asserted on the PLAYED state, not on the events ──
const PAY = (name: string) => `tour-payments:${name}`

test('the tour stays under about 100 seconds', () => {
  const end = Math.max(...TOUR_SCENARIO.map(e => e.time))
  assert.ok(end <= 100, `the last event is at ${end} s`)
})

test('repeated reads and calls: a file read again with no edit between, and a Glob run again, with the cost of the repeat', () => {
  const items = listWaste(play(TOUR_SCENARIO).waste)
  const reread = items.find(i => i.kind === 'reread' && i.agentId === PAY('orchestrator'))
  assert.ok(reread, 'the orchestrator reads a file again')
  assert.equal(reread.repeats, 1)
  assert.ok(reread.costsKnown === 1 && reread.costsUnknown === 0 && reread.tokens > 0, 'the cost of the repeat is the one reported')
  const glob = items.find(i => i.toolName === 'Glob' && i.agentId === PAY('orchestrator'))
  assert.ok(glob && glob.repeats === 1 && glob.tokens > 0, 'the same Glob is run again, with a reported cost')
  assert.equal(play(TOUR_SCENARIO).waste.uncompared, 0, 'every compared call carries its input')
})

test('file conflict: two agents of the payments session each edited the same absolute file with a success', () => {
  const conflicts = deriveFileConflicts(play(TOUR_SCENARIO).fileAttention)
  assert.equal(conflicts.length, 1)
  assert.ok(conflicts[0].path.startsWith('/'))
  assert.deepEqual(conflicts[0].editors.map(e => e.agent).sort(), [PAY('api-dev'), PAY('orchestrator')])
  assert.ok(conflicts[0].editors.every(e => e.edits >= 1))
})

test('delegation report: each sub-agent of the orchestrator has tokens, a measured or recorded duration and the start of a report', () => {
  const s = play(TOUR_SCENARIO)
  const rows = deriveDelegationReport(PAY('orchestrator'), s.agents, s.fileAttention, s.edges)
  assert.deepEqual(rows.map(r => r.name), ['explore-agent', 'research-agent', 'test-runner', 'lint-fixer'])
  for (const r of rows) {
    assert.equal(r.tokens.status, 'available', `${r.name} tokens`)
    assert.ok(r.duration.kind === 'measured' || r.duration.kind === 'recorded', `${r.name} duration is ${r.duration.kind}`)
    assert.ok(r.result.kind === 'returned' && r.result.excerpt.length > 0, `${r.name} report`)
    assert.ok(r.linkVerified, `${r.name} link`)
  }
  assert.ok(rows.some(r => r.duration.kind === 'recorded') && rows.some(r => r.duration.kind === 'measured'))
  assert.ok(rows.some(r => r.filesReadCount > 0), 'a sub-agent with files read')
  assert.ok(rows.some(r => r.filesReadCount === 0 && r.readsNotConfirmed === 0), 'a sub-agent with none observed, said as such')
  for (const r of rows.filter(x => x.duration.kind === 'measured')) {
    const dispatch = TOUR_SCENARIO.find(e => e.type === 'subagent_dispatch' && e.payload.child === r.name)
    const back = TOUR_SCENARIO.find(e => e.type === 'subagent_return' && e.payload.child === r.name)
    assert.ok(dispatch && back && r.duration.kind === 'measured')
    assert.ok(Math.abs(r.duration.seconds - (back.time - dispatch.time)) < 1e-6, `${r.name}: measured = return - dispatch`)
  }
})

test('context compaction: an agent fills its context, then a COMPACTED row with the size before and a smaller gauge', () => {
  const s = play(TOUR_SCENARIO)
  const rows = (s.conversations.get(PAY('lint-fixer')) ?? []).filter(m => m.type === 'compaction')
  assert.equal(rows.length, 1)
  const { trigger, preTokens } = rows[0].compaction ?? {}
  assert.equal(trigger, 'auto')
  assert.ok(typeof preTokens === 'number' && preTokens > 150_000)
  const readings = TOUR_SCENARIO.filter(e => e.type === 'context_update' && e.payload.agent === 'lint-fixer').map(e => e.payload.tokens as number)
  assert.ok(Math.max(...readings) === preTokens, 'the size before is the last reading before the compaction')
  assert.ok((s.agents.get(PAY('lint-fixer'))?.tokensUsed ?? Infinity) < preTokens, 'the gauge dropped after it')
})

test('loop: the same failing call is made exactly the threshold number of times, by one agent, and nobody else loops', () => {
  const s = play(TOUR_SCENARIO)
  for (const [key, messages] of s.conversations) {
    const v = detectLoops(messages)
    if (key !== PAY('lint-fixer')) { assert.notEqual(v.status, 'loop', `${key} must not loop`); continue }
    assert.equal(v.status, 'loop')
    assert.equal(v.findings.length, 1)
    const f = v.findings[0]
    assert.ok(f.kind === 'repeat' && f.count === REPEAT_THRESHOLD && !f.atLeast, 'exactly the threshold')
  }
  const failed = [...s.toolCalls.values()].filter(t => t.agentId === PAY('lint-fixer') && t.state === 'error')
  assert.equal(failed.length, REPEAT_THRESHOLD, 'each of the repeated calls failed')
})
