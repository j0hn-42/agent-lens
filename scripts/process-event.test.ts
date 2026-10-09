import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, eventSessionId, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import {
  createEmptyState, agentKeyOf, edgeId, appendConversation, MAX_CONVERSATION_MESSAGES, MAX_LINK_MESSAGES, MAX_TEXT_LEN,
  type SimulationState,
} from '../web/hooks/simulation/types'
import { stampEventTimes, droppedFromLog } from '../web/hooks/simulation/stamp-time'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string; time?: number }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: time }, ctx)
  }
  return state
}

test('events without a session id belong to the default session', () => {
  assert.equal(eventSessionId({}), 'default')
  assert.equal(eventSessionId({ sessionId: '' }), 'default')
  assert.equal(eventSessionId({ sessionId: 's1' }), 's1')
  const s = run([{ type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } }])
  const a = s.agents.get('default:orchestrator')!
  assert.equal(a.id, a.agentKey)
  assert.equal(a.sessionId, 'default')
  assert.equal(a.localId, 'orchestrator')
  assert.equal(a.parentKey, null)
})

test('two sessions that both have a main agent coexist without collision', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 'one' } },
    { sessionId: 's2', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 'two' } },
    { sessionId: 's1', type: 'message', payload: { agent: 'orchestrator', role: 'user', content: 'hello from one' } },
    { sessionId: 's2', type: 'message', payload: { agent: 'orchestrator', role: 'assistant', content: 'hello from two' } },
    { sessionId: 's2', type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', args: 'a.ts' } },
    { sessionId: 's1', type: 'agent_complete', payload: { name: 'orchestrator' } },
  ])
  assert.equal(s.agents.size, 2)
  const a1 = s.agents.get(agentKeyOf('s1', 'orchestrator'))!
  const a2 = s.agents.get(agentKeyOf('s2', 'orchestrator'))!
  assert.equal(a1.state, 'complete')
  assert.equal(a2.state, 'tool_calling')
  assert.equal(a1.displayName, 'hello from one')
  assert.equal(a1.localId, 'orchestrator')
  assert.equal(a2.displayName, 'orchestrator')
  assert.equal(s.conversations.get(a1.id)!.length, 1)
  assert.equal(s.conversations.get(a2.id)!.length, 2)
  assert.equal(s.timelineEntries.size, 2)
  assert.ok(Array.from(s.toolCalls.values()).every(tc => tc.agentId === a2.id))
})

test('sub-agents of the same description are distinct nodes and keep their own parent', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's1', type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'Explore codebase', task: 'Explore codebase', toolUseId: 'toolu_A', label: 'Explore codebase' } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'Explore codebase', parent: 'orchestrator', toolUseId: 'toolu_A', label: 'Explore codebase' } },
    { sessionId: 's1', type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'Explore codebase #2', task: 'Explore codebase', toolUseId: 'toolu_B', label: 'Explore codebase' } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'Explore codebase #2', parent: 'orchestrator', toolUseId: 'toolu_B', label: 'Explore codebase' } },
  ])
  const a = s.agents.get('s1:Explore codebase')!
  const b = s.agents.get('s1:Explore codebase #2')!
  assert.ok(a && b && a.id !== b.id)
  assert.equal(a.displayName, 'Explore codebase')
  assert.equal(b.displayName, 'Explore codebase')
  assert.equal(a.toolUseId, 'toolu_A')
  assert.equal(b.toolUseId, 'toolu_B')
  assert.equal(a.parentKey, 's1:orchestrator')
  assert.equal(b.parentId, 's1:orchestrator')
  assert.equal(s.edges.filter(e => e.type === 'parent-child').length, 2)
})

test('identity follows the tool_use_id when the same name is reused', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', toolUseId: 'toolu_A' } },
    { sessionId: 's1', type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'worker', task: 't', toolUseId: 'toolu_B' } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', toolUseId: 'toolu_B' } },
    { sessionId: 's1', type: 'subagent_return', payload: { parent: 'orchestrator', child: 'worker', summary: 'done B', toolUseId: 'toolu_B' } },
  ])
  const keys = Array.from(s.agents.keys()).sort()
  assert.deepEqual(keys, ['s1:orchestrator', 's1:worker', 's1:worker@toolu_B'])
  assert.equal(s.agents.get('s1:worker')!.toolUseId, 'toolu_A')
  assert.equal(s.agents.get('s1:worker@toolu_B')!.toolUseId, 'toolu_B')
  // The report went to the agent of toolu_B, not to the first 'worker'
  const reportsB = s.conversations.get('s1:worker@toolu_B')!.filter(m => m.type === 'return')
  assert.equal(reportsB.length, 1)
  assert.equal(reportsB[0].content, 'done B')
  assert.equal((s.conversations.get('s1:worker') ?? []).filter(m => m.type === 'return').length, 0)
})

