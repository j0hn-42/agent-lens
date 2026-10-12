/**
 * Unit tests for GeminiEventParser (#238).
 *
 * Feeds a synthetic, anonymised Gemini CLI chat file (format of chatRecordingService.ts and
 * chatRecordingTypes.ts, google-gemini/gemini-cli) through the parser: header, messages that are
 * appended again whenever they change (one id, several lines), paired tool calls, the `$set`,
 * `$patch` and `$rewindTo` mutations, partial lines, unknown records, and the absence of any
 * version field.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  GeminiEventParser,
  createGeminiEventState,
  geminiProjectHash,
  type GeminiParserDelegate,
} from '../src/gemini-event-parser'
import type { AgentEvent } from '../src/protocol'

function runLines(lines: string[]) {
  const events: AgentEvent[] = []
  const labels: string[] = []
  const delegate: GeminiParserDelegate = {
    emit: (e) => events.push(e),
    elapsed: () => 0,
    setLabel: (l) => labels.push(l),
  }
  const parser = new GeminiEventParser(delegate)
  const state = createGeminiEventState()
  for (const line of lines) parser.processLine(line, state)
  return { events, labels, state, parser }
}

function runFixture() {
  const file = path.join(__dirname, 'fixtures', 'gemini-sample.jsonl')
  return runLines(fs.readFileSync(file, 'utf-8').split('\n'))
}

const HEADER = JSON.stringify({ sessionId: 'sid-1', projectHash: 'h', startTime: '2026-10-12T09:00:00.000Z' })
const gemini = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, timestamp: 't', type: 'gemini', content: '', thoughts: [], tokens: null, model: 'gemini-x', ...over })
const call = (id: string, status: string, over: Record<string, unknown> = {}) =>
  ({ id, name: 'run_shell_command', args: { command: 'ls' }, status, timestamp: 't', ...over })

describe('geminiProjectHash', () => {
  it('is the sha256 hex of the project root, as getProjectHash in gemini-cli utils/paths.ts', () => {
    assert.equal(geminiProjectHash('/work/app'), '70467eff2e0a236497f0693901c782c674520c598f57e72b22e636e00311bd81')
  })
})

describe('GeminiEventParser', () => {
  it('emits one main orchestrator spawn tagged gemini, and never a sub-agent', () => {
    const { events } = runFixture()
    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].payload.isMain, true)
    assert.equal(spawns[0].payload.runtime, 'gemini')
    assert.equal(events.filter(e => e.type === 'subagent_dispatch').length, 0)
  })

  it('reads the header: session id and project hash (there is no version field)', () => {
    const { state } = runFixture()
    assert.equal(state.sessionId, '9c1d2e3f-0000-4000-8000-000000000001')
    assert.equal(state.projectHash, geminiProjectHash('/work/app'))
  })

  it('takes the model from each gemini message, once per change', () => {
    const { events } = runFixture()
    const models = events.filter(e => e.type === 'model_detected').map(e => e.payload.model)
    assert.deepEqual(models, ['gemini-2.5-pro', 'gemini-2.5-flash'])
  })

  it('shows prompts and replies once although a message is appended again; slash commands are not prompts', () => {
    const { events } = runFixture()
    const texts = events.filter(e => e.type === 'message').map(e => [e.payload.role, e.payload.content])
    assert.deepEqual(texts, [
      ['user', 'Add a retry to the fetch helper'],
      ['thinking', 'Locating the helper: Find where fetch is wrapped.'],
      ['assistant', "I'll wrap it in a retry."],
      ['user', 'Revert that'],
      ['assistant', 'Reverted.'],
      ['user', 'Also add tests'],
    ])
  })

  it('pairs each tool call with its end, from the status written in the file', () => {
    const { events } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start')
    const ends = events.filter(e => e.type === 'tool_call_end')
    assert.deepEqual(starts.map(e => [e.payload.toolUseId, e.payload.tool]), [
      ['call-1', 'read_file'], ['call-2', 'run_shell_command'], ['call-3', 'glob'],
    ])
    assert.deepEqual(ends.map(e => e.payload.toolUseId), ['call-1', 'call-2', 'call-3'])
    assert.equal(ends[0].payload.isError, undefined)
    assert.match(String(ends[0].payload.result), /fetchJson/)
    assert.equal(ends[1].payload.isError, true)
    assert.match(String(ends[1].payload.result), /2 tests failed/)
    assert.equal(ends[2].payload.isError, true, 'a cancelled call did not succeed')
  })

  it('shows no tool end while the call is still executing', () => {
    const { events } = runLines([HEADER, gemini('g', { toolCalls: [call('c1', 'executing')] })])
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
    assert.equal(events.filter(e => e.type === 'tool_call_end').length, 0)
  })

  it('labels from the first prompt, then from the summary set by $set', () => {
    const { labels } = runFixture()
    assert.deepEqual(labels, ['Add a retry to the fetch helper', 'Retry helper'])
  })

  it('does not read tokens or cost, and shows no context event', () => {
    const { events } = runFixture()
    assert.equal(events.filter(e => e.type === 'context_update' || e.type === 'context_compacted').length, 0)
    for (const e of events) assert.equal(JSON.stringify(e.payload).includes('"cost"'), false)
  })

  it('a $rewindTo forgets the rewound messages without retracting what was shown', () => {
    const { events, state } = runFixture()
    assert.ok(events.some(e => e.payload.content === 'Reverted.'))
    assert.equal(state.messageOrder.includes('m-u3'), false)
    assert.equal(state.messageOrder.includes('m-g3'), false)
    assert.ok(state.messageOrder.includes('m-u1'))
  })

  it('an unknown $rewindTo id clears the remembered messages', () => {
    const { state } = runLines([HEADER, gemini('g', { content: 'hi' }), JSON.stringify({ $rewindTo: 'nope' })])
    assert.deepEqual(state.messageOrder, [])
  })

  it('$patch removeIds forgets those messages; a content patch is not re-emitted', () => {
    const { events, state } = runLines([
      HEADER, gemini('g', { content: 'first' }),
      JSON.stringify({ $patch: { id: 'g', content: 'changed' } }),
      JSON.stringify({ $patch: { removeIds: ['g'] } }),
    ])
    assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.payload.content), ['first'])
    assert.deepEqual(state.messageOrder, [])
  })

  it('a tool call patched after it ended does not end it twice', () => {
    const lines = [
      HEADER,
      gemini('g', { toolCalls: [call('c1', 'success')] }),
      JSON.stringify({ $patch: { id: 'g', toolCalls: [{ id: 'c1', result: 'late' }] } }),
    ]
    const { events } = runLines(lines)
    assert.equal(events.filter(e => e.type === 'tool_call_end').length, 1)
  })

  it('ignores a partial or malformed line, and recovers on the next one', () => {
    const { events } = runLines([HEADER, '{"id":"u1","type":"user","con', '', 'not json', gemini('g', { content: 'ok' })])
    assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.payload.content), ['ok'])
  })

  it('ignores unknown message types and records without an id', () => {
    const { events } = runLines([
      HEADER,
      JSON.stringify({ id: 'x', type: 'something_new', content: 'x' }),
      JSON.stringify({ kind: 'metrics', n: 1 }),
      JSON.stringify({ $future: { a: 1 } }),
    ])
    assert.equal(events.length, 0)
  })

  it('reads a file that carries no header at all by its messages (no version to check)', () => {
    const { events, state } = runLines([gemini('g', { content: 'hello' })])
    assert.equal(state.sessionId, null)
    assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.payload.content), ['hello'])
  })

  it('ignores system context injected as a user message and info, error and warning messages', () => {
    const user = (id: string, content: string) => JSON.stringify({ id, type: 'user', timestamp: 't', content })
    const { events } = runLines([
      HEADER, user('a', '<session_context>x</session_context>'), user('b', '<hook_context>y'), user('c', '   '),
      JSON.stringify({ id: 'd', type: 'error', content: 'boom' }),
      JSON.stringify({ id: 'e', type: 'warning', content: 'warn' }),
    ])
    assert.equal(events.length, 0)
  })

  it('bounds the remembered messages', () => {
    const lines = [HEADER]
    for (let i = 0; i < 6000; i++) lines.push(gemini(`g${i}`, { content: `m${i}` }))
    const { state } = runLines(lines)
    assert.ok(state.messageOrder.length <= 5000)
    assert.ok(state.messages.size <= 5000)
  })

  it('refuses a message with an oversized id', () => {
    const { events } = runLines([HEADER, gemini('x'.repeat(500), { content: 'nope' })])
    assert.equal(events.filter(e => e.type === 'message').length, 0)
  })

  it('does not take a missing model for a model', () => {
    const { events } = runLines([HEADER, gemini('g', { content: 'hi', model: undefined })])
    assert.equal(events.filter(e => e.type === 'model_detected').length, 0)
  })
})
