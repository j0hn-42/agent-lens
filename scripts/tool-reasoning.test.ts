// #231: "Why this tool?" and the causal chain of a failure. Every line shown must be backed by
// observed events: ordering in the agent's own conversation and tool_use_id equality, nothing guessed.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import { reasoningBefore, causalChain, REDACTED_PLACEHOLDER } from '../web/lib/tool-reasoning'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time: number }

const S = 'default'
const k = (id: string) => `${S}:${id}`
const spawnMain: Ev = { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } }
const msg = (time: number, agent: string, role: string, content: string): Ev => ({ time, type: 'message', payload: { agent, role, content } })
const start = (time: number, agent: string, tool: string, toolUseId?: string): Ev => ({
  time, type: 'tool_call_start', payload: { agent, tool, args: 'x', ...(toolUseId ? { toolUseId } : {}) },
})
const end = (time: number, agent: string, tool: string, toolUseId: string | undefined, isError = false, result = 'done'): Ev => ({
  time, type: 'tool_call_end', payload: { agent, tool, result, isError, ...(toolUseId ? { toolUseId } : {}) },
})

function withSession(events: Ev[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    state = processEvent({ time: e.time, type: e.type, payload: e.payload }, { ...state, currentTime: e.time }, ctx)
  }
  return state
}

test('reasoning is the thinking observed right before the call, matched by tool_use_id', () => {
  const st = withSession([
    spawnMain,
    msg(1, 'main', 'user', 'fix the build'),
    msg(2, 'main', 'thinking', 'I should run the tests first'),
    start(3, 'main', 'Bash', 'tu1'),
  ])
  const r = reasoningBefore(st.conversations.get(k('main')), 'tu1', 0)
  assert.equal(r.kind, 'found')
  assert.deepEqual(r.kind === 'found' && r.thoughts.map(t => t.text), ['I should run the tests first'])
})

test('older thinking separated by an assistant message or a tool result is not attributed to the call', () => {
  const st = withSession([
    spawnMain,
    msg(1, 'main', 'thinking', 'old thought'),
    start(2, 'main', 'Read', 'tu0'),
    end(3, 'main', 'Read', 'tu0'),
    start(4, 'main', 'Bash', 'tu1'),
  ])
  assert.equal(reasoningBefore(st.conversations.get(k('main')), 'tu1', 0).kind, 'none')
})

test('parallel calls of one batch share the reasoning that precedes the batch', () => {
  const st = withSession([
    spawnMain,
    msg(1, 'main', 'thinking', 'read both files'),
    start(2, 'main', 'Read', 'a'),
    start(3, 'main', 'Grep', 'b'),
  ])
  const r = reasoningBefore(st.conversations.get(k('main')), 'b', 0)
  assert.equal(r.kind, 'found')
})

test('no tool_use_id, or a call absent from the history, is unknown and never "none"', () => {
  const st = withSession([spawnMain, msg(1, 'main', 'thinking', 't'), start(2, 'main', 'Bash')])
  const conv = st.conversations.get(k('main'))
  assert.deepEqual(reasoningBefore(conv, undefined, 0), { kind: 'unknown', reason: 'no-tool-use-id' })
  assert.deepEqual(reasoningBefore(conv, 'ghost', 0), { kind: 'unknown', reason: 'call-not-in-history' })
  assert.deepEqual(reasoningBefore(undefined, 'ghost', 0), { kind: 'unknown', reason: 'call-not-in-history' })
})

test('when older messages were dropped, an empty result is unknown, a found one is flagged incomplete', () => {
  const st = withSession([spawnMain, start(1, 'main', 'Bash', 'tu1')])
  const conv = st.conversations.get(k('main'))
  assert.deepEqual(reasoningBefore(conv, 'tu1', 5), { kind: 'unknown', reason: 'history-truncated' })
  const st2 = withSession([spawnMain, msg(1, 'main', 'thinking', 'x'), start(2, 'main', 'Bash', 'tu1')])
  const r = reasoningBefore(st2.conversations.get(k('main')), 'tu1', 5)
  assert.equal(r.kind === 'found' && r.incomplete, true)
})