test('nested sub-agents use their real parent, not the main agent', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'planner', parent: 'orchestrator', toolUseId: 'toolu_1' } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'coder', parent: 'planner', toolUseId: 'toolu_2' } },
  ])
  const coder = s.agents.get('s1:coder')!
  assert.equal(coder.parentKey, 's1:planner')
  assert.ok(s.edges.some(e => e.id === edgeId('s1:planner', 's1:coder')))
  assert.ok(!s.edges.some(e => e.id === edgeId('s1:orchestrator', 's1:coder')))
  // Completing the middle agent completes its child only
  const done = processEvent({ time: 5, type: 'agent_complete', payload: { name: 'planner' }, sessionId: 's1' }, s, ctx)
  assert.equal(done.agents.get('s1:coder')!.state, 'complete')
  assert.notEqual(done.agents.get('s1:orchestrator')!.state, 'complete')
})

test('an unknown parent falls back to the main agent of the same session only', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's2', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's2', type: 'agent_spawn', payload: { name: 'lost', parent: 'ghost' } },
  ])
  assert.equal(s.agents.get('s2:lost')!.parentKey, 's2:orchestrator')
})

test('dispatch and return fill the links store and both conversations', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { sessionId: 's1', type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'sub', task: 'short', prompt: 'the full prompt', toolUseId: 'toolu_1' } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'sub', parent: 'orchestrator', toolUseId: 'toolu_1' } },
    { sessionId: 's1', type: 'subagent_return', payload: { parent: 'orchestrator', child: 'sub', summary: 'the full report', toolUseId: 'toolu_1', isError: true } },
  ])
  const linkId = edgeId('s1:orchestrator', 's1:sub')
  const link = s.links.get(linkId)!
  assert.equal(link.kind, 'spawn')
  assert.equal(link.from, 's1:orchestrator')
  assert.equal(link.to, 's1:sub')
  assert.equal(link.sessionId, 's1')
  assert.deepEqual(link.messages.map(m => [m.type, m.content]), [['dispatch', 'the full prompt'], ['return', 'the full report']])
  assert.equal(link.messages[1].isError, true)
  assert.equal(s.conversations.get('s1:orchestrator')!.filter(m => m.linkId === linkId).length, 2)
  assert.equal(s.conversations.get('s1:sub')!.filter(m => m.linkId === linkId).length, 2)
})

test('agent_link and message_sent build teammate links defensively', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'lead', isMain: true } },
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'mate', parent: 'lead' } },
    { sessionId: 's1', type: 'agent_link', payload: { from: 'lead', to: 'mate', kind: 'teammate', linkId: 'link-1' } },
    { sessionId: 's1', type: 'message_sent', payload: { from: 'lead', to: 'mate', kind: 'teammate', linkId: 'link-1', content: 'ping', toolUseId: 'toolu_x' } },
    { sessionId: 's1', type: 'message_sent', payload: { from: 'mate', to: 'lead', kind: 'teammate', linkId: 'link-1', content: 'pong' } },
  ])
  const link = s.links.get('link-1')!
  assert.equal(link.kind, 'teammate')
  assert.deepEqual(link.messages.map(m => [m.from, m.to, m.content]), [
    ['s1:lead', 's1:mate', 'ping'],
    ['s1:mate', 's1:lead', 'pong'],
  ])
  assert.equal(link.messages[0].toolUseId, 'toolu_x')
})

