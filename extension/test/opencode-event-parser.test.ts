/**
 * Unit tests for OpenCodeEventParser (#346).
 *
 * Feeds synthetic rows of OpenCode's SQLite tables (session, message, part; shapes of OpenCode
 * v1.19.0 packages/core/src/session/sql.ts and packages/schema/src/v1/session.ts) through the
 * parser and asserts the resulting event stream: orchestrator spawn, labels, model, messages,
 * tool calls keyed on their final state, sub-agents from child sessions, tokens, compaction,
 * errors, end of turn, and dedup of rows read again after an in-place update.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OpenCodeEventParser,
  createOpenCodeEventState,
  type OpenCodeParserDelegate,
  type OpenCodeSessionRow,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
} from '../src/opencode-event-parser'
import type { AgentEvent } from '../src/protocol'

const ROOT = 'ses_root'

function session(over: Partial<OpenCodeSessionRow> = {}): OpenCodeSessionRow {
  return {
    id: ROOT, parent_id: null, directory: '/work/app', title: 'Fix the login form',
    agent: 'build', time_created: 1000, time_updated: 1000, ...over,
  }
}

function message(id: string, data: Record<string, unknown>, sessionId = ROOT): OpenCodeMessageRow {
  return { id, session_id: sessionId, time_created: 1000, time_updated: 1000, data: JSON.stringify(data) }
}

function part(id: string, messageId: string, data: Record<string, unknown>, sessionId = ROOT): OpenCodePartRow {
  return { id, message_id: messageId, session_id: sessionId, time_created: 1000, time_updated: 1000, data: JSON.stringify(data) }
}

function assistant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant', modelID: 'claude-sonnet-4', providerID: 'anthropic', agent: 'build',
    parentID: 'msg_user', time: { created: 1000 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    path: { cwd: '/work/app', root: '/work/app' }, ...over,
  }
}

function tool(callID: string, name: string, state: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool', callID, tool: name, state }
}

function setup(root = ROOT) {
  const events: AgentEvent[] = []
  const labels: string[] = []
  const delegate: OpenCodeParserDelegate = {
    emit: e => events.push(e),
    elapsed: () => 0,
    setLabel: l => labels.push(l),
  }
  const parser = new OpenCodeEventParser(delegate)
  const state = createOpenCodeEventState(root)
  return { events, labels, parser, state }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

describe('OpenCodeEventParser: root session', () => {
  it('spawns the orchestrator once, with the opencode runtime, and keeps the cwd', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processSession(session({ time_updated: 2000 }), state)
    const spawns = ofType(events, 'agent_spawn')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].payload.name, 'orchestrator')
    assert.equal(spawns[0].payload.isMain, true)
    assert.equal(spawns[0].payload.runtime, 'opencode')
    assert.equal(state.cwd, '/work/app')
  })

  it('labels the session with its title and follows a later rename', () => {
    const { labels, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processSession(session({ title: 'Fix the login form' }), state)
    parser.processSession(session({ title: 'Login form: validation' }), state)
    assert.deepEqual(labels, ['Fix the login form', 'Login form: validation'])
  })

  it('ignores the default title and labels the session with the first prompt instead', () => {
    const { labels, parser, state } = setup()
    parser.processSession(session({ title: 'New session - 2026-10-12T10:00:00.000Z' }), state)
    parser.processMessage(message('msg_user', { role: 'user', time: { created: 1000 }, agent: 'build' }), state)
    parser.processPart(part('prt_1', 'msg_user', { type: 'text', text: 'Add a dark mode toggle' }), state)
    parser.processPart(part('prt_2', 'msg_user', { type: 'text', text: 'and a second prompt' }), state)
    assert.deepEqual(labels, ['Add a dark mode toggle'])
    // A generated title then wins over the prompt
    parser.processSession(session({ title: 'Dark mode toggle' }), state)
    assert.deepEqual(labels, ['Add a dark mode toggle', 'Dark mode toggle'])
  })

  it('ignores a session that is neither the root nor a child of a known session', () => {
    const { events, parser, state } = setup()
    parser.processSession(session({ id: 'ses_other' }), state)
    parser.processSession(session({ id: 'ses_orphan', parent_id: 'ses_unknown' }), state)
    assert.equal(events.length, 0)
  })
})

describe('OpenCodeEventParser: messages', () => {
  it('emits user text and finished assistant text and reasoning, once each', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processMessage(message('msg_user', { role: 'user', time: { created: 1000 }, agent: 'build' }), state)
    parser.processPart(part('prt_u', 'msg_user', { type: 'text', text: 'Fix it' }), state)
    parser.processPart(part('prt_u', 'msg_user', { type: 'text', text: 'Fix it' }), state)
    // Synthetic parts are injected by OpenCode (file contents, reminders): not typed by the user
    parser.processPart(part('prt_s', 'msg_user', { type: 'text', text: '<file>...</file>', synthetic: true }), state)

    parser.processMessage(message('msg_a', assistant()), state)
    // Reasoning and text still streaming (no time.end): not durable yet, not shown
    parser.processPart(part('prt_r', 'msg_a', { type: 'reasoning', text: 'Look at', time: { start: 1 } }), state)
    parser.processPart(part('prt_t', 'msg_a', { type: 'text', text: '', time: { start: 1 } }), state)
    parser.processPart(part('prt_r', 'msg_a', { type: 'reasoning', text: 'Look at the form', time: { start: 1, end: 2 } }), state)
    parser.processPart(part('prt_t', 'msg_a', { type: 'text', text: 'Done.', time: { start: 2, end: 3 } }), state)
    parser.processPart(part('prt_t', 'msg_a', { type: 'text', text: 'Done.', time: { start: 2, end: 3 } }), state)

    const messages = ofType(events, 'message').map(e => [e.payload.role, e.payload.content])
    assert.deepEqual(messages, [['user', 'Fix it'], ['thinking', 'Look at the form'], ['assistant', 'Done.']])
  })

  it('ignores a part whose message is unknown', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processPart(part('prt_x', 'msg_missing', { type: 'text', text: 'hello', time: { start: 1, end: 2 } }), state)
    assert.equal(ofType(events, 'message').length, 0)
  })

  it('emits model_detected on the first assistant message and on each change', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processMessage(message('msg_a1', assistant()), state)
    parser.processMessage(message('msg_a1', assistant()), state)
    parser.processMessage(message('msg_a2', assistant({ modelID: 'gpt-5' })), state)
    assert.deepEqual(ofType(events, 'model_detected').map(e => e.payload.model), ['claude-sonnet-4', 'gpt-5'])
  })

  it('reports the context size from the tokens OpenCode wrote, only when it changes', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processMessage(message('msg_a', assistant()), state)
    const tokens = { input: 1200, output: 300, reasoning: 50, cache: { read: 8000, write: 450 } }
    parser.processMessage(message('msg_a', assistant({ tokens })), state)
    parser.processMessage(message('msg_a', assistant({ tokens })), state)
    const updates = ofType(events, 'context_update')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].payload.agent, 'orchestrator')
    assert.equal(updates[0].payload.tokens, 10000)
    assert.equal(updates[0].payload.tokenSource, 'reported')
    // No context window in the database: no maximum is made up
    assert.equal('tokensMax' in updates[0].payload, false)
  })

  it('ends the turn when an assistant message completes without asking for tools', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processMessage(message('msg_a1', assistant({ time: { created: 1, completed: 2 }, finish: 'tool-calls' })), state)
    assert.equal(ofType(events, 'agent_idle').length, 0)
    parser.processMessage(message('msg_a2', assistant({ time: { created: 3 } })), state)
    assert.equal(ofType(events, 'agent_idle').length, 0)
    parser.processMessage(message('msg_a2', assistant({ time: { created: 3, completed: 4 }, finish: 'stop' })), state)
    parser.processMessage(message('msg_a2', assistant({ time: { created: 3, completed: 4 }, finish: 'stop' })), state)
    const idles = ofType(events, 'agent_idle')
    assert.equal(idles.length, 1)
    assert.deepEqual(idles[0].payload, { name: 'orchestrator', turnEnd: true })
  })

  it('reports an assistant error once, with OpenCode name and message', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    const error = { name: 'APIError', data: { message: 'rate limited', statusCode: 429 } }
    parser.processMessage(message('msg_a', assistant({ error })), state)
    parser.processMessage(message('msg_a', assistant({ error })), state)
    const errors = ofType(events, 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].payload.agent, 'orchestrator')
    assert.equal(errors[0].payload.name, 'APIError')
    assert.equal(errors[0].payload.message, 'rate limited')
  })

  it('reports a compaction part with its trigger', () => {
    const { events, parser, state } = setup()
    parser.processSession(session(), state)
    parser.processMessage(message('msg_c', { role: 'user', time: { created: 1 }, agent: 'build' }), state)
    parser.processPart(part('prt_c', 'msg_c', { type: 'compaction', auto: true }), state)
    parser.processPart(part('prt_c', 'msg_c', { type: 'compaction', auto: true }), state)
    const compactions = ofType(events, 'context_compacted')
    assert.equal(compactions.length, 1)
    assert.deepEqual(compactions[0].payload, { agent: 'orchestrator', trigger: 'auto' })
  })
})

describe('OpenCodeEventParser: tools', () => {
  function withAssistant() {
    const ctx = setup()
    ctx.parser.processSession(session(), ctx.state)
    ctx.parser.processMessage(message('msg_a', assistant()), ctx.state)
    return ctx
  }

  it('starts a call once it is running and ends it once completed, across in-place updates', () => {
    const { events, parser, state } = withAssistant()
    // pending: the input is not known yet, nothing to show
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', { status: 'pending', input: {}, raw: '' })), state)
    assert.equal(ofType(events, 'tool_call_start').length, 0)
    const input = { command: 'pnpm test', description: 'Run tests' }
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', { status: 'running', input, time: { start: 10 } })), state)
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', { status: 'running', input, time: { start: 10 } })), state)
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', {
      status: 'completed', input, output: 'all tests passed', title: 'Run tests', metadata: {}, time: { start: 10, end: 20 },
    })), state)
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', {
      status: 'completed', input, output: 'all tests passed', title: 'Run tests', metadata: {}, time: { start: 10, end: 20 },
    })), state)

    const starts = ofType(events, 'tool_call_start')
    const ends = ofType(events, 'tool_call_end')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.equal(starts[0].payload.tool, 'bash')
    assert.equal(starts[0].payload.toolUseId, 'call_1')
    assert.match(String(starts[0].payload.args), /pnpm test/)
    assert.equal(ends[0].payload.toolUseId, 'call_1')
    assert.match(String(ends[0].payload.result), /all tests passed/)
    assert.equal(ends[0].payload.isError, undefined)
  })

  it('reads the filePath argument of OpenCode file tools', () => {
    const { events, parser, state } = withAssistant()
    parser.processPart(part('prt_r', 'msg_a', tool('call_r', 'read', { status: 'running', input: { filePath: '/work/app/src/login.ts' }, time: { start: 1 } })), state)
    assert.match(String(ofType(events, 'tool_call_start')[0].payload.args), /login\.ts/)
  })

  it('marks a failed call as an error with OpenCode error text', () => {
    const { events, parser, state } = withAssistant()
    parser.processPart(part('prt_e', 'msg_a', tool('call_e', 'edit', {
      status: 'error', input: { filePath: '/work/app/a.ts' }, error: 'oldString not found', time: { start: 1, end: 2 },
    })), state)
    // A call seen for the first time in a final state still starts before it ends
    assert.deepEqual(events.filter(e => e.type.startsWith('tool_call')).map(e => e.type), ['tool_call_start', 'tool_call_end'])
    const end = ofType(events, 'tool_call_end')[0]
    assert.equal(end.payload.isError, true)
    assert.match(String(end.payload.errorMessage), /oldString not found/)
  })

  it('never reports a permission request: a call waiting for one stays running', () => {
    const { events, parser, state } = withAssistant()
    parser.processPart(part('prt_t', 'msg_a', tool('call_1', 'bash', { status: 'running', input: { command: 'rm -rf dist' }, time: { start: 1 } })), state)
    assert.equal(ofType(events, 'permission_requested').length, 0)
  })

  it('counts a part with invalid JSON as malformed and keeps going', () => {
    const { events, parser, state } = withAssistant()
    parser.processPart({ ...part('prt_bad', 'msg_a', {}), data: '{not json' }, state)
    parser.processPart(part('prt_ok', 'msg_a', { type: 'text', text: 'still here', time: { start: 1, end: 2 } }), state)
    assert.equal(parser.normalizer.stats.malformed, 1)
    assert.equal(ofType(events, 'message').length, 1)
  })
})

describe('OpenCodeEventParser: sub-agents', () => {
  const CHILD = 'ses_child'

  function withTask() {
    const ctx = setup()
    ctx.parser.processSession(session(), ctx.state)
    ctx.parser.processMessage(message('msg_a', assistant()), ctx.state)
    const input = { description: 'Explore the auth module', prompt: 'Find where tokens are checked', subagent_type: 'explore' }
    ctx.parser.processPart(part('prt_task', 'msg_a', tool('call_task', 'task', { status: 'running', input, time: { start: 1 } })), ctx.state)
    ctx.parser.processSession(session({
      id: CHILD, parent_id: ROOT, agent: 'explore', title: 'Explore the auth module (@explore subagent)',
    }), ctx.state)
    ctx.parser.processPart(part('prt_task', 'msg_a', tool('call_task', 'task', {
      status: 'running', input, title: 'Explore the auth module', metadata: { sessionId: CHILD }, time: { start: 1 },
    })), ctx.state)
    return { ...ctx, input }
  }

  it('spawns a child session as a sub-agent of its parent session agent, once', () => {
    const { events, parser, state } = withTask()
    parser.processSession(session({ id: CHILD, parent_id: ROOT, agent: 'explore', time_updated: 5000 }), state)
    const dispatches = ofType(events, 'subagent_dispatch')
    const spawns = ofType(events, 'agent_spawn').filter(e => e.payload.name !== 'orchestrator')
    assert.equal(dispatches.length, 1)
    assert.equal(spawns.length, 1)
    assert.equal(dispatches[0].payload.parent, 'orchestrator')
    assert.equal(dispatches[0].payload.child, 'explore')
    assert.equal(spawns[0].payload.parent, 'orchestrator')
    assert.equal(spawns[0].payload.runtime, 'opencode')
    assert.equal(spawns[0].payload.subagentType, 'explore')
  })

  it('attributes the messages and tool calls of a child session to the sub-agent', () => {
    const { events, parser, state } = withTask()
    parser.processMessage(message('msg_c', assistant({ agent: 'explore', modelID: 'claude-haiku-4' }), CHILD), state)
    parser.processPart(part('prt_g', 'msg_c', tool('call_g', 'grep', { status: 'running', input: { pattern: 'verifyToken' }, time: { start: 1 } }), CHILD), state)
    parser.processPart(part('prt_ct', 'msg_c', { type: 'text', text: 'Found it in auth.ts', time: { start: 1, end: 2 } }, CHILD), state)
    const model = ofType(events, 'model_detected').find(e => e.payload.model === 'claude-haiku-4')
    assert.equal(model?.payload.agent, 'explore')
    assert.equal(ofType(events, 'tool_call_start').find(e => e.payload.toolUseId === 'call_g')?.payload.agent, 'explore')
    assert.equal(ofType(events, 'message').at(-1)?.payload.agent, 'explore')
  })

  it('returns and completes the sub-agent when the task call of its parent finishes', () => {
    const { events, parser, state, input } = withTask()
    parser.processPart(part('prt_task', 'msg_a', tool('call_task', 'task', {
      status: 'completed', input, output: 'Tokens are checked in auth.ts', title: 'Explore the auth module',
      metadata: { sessionId: CHILD }, time: { start: 1000, end: 4000 },
    })), state)
    const returns = ofType(events, 'subagent_return')
    assert.equal(returns.length, 1)
    assert.equal(returns[0].payload.child, 'explore')
    assert.equal(returns[0].payload.parent, 'orchestrator')
    assert.equal(returns[0].payload.toolUseId, 'call_task')
    assert.equal(returns[0].payload.isError, false)
    assert.equal(returns[0].payload.durationS, 3)
    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload.name), ['explore'])
  })

  it('reports a failed task call as a failed return', () => {
    const { events, parser, state, input } = withTask()
    parser.processPart(part('prt_task', 'msg_a', tool('call_task', 'task', {
      status: 'error', input, error: 'aborted', metadata: { sessionId: CHILD }, time: { start: 1, end: 2 },
    })), state)
    assert.equal(ofType(events, 'subagent_return')[0].payload.isError, true)
  })

  it('never completes the root session: its end is not written in the database', () => {
    const { events, parser, state } = withTask()
    parser.processMessage(message('msg_end', assistant({ time: { created: 1, completed: 2 }, finish: 'stop' })), state)
    assert.equal(ofType(events, 'agent_complete').filter(e => e.payload.name === 'orchestrator').length, 0)
  })

  it('gives two sub-agents of the same kind distinct names', () => {
    const { events, parser, state } = withTask()
    parser.processSession(session({ id: 'ses_child2', parent_id: ROOT, agent: 'explore', title: 'Second (@explore subagent)' }), state)
    const names = ofType(events, 'agent_spawn').map(e => e.payload.name)
    assert.deepEqual(names, ['orchestrator', 'explore', 'explore #2'])
  })
})