test('redacted thinking is reported as not disclosed, never as text', () => {
  const st = withSession([spawnMain, msg(1, 'main', 'thinking', REDACTED_PLACEHOLDER), start(2, 'main', 'Bash', 'tu1')])
  const r = reasoningBefore(st.conversations.get(k('main')), 'tu1', 0)
  assert.deepEqual(r.kind === 'found' && r.thoughts, [{ text: '', redacted: true }])
})

const delegated: Ev[] = [
  spawnMain,
  msg(1, 'main', 'user', 'first prompt'),
  msg(5, 'main', 'user', 'refactor the parser'),
  msg(6, 'main', 'thinking', 'delegate to a worker'),
  start(7, 'main', 'Agent', 'disp1'),
  { time: 7, type: 'subagent_dispatch', payload: { parent: 'main', child: 'worker', task: 'worker', prompt: 'Rewrite parser.ts', toolUseId: 'disp1' } },
  { time: 8, type: 'agent_spawn', payload: { name: 'worker', parent: 'main', task: 'worker', toolUseId: 'disp1' } },
  msg(9, 'worker', 'thinking', 'the file may be missing'),
  start(10, 'worker', 'Read', 'tu9'),
  end(11, 'worker', 'Read', 'tu9', true, 'ENOENT: no such file'),
]

test('a failure in a sub-agent is traced to the dispatch, then to the latest prompt before it', () => {
  const st = withSession(delegated)
  const steps = causalChain({
    agentId: k('worker'), toolUseId: 'tu9', errorText: 'ENOENT: no such file',
    agents: st.agents, conversations: st.conversations, droppedMessages: st.droppedMessages, edges: st.edges,
  })
  assert.deepEqual(steps.map(s => s.kind), ['failure', 'reasoning', 'dispatch', 'prompt'])
  const dispatch = steps[2]
  assert.equal(dispatch.kind === 'dispatch' && dispatch.prompt, 'Rewrite parser.ts')
  const prompt = steps[3]
  assert.equal(prompt.kind === 'prompt' && prompt.text, 'refactor the parser')
  assert.equal(steps[0].kind === 'failure' && steps[0].text, 'ENOENT: no such file')
})

test('the chain stops with an explicit break when the dispatch cannot be proven', () => {
  const st = withSession([
    spawnMain,
    { time: 1, type: 'agent_spawn', payload: { name: 'worker', parent: 'main', task: 'worker' } },
    start(2, 'worker', 'Read', 'tu9'),
    end(3, 'worker', 'Read', 'tu9', true, 'boom'),
  ])
  const steps = causalChain({
    agentId: k('worker'), toolUseId: 'tu9', errorText: 'boom',
    agents: st.agents, conversations: st.conversations, droppedMessages: st.droppedMessages, edges: st.edges,
  })
  const last = steps[steps.length - 1]
  assert.equal(last.kind, 'break')
  assert.ok(!steps.some(s => s.kind === 'prompt'))
})

test('a failure in the main agent goes straight to its prompt; no prompt before it is unknown', () => {
  const st = withSession([spawnMain, msg(1, 'main', 'user', 'run it'), start(2, 'main', 'Bash', 'tu1'), end(3, 'main', 'Bash', 'tu1', true, 'exit 1')])
  const input = { agentId: k('main'), toolUseId: 'tu1', errorText: 'exit 1', agents: st.agents, conversations: st.conversations, droppedMessages: st.droppedMessages, edges: st.edges }
  const steps = causalChain(input)
  assert.deepEqual(steps.map(s => s.kind), ['failure', 'reasoning', 'prompt'])
  const st2 = withSession([spawnMain, start(2, 'main', 'Bash', 'tu1'), end(3, 'main', 'Bash', 'tu1', true, 'exit 1')])
  const steps2 = causalChain({ ...input, conversations: st2.conversations, droppedMessages: st2.droppedMessages })
  const last = steps2[steps2.length - 1]
  assert.equal(last.kind, 'prompt-unknown')
})

test('a cyclic parent chain terminates', () => {
  const st = withSession(delegated)
  const agents = new Map(st.agents)
  const main = agents.get(k('main'))!
  agents.set(k('main'), { ...main, isMain: false, parentId: k('worker'), toolUseId: 'disp1' })
  const steps = causalChain({
    agentId: k('worker'), toolUseId: 'tu9', errorText: 'e',
    agents, conversations: st.conversations, droppedMessages: st.droppedMessages, edges: st.edges,
  })
  assert.ok(steps.length < 20)
})