test('malformed link payloads are ignored or capped, never thrown on', () => {
  const huge = 'x'.repeat(MAX_TEXT_LEN * 3)
  const s = run([
    { type: 'agent_link', payload: {} },
    { type: 'agent_link', payload: { from: 5, to: {} } },
    { type: 'message_sent', payload: { from: 'a' } },
    { type: 'message_sent', payload: { from: 'a', to: 'b', kind: 'weird', content: huge, linkId: 'l'.repeat(1000) } },
  ])
  assert.equal(s.links.size, 1)
  const link = Array.from(s.links.values())[0]
  assert.equal(link.kind, 'teammate', 'unknown kinds are not trusted')
  assert.ok(link.id.length <= 200)
  assert.equal(link.messages[0].content.length, MAX_TEXT_LEN)
})

test('links keep at most MAX_LINK_MESSAGES and count what they dropped', () => {
  const events = Array.from({ length: MAX_LINK_MESSAGES + 5 }, (_, i) => ({
    type: 'message_sent' as const, payload: { from: 'a', to: 'b', linkId: 'l', content: `m${i}` },
  }))
  const link = run(events).links.get('l')!
  assert.equal(link.messages.length, MAX_LINK_MESSAGES)
  assert.equal(link.dropped, 5)
  assert.equal(link.messages[0].content, 'm5')
})

test('conversation overflow is counted per agent', () => {
  const conversations = new Map()
  const dropped = new Map<string, number>()
  for (let i = 0; i < MAX_CONVERSATION_MESSAGES + 3; i++) {
    appendConversation(conversations, 's:a', { type: 'assistant', content: String(i), timestamp: i }, dropped)
  }
  assert.equal(conversations.get('s:a').length, MAX_CONVERSATION_MESSAGES)
  assert.equal(dropped.get('s:a'), 3)
  assert.equal(dropped.get('s:other'), undefined)
})

test('processEvent exposes dropped messages on the state', () => {
  let state = createEmptyState()
  state = processEvent({ time: 0, type: 'agent_spawn', payload: { name: 'a' } }, state, ctx)
  for (let i = 0; i < MAX_CONVERSATION_MESSAGES + 2; i++) {
    state = processEvent({ time: i, type: 'message', payload: { agent: 'a', role: 'assistant', content: `m${i}` } }, state, ctx)
  }
  assert.equal(state.droppedMessages.get('default:a'), 2)
})

test('untrusted payload values do not break handlers', () => {
  const s = run([
    { type: 'agent_spawn', payload: { name: 'a', parent: 7, toolUseId: {}, label: 12 } },
    { type: 'tool_call_start', payload: { agent: 'a', tool: null, args: 5, inputData: [] } },
    { type: 'tool_call_end', payload: { agent: 'a', tool: null, result: {}, isError: 'yes' } },
    { type: 'message', payload: { agent: 'a', content: 99 } },
    { type: 'subagent_return', payload: { parent: 'a', child: 'b', summary: [] } },
  ])
  assert.ok(s.agents.get('default:a'))
  assert.equal(s.agents.get('default:a')!.displayName, 'a')
})

test('stampEventTimes keeps real event times monotonic and falls back for missing ones', () => {
  const out = stampEventTimes([{ time: 12 }, { time: 10 }, { time: 0 }, { time: Number.NaN }, { time: 15 }], 11, 20)
  assert.deepEqual(out.map(e => e.time), [12, 12, 20, 20, 20])
  assert.deepEqual(stampEventTimes([{ time: 5 }, { time: 7 }], 0, 100).map(e => e.time), [5, 7])
  assert.deepEqual(stampEventTimes([], 5, 5), [])
})

test('droppedFromLog counts the events that fall off a capped log', () => {
  assert.equal(droppedFromLog(10, 5, 100), 0)
  assert.equal(droppedFromLog(98, 5, 100), 3)
  assert.equal(droppedFromLog(100, 1, 100), 1)
})

