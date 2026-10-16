// A subagent that finished (agent_complete) and then resumes (SendMessage "Resuming agent": the same
// subagents/agent-*.jsonl file grows, no new agent_spawn) is live again from its first observed work
// event, and only from that (#433).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, processEventBatch, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { isDoneAgent, isInactiveAgent } from '../web/lib/inactive-agents'
import { MAX_ARCHIVED_PER_SESSION } from '../web/hooks/simulation/archive'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time: number }

function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  for (const e of events) {
    state = processEvent({ time: e.time, type: e.type, payload: e.payload, sessionId: 's1' }, { ...state, currentTime: e.time }, ctx)
  }
  return state
}

const KEY = agentKeyOf('s1', 'impl-379')
const finished: Ev[] = [
  { time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
  { time: 2, type: 'agent_spawn', payload: { name: 'impl-379', parent: 'orchestrator', task: '#379' } },
  { time: 3, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Read', args: 'a.ts', toolUseId: 'tu1' } },
  { time: 4, type: 'agent_complete', payload: { name: 'impl-379' } },
]
const agentOf = (s: SimulationState) => s.agents.get(KEY)!

test('a finished subagent is complete and archived', () => {
  const a = agentOf(run(finished))
  assert.equal(a.state, 'complete')
  assert.equal(a.archived, true)
  assert.equal(a.completeTime, 4)
})

test('resumed subagent: its first tool_call_start makes it live again (not archived, no completeTime)', () => {
  const s = run([...finished, { time: 10, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Bash', args: 'pnpm test' } }])
  const a = agentOf(s)
  assert.equal(a.state, 'tool_calling')
  assert.equal(a.archived, false)
  assert.equal(a.completeTime, undefined)
  assert.equal(isDoneAgent(a), false)
  assert.equal(isInactiveAgent(a), false)
})

test('resumed subagent: its timeline entry is open again and shows the new tool call after "Done"', () => {
  const s = run([...finished, { time: 10, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Bash', args: 'pnpm test' } }])
  const entry = s.timelineEntries.get(KEY)!
  assert.equal(entry.endTime, undefined)
  const types = entry.blocks.map(b => b.type)
  assert.deepEqual(types.slice(-2), ['complete', 'tool_call'])
  assert.equal(entry.blocks[entry.blocks.length - 1].endTime, undefined)
})

test('resumed subagent: an assistant message makes it live again, idle between two steps (no invented work)', () => {
  const s = run([...finished, { time: 10, type: 'message', payload: { agent: 'impl-379', role: 'assistant', content: 'je reprends' } }])
  const a = agentOf(s)
  assert.equal(a.archived, false)
  assert.equal(a.completeTime, undefined)
  assert.equal(a.state, 'idle')
  assert.equal(a.awaitingNextEvent, true)
  assert.equal(isDoneAgent(a), false)
  assert.equal(a.messageBubbles[a.messageBubbles.length - 1].text, 'je reprends')
  assert.equal(s.timelineEntries.get(KEY)!.endTime, undefined)
})

test('resumed subagent: a thinking message makes it thinking again', () => {
  const s = run([...finished, { time: 10, type: 'message', payload: { agent: 'impl-379', role: 'thinking', content: 'hmm' } }])
  const a = agentOf(s)
  assert.equal(a.state, 'thinking')
  assert.equal(a.archived, false)
  assert.equal(a.completeTime, undefined)
  const last = s.timelineEntries.get(KEY)!.blocks.slice(-1)[0]
  assert.equal(last.type, 'thinking')
})

test('a user message is not work: a finished subagent stays finished', () => {
  const a = agentOf(run([...finished, { time: 10, type: 'message', payload: { agent: 'impl-379', role: 'user', content: 'Resuming agent' } }]))
  assert.equal(a.state, 'complete')
  assert.equal(a.archived, true)
  assert.equal(a.completeTime, 4)
})

test('a late tool_call_end of a call started before the end does not bring it back', () => {
  const a = agentOf(run([...finished, { time: 10, type: 'tool_call_end', payload: { agent: 'impl-379', tool: 'Read', toolUseId: 'tu1', result: 'ok' } }]))
  assert.equal(a.state, 'complete')
  assert.equal(a.archived, true)
  assert.equal(a.completeTime, 4)
})

test('administrative events (agent_idle, context_update, model_detected) do not bring it back', () => {
  const a = agentOf(run([
    ...finished,
    { time: 10, type: 'agent_idle', payload: { name: 'impl-379', turnEnd: true } },
    { time: 11, type: 'context_update', payload: { agent: 'impl-379', tokens: 1200 } },
    { time: 12, type: 'model_detected', payload: { agent: 'impl-379', model: 'claude-sonnet-5-5' } },
  ]))
  assert.equal(a.state, 'complete')
  assert.equal(a.archived, true)
})

test('a working subagent is unchanged by a message (nothing to revive)', () => {
  const s = run([
    finished[0], finished[1],
    { time: 3, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Read', args: 'a.ts' } },
    { time: 4, type: 'message', payload: { agent: 'impl-379', role: 'assistant', content: 'x' } },
  ])
  assert.equal(agentOf(s).archived, undefined)
})

test('inactivity completion (not a witnessed end) is undone by observed work, with a fresh active span', () => {
  const live = (events: SimulationEvent[], prev: SimulationState, receivedAt: number) =>
    processEventBatch(events, prev, ctx, { advanceClock: true, receivedAt }).state
  const ev = (time: number, type: string, payload: Record<string, unknown>): SimulationEvent => ({ time, type, payload, sessionId: 's1' } as SimulationEvent)
  let s = live([
    ev(1, 'agent_spawn', { name: 'orchestrator', isMain: true }),
    ev(2, 'agent_spawn', { name: 'impl-379', parent: 'orchestrator' }),
    ev(3, 'tool_call_start', { agent: 'impl-379', tool: 'Read', args: 'a.ts' }),
  ], createEmptyState(), 1_000_000)
  s = live([ev(4, 'agent_complete', { name: 'impl-379', inactivity: true })], s, 1_500_000)
  assert.equal(agentOf(s).state, 'complete')
  assert.equal(agentOf(s).activeSince, undefined)
  const closed = agentOf(s).activeMs
  s = live([ev(10, 'tool_call_start', { agent: 'impl-379', tool: 'Bash', args: 'pnpm test' })], s, 2_000_000)
  const a = agentOf(s)
  assert.equal(a.state, 'tool_calling')
  assert.equal(a.archived, false)
  assert.equal(a.activeSince, 2_000_000)
  assert.equal(a.activeMs, closed)
})

test('history replay: agent_complete followed by new activity in the same history is a real resume', () => {
  const events = [...finished, { time: 10, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Bash', args: 'x' } }]
    .map(e => ({ ...e, sessionId: 's1' }) as SimulationEvent)
  const { state } = processEventBatch(events, createEmptyState(), ctx, { advanceClock: true })
  const a = agentOf(state)
  assert.equal(a.state, 'tool_calling')
  assert.equal(a.archived, false)
})

test('a revived subagent leaves the archive queue: the oldest archived one is evicted instead', () => {
  let s = run([finished[0]])
  const events: Ev[] = []
  for (let i = 0; i < MAX_ARCHIVED_PER_SESSION; i++) {
    events.push({ time: 2 + i * 2, type: 'agent_spawn', payload: { name: `w${i}`, parent: 'orchestrator' } })
    events.push({ time: 3 + i * 2, type: 'agent_complete', payload: { name: `w${i}` } })
  }
  s = run(events, s)
  // w0 resumes, then one more subagent finishes: the cap evicts w1 (oldest still archived), not the live w0
  s = run([
    { time: 1000, type: 'tool_call_start', payload: { agent: 'w0', tool: 'Bash', args: 'x' } },
    { time: 1001, type: 'agent_spawn', payload: { name: 'extra', parent: 'orchestrator' } },
    { time: 1002, type: 'agent_complete', payload: { name: 'extra' } },
  ], s)
  assert.ok(s.agents.has(agentKeyOf('s1', 'w0')))
  assert.equal(s.agents.get(agentKeyOf('s1', 'w0'))!.archived, false)
  assert.equal(s.agents.has(agentKeyOf('s1', 'w1')), false)
  assert.ok(s.agents.has(agentKeyOf('s1', 'extra')))
})

test('a revived teammate is working again, not done', () => {
  const s = run([
    { time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { time: 2, type: 'agent_spawn', payload: { name: 'impl-379', parent: 'orchestrator', kind: 'teammate', teamName: 't1' } },
    { time: 3, type: 'agent_complete', payload: { name: 'impl-379' } },
    { time: 10, type: 'tool_call_start', payload: { agent: 'impl-379', tool: 'Bash', args: 'x' } },
  ])
  const a = agentOf(s)
  assert.equal(a.archived, false)
  assert.equal(a.activity, 'working')
})
