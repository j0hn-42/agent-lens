/**
 * Unit tests for CopilotEventParser.
 *
 * Feeds a hand-crafted events.jsonl fixture through the parser and asserts the resulting event
 * stream: orchestrator spawn, model detection, messages (no injected content), tool calls and
 * their results, sub-agent lifecycle and attribution, dedup of replayed lines, and tolerance to
 * unknown or malformed lines.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CopilotEventParser,
  createCopilotEventState,
  type CopilotParserDelegate,
} from '../src/copilot-event-parser'
import type { AgentEvent } from '../src/protocol'

function runLines(lines: string[]) {
  const events: AgentEvent[] = []
  const labels: string[] = []
  const delegate: CopilotParserDelegate = {
    emit: (e) => events.push(e),
    elapsed: () => 0,
    setLabel: (l) => labels.push(l),
  }
  const parser = new CopilotEventParser(delegate)
  const state = createCopilotEventState()
  for (const line of lines) parser.processLine(line, state)
  return { events, labels, state, parser }
}

function runFixture() {
  const file = path.join(__dirname, 'fixtures', 'copilot-events-sample.jsonl')
  return runLines(fs.readFileSync(file, 'utf-8').split('\n'))
}

describe('CopilotEventParser', () => {
  it('emits one main orchestrator spawn tagged copilot', () => {
    const { events } = runFixture()
    const main = events.filter(e => e.type === 'agent_spawn' && e.payload.isMain)
    assert.equal(main.length, 1)
    assert.equal(main[0].payload.runtime, 'copilot')
  })

  it('detects the model from session.start and again when it changes', () => {
    const { events, state } = runFixture()
    const models = events.filter(e => e.type === 'model_detected').map(e => e.payload.model)
    assert.deepEqual(models, ['claude-sonnet-4.6', 'gpt-5'])
    assert.equal(state.model, 'gpt-5')
    assert.equal(state.cwd, '/work/app')
  })

  it('shows the user prompt, not the injected transformedContent, and labels the session from it', () => {
    const { events, labels } = runFixture()
    const user = events.filter(e => e.type === 'message' && e.payload.role === 'user')
    assert.equal(user.length, 1)
    assert.equal(user[0].payload.content, 'Add a retry to the fetch helper')
    assert.deepEqual(labels, ['Add a retry to the fetch helper'])
  })

  it('emits assistant text and thinking once, and ignores a replayed event id', () => {
    const { events } = runFixture()
    const assistant = events.filter(e => e.type === 'message' && e.payload.role === 'assistant')
    assert.deepEqual(assistant.map(e => e.payload.content), ["I'll look at the helper first.", 'Added a retry with backoff.'])
    const thinking = events.filter(e => e.type === 'message' && e.payload.role === 'thinking')
    assert.deepEqual(thinking.map(e => e.payload.content), ['Find where fetch is wrapped.'])
  })

  it('emits each tool call once (toolRequests are not a second source) with its result', () => {
    const { events } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.agent === 'orchestrator')
    assert.deepEqual(starts.map(e => e.payload.tool), ['view', 'bash', 'task', 'report_intent'])
    assert.equal(starts[0].payload.args, 'src/fetch.ts')
    assert.equal(starts[1].payload.args, 'pnpm test')
    const view = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'view')
    assert.match(String(view?.payload.result), /return fetch/)
    assert.equal(view?.payload.isError, undefined)
  })

  it('flags a failed tool call and keeps the error message', () => {
    const { events } = runFixture()
    const bash = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'bash')
    assert.equal(bash?.payload.isError, true)
    assert.match(String(bash?.payload.errorMessage), /2 tests failed/)
  })

  it('spawns a sub-agent under the orchestrator from subagent.started and completes it', () => {
    const { events } = runFixture()
    const dispatch = events.find(e => e.type === 'subagent_dispatch')
    assert.equal(dispatch?.payload.parent, 'orchestrator')
    assert.equal(dispatch?.payload.child, 'Explore Agent')
    assert.equal(dispatch?.payload.toolUseId, 't3')
    const spawn = events.find(e => e.type === 'agent_spawn' && e.payload.name === 'Explore Agent')
    assert.equal(spawn?.payload.parent, 'orchestrator')
    assert.equal(spawn?.payload.subagentType, 'explore')
    const ret = events.find(e => e.type === 'subagent_return')
    assert.equal(ret?.payload.child, 'Explore Agent')
    assert.equal(ret?.payload.isError, false)
    assert.ok(events.some(e => e.type === 'agent_complete' && e.payload.name === 'Explore Agent'))
  })

  it('attributes a tool call to a sub-agent only when parentToolCallId names it', () => {
    const { events } = runFixture()
    const grep = events.find(e => e.type === 'tool_call_start' && e.payload.tool === 'grep')
    assert.equal(grep?.payload.agent, 'Explore Agent')
    const grepEnd = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'grep')
    assert.equal(grepEnd?.payload.agent, 'Explore Agent')
    // Everything else stays on the orchestrator
    const others = events.filter(e => e.type === 'tool_call_start' && e.payload.tool !== 'grep')
    assert.ok(others.every(e => e.payload.agent === 'orchestrator'))
  })

  it('marks a failed sub-agent as an error return', () => {
    const { events } = runLines([
      JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'x', agentName: 'review' }, id: 'a' }),
      JSON.stringify({ type: 'subagent.failed', data: { toolCallId: 'x', error: 'boom' }, id: 'b' }),
    ])
    const ret = events.find(e => e.type === 'subagent_return')
    assert.equal(ret?.payload.isError, true)
    assert.equal(ret?.payload.summary, 'boom')
  })

  it('keeps sub-agent names unique when the same agent runs twice', () => {
    const { events } = runLines([
      JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'x', agentName: 'explore' }, id: 'a' }),
      JSON.stringify({ type: 'subagent.started', data: { toolCallId: 'y', agentName: 'explore' }, id: 'b' }),
    ])
    const names = events.filter(e => e.type === 'agent_spawn' && !e.payload.isMain).map(e => e.payload.name)
    assert.deepEqual(names, ['explore', 'explore #2'])
  })

  it('does not invent a sub-agent from a task tool call alone', () => {
    const { events } = runLines([
      JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'task', arguments: { description: 'x' } }, id: 'a' }),
    ])
    assert.equal(events.filter(e => e.type === 'agent_spawn' && !e.payload.isMain).length, 0)
  })

  it('survives unknown event types and malformed lines', () => {
    const { events, parser } = runFixture()
    assert.ok(events.length > 0)
    assert.ok(parser.normalizer.stats.malformed >= 1)
  })

  it('ignores a tool result with no matching start', () => {
    const { events } = runLines([
      JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'ghost', success: true }, id: 'a' }),
    ])
    assert.equal(events.filter(e => e.type === 'tool_call_end').length, 0)
  })
})