test('tool errors are counted per agent and survive the fade-out of the tool call nodes', () => {
  const s = run([
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'a', isMain: true } },
    { sessionId: 's2', type: 'agent_spawn', payload: { name: 'a', isMain: true } },
    { sessionId: 's1', type: 'tool_call_start', payload: { agent: 'a', tool: 'Bash', args: 'x' } },
    { sessionId: 's1', type: 'tool_call_end', payload: { agent: 'a', tool: 'Bash', result: 'boom', isError: true } },
    { sessionId: 's1', type: 'tool_call_start', payload: { agent: 'a', tool: 'Read', args: 'y' } },
    { sessionId: 's1', type: 'tool_call_end', payload: { agent: 'a', tool: 'Read', result: 'ok', isError: false } },
    { sessionId: 's1', type: 'tool_call_start', payload: { agent: 'a', tool: 'Bash', args: 'z' } },
    { sessionId: 's1', type: 'tool_call_end', payload: { agent: 'a', tool: 'Bash', result: 'boom', isError: true } },
  ])
  s.toolCalls.clear() // what cleanupFaded does once the nodes have faded
  assert.equal(s.agents.get(agentKeyOf('s1', 'a'))!.toolErrors, 2)
  assert.equal(s.agents.get(agentKeyOf('s2', 'a'))!.toolErrors, 0)
})

// #214: entries of the previous state must never be mutated, or memoised views (table view) keep stale rows
function step(prev: SimulationState, e: Pick<SimulationEvent, 'type' | 'payload'> & { time: number }): SimulationState {
  return processEvent({ time: e.time, type: e.type, payload: e.payload, sessionId: 's1' }, { ...prev, currentTime: e.time }, ctx)
}

function timelineSnapshot(s: SimulationState): string {
  return JSON.stringify(Array.from(s.timelineEntries))
}

test('tool_call_start publishes a new timeline map and leaves the previous entry untouched (#214)', () => {
  const prev = step(createEmptyState(), { time: 1, type: 'agent_spawn', payload: { name: 'a', isMain: true } })
  const id = agentKeyOf('s1', 'a')
  const before = prev.timelineEntries.get(id)!
  const length = before.blocks.length
  const next = step(prev, { time: 2, type: 'tool_call_start', payload: { agent: 'a', tool: 'Read', args: 'a.ts' } })
  assert.equal(prev.timelineEntries.get(id)!.blocks.length, length, 'the previous entry keeps its block count')
  assert.equal(prev.timelineEntries.get(id)!.blocks[length - 1].endTime, undefined, 'the previous last block stays open')
  assert.notEqual(next.timelineEntries, prev.timelineEntries)
  assert.notEqual(next.timelineEntries.get(id), before)
  assert.equal(next.timelineEntries.get(id)!.blocks.length, length + 1)
  assert.equal(next.timelineEntries.get(id)!.blocks[length - 1].endTime, 2)
})

test('no timeline event mutates an entry or a block of the previous state (#214)', () => {
  const events: Array<Pick<SimulationEvent, 'type' | 'payload'>> = [
    { type: 'agent_spawn', payload: { name: 'a', isMain: true } },
    { type: 'agent_spawn', payload: { name: 'child', parent: 'a' } },
    { type: 'tool_call_start', payload: { agent: 'a', tool: 'Bash', args: 'x' } },
    { type: 'tool_call_end', payload: { agent: 'a', tool: 'Bash', result: 'boom', isError: true } },
    { type: 'tool_call_start', payload: { agent: 'a', tool: 'Bash', args: 'y' } },
    { type: 'tool_call_end', payload: { agent: 'a', tool: 'Bash', result: '', outcome: 'cancelled' } },
    { type: 'tool_call_start', payload: { agent: 'a', tool: 'Read', args: 'z' } },
    { type: 'tool_call_end', payload: { agent: 'a', tool: 'Read', result: 'ok' } },
    { type: 'permission_requested', payload: { agent: 'a', tool: 'Bash' } },
    { type: 'agent_complete', payload: { name: 'a' } },
  ]
  let state = createEmptyState()
  events.forEach((e, i) => {
    const before = timelineSnapshot(state)
    const next = step(state, { ...e, time: i + 1 })
    assert.equal(timelineSnapshot(state), before, `${e.type} left the previous timeline unchanged`)
    assert.notEqual(next.timelineEntries, state.timelineEntries, `${e.type} publishes a new timeline map`)
    state = next
  })
  const a = state.timelineEntries.get(agentKeyOf('s1', 'a'))!
  assert.equal(a.endTime, 10)
  assert.deepEqual(a.blocks.slice(1, 4).map(b => b.label), ['Bash: FAILED', 'Thinking...', 'Bash: CANCELLED'])
  assert.equal(state.timelineEntries.get(agentKeyOf('s1', 'child'))!.endTime, 10)
})
