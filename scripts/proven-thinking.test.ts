/**
 * "Thinking" is shown only when an observed thinking block proves it (#362): a context reading, a
 * prompt, an answer or the end of a tool call never makes an agent think.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import type { AgentState, SimulationEvent } from '../web/lib/agent-types'

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
