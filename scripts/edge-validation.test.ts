// Parent -> child edges are only presented as fact when the events agree (#54): a call by the
// parent (dispatch or tool call) carrying the same tool_use_id, then the child's start with the same
// parent and name, then a matching return. Any disagreement leaves the edge "unverified".
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, edgeId, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string; time?: number }
function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const main: Ev = { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } }
const dispatch = (over: Record<string, unknown> = {}): Ev => ({
  type: 'subagent_dispatch',
  payload: { parent: 'orchestrator', child: 'worker', task: 't', toolUseId: 'toolu_1', ...over },
})
const spawn = (over: Record<string, unknown> = {}): Ev => ({
  type: 'agent_spawn',
  payload: { name: 'worker', parent: 'orchestrator', toolUseId: 'toolu_1', ...over },
})
const edge = (s: SimulationState, child = 'default:worker') =>
  s.edges.find(e => e.type === 'parent-child' && e.to === child)!

test('dispatch then spawn with the same tool_use_id, parent and name: verified edge', () => {
  const e = edge(run([main, dispatch(), spawn()]))
  assert.equal(e.verified, true)
  assert.equal(e.unverifiedReason, undefined)
})

test('a tool call of the parent with the same tool_use_id is also a valid call evidence', () => {
  const call: Ev = { type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Agent', args: 'x', toolUseId: 'toolu_1' } }
  assert.equal(edge(run([main, call, spawn()])).verified, true)
})

test('spawn without any prior call: unverified (no-call)', () => {
  const e = edge(run([main, spawn()]))
  assert.equal(e.verified, false)
  assert.equal(e.unverifiedReason, 'no-call')
})

test('spawn before its dispatch (out of order): unverified, and a late dispatch does not promote it', () => {
  const s = run([main, spawn(), dispatch()])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'no-call')
})

test('no tool_use_id: name alone is not a proof', () => {
  const s = run([main, dispatch({ toolUseId: undefined }), spawn({ toolUseId: undefined })])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'no-tool-use-id')
})

test('dispatch names another parent for the same tool_use_id: unverified (parent-mismatch)', () => {
  const other: Ev = { type: 'agent_spawn', payload: { name: 'other', parent: 'orchestrator' } }
  const s = run([main, other, dispatch({ parent: 'other' }), spawn()])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'parent-mismatch')
})

test('dispatch names another child for the same tool_use_id: unverified (child-mismatch)', () => {
  const s = run([main, dispatch({ child: 'someone-else' }), spawn()])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'child-mismatch')
})

test('tool call of another agent holding the tool_use_id: unverified (parent-mismatch)', () => {
  const other: Ev = { type: 'agent_spawn', payload: { name: 'other', parent: 'orchestrator' } }
  const call: Ev = { type: 'tool_call_start', payload: { agent: 'other', tool: 'Agent', args: 'x', toolUseId: 'toolu_1' } }
  const s = run([main, other, call, spawn()])
  assert.equal(edge(s).unverifiedReason, 'parent-mismatch')
})

test('unknown parent falls back to the main agent: unverified (parent-fallback)', () => {
  const s = run([main, dispatch({ parent: 'ghost' }), spawn({ parent: 'ghost' })])
  const e = edge(s)
  assert.equal(e.from, 'default:orchestrator')
  assert.equal(e.verified, false)
  assert.equal(e.unverifiedReason, 'parent-fallback')
})

test('a return from another parent for a known tool_use_id demotes the edge (return-mismatch)', () => {
  const other: Ev = { type: 'agent_spawn', payload: { name: 'other', parent: 'orchestrator' } }
  const ret: Ev = { type: 'subagent_return', payload: { parent: 'other', child: 'worker', summary: 's', toolUseId: 'toolu_1' } }
  const s = run([main, other, dispatch(), spawn(), ret])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'return-mismatch')
})

test('a matching return keeps the edge verified', () => {
  const ret: Ev = { type: 'subagent_return', payload: { parent: 'orchestrator', child: 'worker', summary: 's', toolUseId: 'toolu_1' } }
  assert.equal(edge(run([main, dispatch(), spawn(), ret])).verified, true)
})

test('a conflicting second dispatch for a live tool_use_id demotes the edge (dispatch-mismatch)', () => {
  const again = dispatch({ child: 'impostor' })
  const s = run([main, dispatch(), spawn(), again])
  assert.equal(edge(s).verified, false)
  assert.equal(edge(s).unverifiedReason, 'dispatch-mismatch')
})

test('same tool_use_id in another session is not evidence', () => {
  const s = run([
    { ...main, sessionId: 's1' },
    { ...dispatch(), sessionId: 's2' },
    { ...spawn(), sessionId: 's1' },
  ])
  const e = s.edges.find(x => x.type === 'parent-child')!
  assert.equal(e.id, edgeId('s1:orchestrator', 's1:worker'))
  assert.equal(e.verified, false)
})

test('tool edges carry no verification state', () => {
  const call: Ev = { type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', args: 'a' } }
  const e = run([main, call]).edges.find(x => x.type === 'tool')!
  assert.equal(e.verified, undefined)
})

test('the demo scenario carries its tool_use_ids: every parent link is verified', async () => {
  const { MOCK_SCENARIO } = await import('../web/lib/mock-scenario')
  const s = run(MOCK_SCENARIO.map(e => ({ type: e.type, payload: e.payload, time: e.time })))
  const links = s.edges.filter(e => e.type === 'parent-child')
  assert.ok(links.length >= 3)
  assert.deepEqual(links.filter(e => e.verified !== true).map(e => e.id), [])
})

test('re-spawn of a known agent does not change its edge', () => {
  const s = run([main, dispatch(), spawn(), spawn({ parent: 'ghost' })])
  assert.equal(s.edges.filter(e => e.type === 'parent-child').length, 1)
  assert.equal(edge(s).verified, true)
})
