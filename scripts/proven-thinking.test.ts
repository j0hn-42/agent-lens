/**
 * "Thinking" is shown only when an observed thinking block proves it (#362): a context reading, a
 * prompt, an answer or the end of a tool call never makes an agent think.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import type { AgentState, SimulationEvent } from '../web/lib/agent-types'
import { isInactiveAgent, visibleAgents } from '../web/lib/inactive-agents'
import { createCollapseMemory, evaluateCollapse } from '../web/components/agent-visualizer/canvas/branch-collapse'
import { transitionSubtitle, pickFollowAgent, nextSnapshot } from '../web/lib/presentation'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time?: number }

function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const KEY = agentKeyOf('default', 'orchestrator')
const orch: Ev = { type: 'agent_spawn', time: 0, payload: { name: 'orchestrator', isMain: true } }
const stateOf = (s: SimulationState) => s.agents.get(KEY)!.state
const withState = (s: SimulationState, st: AgentState) => {
  const agents = new Map(s.agents)
  agents.set(KEY, { ...agents.get(KEY)!, state: st })
  return { ...s, agents }
}
const ctxUpdate: Ev = { type: 'context_update', time: 2, payload: { agent: 'orchestrator', tokens: 1234 } }
const msg = (role: string): Ev => ({ type: 'message', time: 2, payload: { agent: 'orchestrator', role, content: `${role} text` } })
const toolStart: Ev = { type: 'tool_call_start', time: 1, payload: { agent: 'orchestrator', tool: 'Bash', args: 'ls', toolUseId: 't1' } }
const toolEnd = (extra: Record<string, unknown> = {}): Ev => ({ type: 'tool_call_end', time: 2, payload: { agent: 'orchestrator', tool: 'Bash', toolUseId: 't1', result: 'ok', ...extra } })

test('context_update leaves the state alone (attach of a session at the prompt stays idle)', () => {
  const base = run([orch])
  for (const st of ['idle', 'waiting_permission', 'error', 'paused', 'tool_calling', 'thinking'] as AgentState[]) {
    const after = run([ctxUpdate], withState(base, st))
    assert.equal(stateOf(after), st, `context_update on ${st}`)
    assert.equal(after.agents.get(KEY)!.tokensUsed, 1234, 'the figure itself is still taken')
  }
})

test('an observed thinking block puts the agent in thinking', () => {
  assert.equal(stateOf(run([orch, msg('thinking')])), 'thinking')
})

test('a prompt or an answer does not prove thinking', () => {
  for (const role of ['user', 'assistant']) {
    assert.equal(stateOf(run([orch, msg(role)])), 'idle', `${role} on an idle agent`)
    // The thinking block is over once the agent writes or a prompt arrives
    assert.equal(stateOf(run([orch, msg('thinking'), msg(role)])), 'idle', `${role} after a thinking block`)
    assert.equal(stateOf(run([msg(role)], withState(run([orch]), 'waiting_permission'))), 'waiting_permission', `${role} while waiting`)
  }
})

test('the end of a tool call leaves the agent waiting for the next event, not thinking', () => {
  assert.equal(stateOf(run([orch, toolStart, toolEnd()])), 'idle')
  assert.equal(stateOf(run([orch, toolStart, toolEnd({ isError: true })])), 'error', 'a failed call is still an error')
  assert.equal(stateOf(run([orch, toolStart, toolEnd({ isError: true, outcome: 'cancelled' })])), 'idle')
})

test('the end of a tool call opens no Thinking block in the Timeline', () => {
  const s = run([orch, toolStart, toolEnd()])
  const blocks = s.timelineEntries.get(KEY)!.blocks
  assert.ok(!blocks.some(b => b.type === 'thinking' || /Thinking/.test(b.label)), JSON.stringify(blocks.map(b => b.label)))
  const tool = blocks.find(b => b.type === 'tool_call')!
  assert.equal(tool.endTime, 2, 'the tool block is closed at the end of the call')
})

test('a thinking block after a tool call opens a Thinking block in the Timeline', () => {
  const s = run([orch, toolStart, toolEnd(), { ...msg('thinking'), time: 3 }])
  const last = s.timelineEntries.get(KEY)!.blocks.at(-1)!
  assert.equal(last.type, 'thinking')
  assert.equal(last.startTime, 3)
  assert.equal(stateOf(s), 'thinking')
})

test('a call that ends while another of the agent\'s calls still runs leaves the agent calling that tool', () => {
  const read: Ev = { type: 'tool_call_start', time: 1.5, payload: { agent: 'orchestrator', tool: 'Read', args: 'a.ts', toolUseId: 't2' } }
  const s = run([orch, toolStart, read, toolEnd()])
  assert.equal(stateOf(s), 'tool_calling')
  assert.equal(s.agents.get(KEY)!.currentTool, 'Read')
  assert.equal(s.timelineEntries.get(KEY)!.blocks.at(-1)!.endTime, undefined, 'the running call keeps its open block')
  const done = run([{ type: 'tool_call_end', time: 3, payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 't2', result: 'ok' } }], s)
  assert.equal(stateOf(done), 'idle')
  assert.equal(done.timelineEntries.get(KEY)!.blocks.at(-1)!.endTime, 3)
})

test('a call that ends before the other running call closes its own Timeline block, not the running one', () => {
  const read: Ev = { type: 'tool_call_start', time: 1.5, payload: { agent: 'orchestrator', tool: 'Read', args: 'a.ts', toolUseId: 't2' } }
  const readEnd: Ev = { type: 'tool_call_end', time: 2, payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 't2', result: 'ok' } }
  const s = run([orch, toolStart, read, readEnd])
  assert.equal(stateOf(s), 'tool_calling', 'Bash still runs')
  assert.equal(s.agents.get(KEY)!.currentTool, 'Bash')
  const readBlock = s.timelineEntries.get(KEY)!.blocks.find(b => b.type === 'tool_call' && b.label.startsWith('Read:'))!
  assert.equal(readBlock.endTime, 2, 'Read lasted 0.5 s, not until Bash ends')
  const done = run([{ ...toolEnd(), time: 10 }], s)
  assert.equal(done.timelineEntries.get(KEY)!.blocks.find(b => b.label.startsWith('Read:'))!.endTime, 2)
})

test('a failed call is relabelled on its own block, never on the block of the call still running', () => {
  const read: Ev = { type: 'tool_call_start', time: 1.5, payload: { agent: 'orchestrator', tool: 'Read', args: 'a.ts', toolUseId: 't2' } }
  const s = run([orch, toolStart, read, { ...toolEnd({ isError: true }), time: 3 }])
  const blocks = s.timelineEntries.get(KEY)!.blocks
  const bash = blocks.find(b => b.type === 'tool_call' && b.startTime === 1)!
  const readBlock = blocks.find(b => b.type === 'tool_call' && b.startTime === 1.5)!
  assert.equal(bash.label, 'Bash: FAILED')
  assert.ok(readBlock.label.startsWith('Read:'), readBlock.label)
  assert.equal(readBlock.endTime, undefined, 'Read still runs')
})

test('an error then an answer: the failure is over, the agent is idle', () => {
  assert.equal(stateOf(run([orch, toolStart, toolEnd({ isError: true }), { ...msg('assistant'), time: 3 }])), 'idle')
})

test('a prompt or an answer closes the open Thinking block of the Timeline', () => {
  const s = run([orch, msg('thinking'), { ...msg('assistant'), time: 3 }])
  const last = s.timelineEntries.get(KEY)!.blocks.at(-1)!
  assert.equal(last.type, 'thinking')
  assert.equal(last.endTime, 3)
})

test('a resolved permission (agent_idle without turnEnd) never fabricates thinking', () => {
  const perm: Ev = { type: 'permission_requested', time: 1.2, payload: { agent: 'orchestrator' } }
  const resolved: Ev = { type: 'agent_idle', time: 1.4, payload: { name: 'orchestrator' } }
  const noCall = run([orch, perm, resolved])
  assert.notEqual(stateOf(noCall), 'thinking')
  assert.equal(stateOf(noCall), 'idle')
  assert.equal(noCall.agents.get(KEY)!.awaitingNextEvent, true, 'mid-turn: the next step is not observed yet')
  const withCall = run([orch, toolStart, perm, resolved])
  assert.equal(stateOf(withCall), 'tool_calling', 'the call it asked permission for still runs')
  assert.equal(withCall.agents.get(KEY)!.currentTool, 'Bash')
})

// ── Between two steps the turn is not over: the agent is not "inactive" (#362 review) ──────────

const SUB = agentKeyOf('default', 'worker')
const SUB2 = agentKeyOf('default', 'helper')
const spawnSub: Ev = { type: 'agent_spawn', time: 0.5, payload: { name: 'worker', parent: 'orchestrator' } }
const spawnSub2: Ev = { type: 'agent_spawn', time: 0.6, payload: { name: 'helper', parent: 'worker' } }
const subStart = (time: number, id: string): Ev => ({ type: 'tool_call_start', time, payload: { agent: 'helper', tool: 'Bash', args: 'ls', toolUseId: id } })
const subEnd = (time: number, id: string): Ev => ({ type: 'tool_call_end', time, payload: { agent: 'helper', tool: 'Bash', toolUseId: id, result: 'ok' } })

test('an agent between two tool calls stays on the canvas with "Hide inactive agents"', () => {
  const s = run([orch, spawnSub, spawnSub2, subStart(1, 'h1'), subEnd(2, 'h1')])
  const helper = s.agents.get(SUB2)!
  assert.equal(helper.state, 'idle')
  assert.equal(isInactiveAgent(helper), false)
  assert.ok(visibleAgents(s.agents, true).has(SUB2), 'still mid-turn: not hidden')
  // Same after an answer that ends a thinking block
  const afterAnswer = run([{ ...msg('thinking'), time: 3, payload: { agent: 'helper', role: 'thinking', content: 'x' } }, { type: 'message', time: 4, payload: { agent: 'helper', role: 'assistant', content: 'y' } }], s)
  assert.ok(visibleAgents(afterAnswer.agents, true).has(SUB2))
  // The end of the turn is what makes it inactive
  const turnOver = run([{ type: 'agent_idle', time: 5, payload: { name: 'helper', turnEnd: true } }], afterAnswer)
  assert.equal(turnOver.agents.get(SUB2)!.awaitingNextEvent, undefined)
  assert.equal(isInactiveAgent(turnOver.agents.get(SUB2)!), true)
})

test('a branch the user closed stays closed across tool cycles of its descendant', () => {
  const memory = createCollapseMemory()
  let s = run([orch, spawnSub, spawnSub2, subStart(1, 'h1')])
  evaluateCollapse(s.agents, memory)
  memory.manual.set(SUB, 'closed')
  for (const [t, id] of [[2, 'h1'], [3, 'h2'], [4, 'h2'], [5, 'h3']] as const) {
    s = run([t === 3 || t === 5 ? subStart(t, id) : subEnd(t, id)], s)
    const v = evaluateCollapse(s.agents, memory)
    assert.equal(v.branches.get(SUB)!.collapsed, true, `closed at t=${t}`)
  }
})

test('presentation: no "→ Idle" subtitle between two steps, and follow keeps the agent', () => {
  const s = run([orch, toolStart, toolEnd()])
  const live = { ...s.agents.get(KEY)!, lastEventAt: 2, freshnessSource: 'live' as const }
  assert.equal(transitionSubtitle({ state: 'tool_calling', tool: 'Bash' }, live, false), null)
  assert.equal(pickFollowAgent([live])?.id, KEY)
  // The step before is remembered, so the next observed step reads "Calling tool Bash → ..."
  const prev = { state: 'tool_calling' as const, tool: 'Bash' }
  assert.equal(nextSnapshot(prev, live), prev)
  assert.deepEqual(nextSnapshot(prev, { ...live, state: 'thinking' }), { state: 'thinking', tool: undefined })
})
