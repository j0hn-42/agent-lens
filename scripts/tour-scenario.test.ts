import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TOUR_SCENARIO, TOUR_SESSIONS } from '../web/lib/tour-scenario'
import { processEvent, eventSessionId, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ALL_TYPES: SimulationEvent['type'][] = [
  'agent_spawn', 'agent_complete', 'agent_idle', 'message', 'context_update', 'model_detected',
  'tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return', 'permission_requested',
  'agent_link', 'message_sent', 'team_info', 'agent_activity',
]

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function play(events: SimulationEvent[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}

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
  const declared = new Set(TOUR_SESSIONS.map(s => s.id))
  const used = new Set(TOUR_SCENARIO.map(e => eventSessionId(e)))
  assert.deepEqual([...used].filter(s => !declared.has(s)), [])
  assert.deepEqual([...declared].filter(s => !used.has(s)), [])
})

test('the sessions cover both runtimes and a project shared by two sessions (Fleet / All grouping)', () => {
  assert.ok(TOUR_SESSIONS.some(s => s.runtime === 'claude') && TOUR_SESSIONS.some(s => s.runtime === 'codex'))
  const byProject = new Map<string, number>()
  for (const s of TOUR_SESSIONS) if (s.projectId) byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + 1)
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
