/**
 * Unit tests for PiEventParser (#238).
 *
 * Feeds a synthetic, anonymised Pi session file (format of pi's docs/session-format.md, v3) through
 * the parser and asserts the resulting event stream: orchestrator spawn, model taken from the
 * assistant messages only, messages, paired tool calls, compaction, labels, dedup of replayed
 * entries, tolerance to unknown or malformed lines, and refusal of an unknown header version.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PiEventParser,
  createPiEventState,
  type PiParserDelegate,
} from '../src/pi-event-parser'
import type { AgentEvent } from '../src/protocol'

function runLines(lines: string[]) {
  const events: AgentEvent[] = []
  const labels: string[] = []
  const warnings: string[] = []
  const delegate: PiParserDelegate = {
    emit: (e) => events.push(e),
    elapsed: () => 0,
    setLabel: (l) => labels.push(l),
    warn: (m) => warnings.push(m),
  }
  const parser = new PiEventParser(delegate)
  const state = createPiEventState()
  for (const line of lines) parser.processLine(line, state)
  return { events, labels, warnings, state, parser }
}

function runFixture() {
  const file = path.join(__dirname, 'fixtures', 'pi-session-sample.jsonl')
  return runLines(fs.readFileSync(file, 'utf-8').split('\n'))
}

const header = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id: 'sid', timestamp: '2026-10-12T09:00:00.000Z', cwd: '/w', ...over })
const userLine = (id: string | undefined, content: unknown) =>
  JSON.stringify({ type: 'message', ...(id ? { id, parentId: null } : {}), timestamp: '2026-10-12T09:00:01.000Z', message: { role: 'user', content, timestamp: 1 } })

describe('PiEventParser', () => {
  it('emits one main orchestrator spawn tagged pi, and never a sub-agent', () => {
    const { events } = runFixture()
    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].payload.isMain, true)
    assert.equal(spawns[0].payload.runtime, 'pi')
    assert.equal(events.filter(e => e.type === 'subagent_dispatch').length, 0)
  })

  it('reads the header: version and cwd', () => {
    const { state } = runFixture()
    assert.equal(state.version, 3)
    assert.equal(state.cwd, '/work/app')
  })

  it('takes the model from assistant messages only, not from a model_change selection', () => {
    const { events, state } = runFixture()
    const models = events.filter(e => e.type === 'model_detected').map(e => e.payload.model)
    assert.deepEqual(models, ['claude-sonnet-4-5', 'gpt-5'])
    assert.equal(state.model, 'gpt-5')
  })

  it('shows user prompts (string or text blocks), labels from the first, then from the session name', () => {
    const { events, labels } = runFixture()
    const user = events.filter(e => e.type === 'message' && e.payload.role === 'user')
    assert.deepEqual(user.map(e => e.payload.content), ['Add a retry to the fetch helper', 'Also add tests'])
    assert.deepEqual(labels, ['Add a retry to the fetch helper', 'Retry helper'])
  })

  it('emits assistant text and non-empty thinking once, and ignores a replayed entry id', () => {
    const { events, parser } = runFixture()
    const assistant = events.filter(e => e.type === 'message' && e.payload.role === 'assistant')
    assert.deepEqual(assistant.map(e => e.payload.content), ["I'll look at the helper first.", 'Added a retry with backoff.'])
    const thinking = events.filter(e => e.type === 'message' && e.payload.role === 'thinking')
    assert.deepEqual(thinking.map(e => e.payload.content), ['Find where fetch is wrapped.'])
    assert.ok(parser.normalizer.stats.duplicateEvents >= 1)
  })

  it('pairs each toolCall block with its toolResult, summarising the arguments', () => {
    const { events } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start')
    assert.deepEqual(starts.map(e => e.payload.tool), ['read', 'bash'])
    assert.deepEqual(starts.map(e => e.payload.toolUseId), ['call_1', 'call_2'])
    assert.equal(starts[0].payload.args, 'src/fetch.ts')
    assert.equal(starts[1].payload.args, 'pnpm test')
    assert.ok(starts.every(e => e.payload.agent === 'orchestrator'))
    const read = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'read')
    assert.match(String(read?.payload.result), /return fetch/)
    assert.equal(read?.payload.isError, undefined)
    assert.equal(read?.payload.tokenSource, 'estimated')
  })

  it('flags a failed tool call from isError and keeps the message', () => {
    const { events } = runFixture()
    const bash = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'bash')
    assert.equal(bash?.payload.isError, true)
    assert.match(String(bash?.payload.errorMessage), /2 tests failed/)
  })

  it('reports a compaction with the size the file records', () => {
    const { events } = runFixture()
    const compacted = events.filter(e => e.type === 'context_compacted')
    assert.equal(compacted.length, 1)
    assert.equal(compacted[0].payload.preTokens, 50000)
    assert.equal(compacted[0].payload.trigger, undefined, 'the file does not say what triggered it')
  })

  it('ignores system messages, direct shell runs, extension messages and unknown entry types', () => {
    const { events } = runFixture()
    const contents = events.filter(e => e.type === 'message').map(e => String(e.payload.content))
    assert.ok(!contents.some(c => /expert coding assistant|Injected context/.test(c)))
    assert.equal(events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'ls').length, 0)
  })

  it('survives a partial (unterminated) line', () => {
    const { events, parser } = runFixture()
    assert.ok(events.length > 0)
    assert.ok(parser.normalizer.stats.malformed >= 1)
  })

  it('ignores a tool result with no matching call', () => {
    const { events } = runLines([
      header(),
      JSON.stringify({ type: 'message', id: 'x1', parentId: null, timestamp: 't', message: { role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [], isError: false, timestamp: 1 } }),
    ])
    assert.equal(events.filter(e => e.type === 'tool_call_end').length, 0)
  })

  it('emits nothing before a session header has been read', () => {
    const { events } = runLines([userLine('u1', 'hello')])
    assert.equal(events.length, 0)
  })

  it('emits nothing for an unknown header version, and says so once', () => {
    const { events, warnings, state } = runLines([header({ version: 4 }), userLine('u1', 'hello'), userLine('u2', 'again')])
    assert.equal(events.length, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /version/)
    assert.equal(state.unsupported, true)
  })

  it('also refuses a non-numeric version', () => {
    const { events } = runLines([header({ version: 'three' }), userLine('u1', 'hello')])
    assert.equal(events.length, 0)
  })

  it('reads a legacy v1 session (no version, entries without id)', () => {
    const { events, state } = runLines([header({ version: undefined }), userLine(undefined, 'legacy prompt')])
    assert.equal(state.version, 1)
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'legacy prompt'))
  })

  it('does not emit a model from model_change alone', () => {
    const { events } = runLines([
      header(),
      JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: 't', provider: 'openai', modelId: 'gpt-4o' }),
    ])
    assert.equal(events.filter(e => e.type === 'model_detected').length, 0)
  })

  it('caps the remembered entry ids and pending tool calls', () => {
    const lines = [header()]
    for (let i = 0; i < 6000; i++) {
      lines.push(JSON.stringify({ type: 'message', id: `e${i}`, parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: 'true' } }], model: 'm', timestamp: 1 } }))
    }
    const { state } = runLines(lines)
    assert.ok(state.seenEntryIds.size <= 5000)
    assert.ok(state.pendingToolCalls.size <= 5000)
  })
})
