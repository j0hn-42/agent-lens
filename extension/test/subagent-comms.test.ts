/**
 * Tests for inter-agent communication payloads (#39) and subagent identity (#35):
 * - isError comes from the structured is_error flag for Task/Agent results
 * - SubagentStop hook payloads carry toolUseId / durationS / tokenCost
 * - subagents are identified by tool_use_id, so same-description subagents stay distinct
 * - nested subagents resolve their real parent
 * - /events replay helpers
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Module from 'node:module'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, buildSubagentReport, type TranscriptParserDelegate } from '../src/transcript-parser'
import { SubagentRegistry } from '../src/subagent-registry'
import { scanSubagentsDir, resolveSubagentFileInfo, type SubagentWatcherDelegate } from '../src/subagent-watcher'
import { parseEventsUrl, buildReplayBatches } from '../src/event-replay'
import { MESSAGE_MAX } from '../src/constants'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<WatchedSession> = {}): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0,
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    ...overrides,
  }
}

function makeParser(session: WatchedSession) {
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (e) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  return { parser: new TranscriptParser(delegate), events }
}

function agentToolUse(id: string, description: string, prompt = 'do it') {
  return { type: 'tool_use' as const, id, name: 'Agent', input: { description, prompt, subagent_type: 'Explore' } }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

// ─── A: isError ─────────────────────────────────────────────────────────────

describe('subagent result error detection', () => {
  const report = 'The previous attempt failed, and config.json was not found; I fixed it. Error: handled.'

  it('does not flag a free-text subagent report as an error', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    const pending = new Map()
    parser.handleToolUse(agentToolUse('t1', 'Investigate'), 'orchestrator', pending, 's1')
    parser.handleToolResult({ type: 'tool_result', tool_use_id: 't1', content: report }, 'orchestrator', pending, 's1')
    const ret = ofType(events, 'subagent_return')[0].payload
    assert.equal(ret.isError, false)
    assert.equal(ret.summary, report)
    assert.equal(ofType(events, 'tool_call_end')[0].payload.isError, undefined)
  })

  it('flags a subagent result when the structured is_error flag is set', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    const pending = new Map()
    parser.handleToolUse(agentToolUse('t1', 'Investigate'), 'orchestrator', pending, 's1')
    parser.handleToolResult({ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }, 'orchestrator', pending, 's1')
    assert.equal(ofType(events, 'subagent_return')[0].payload.isError, true)
    assert.equal(ofType(events, 'tool_call_end')[0].payload.isError, true)
  })

  it('keeps heuristic detection for ordinary tools', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    const pending = new Map()
    parser.handleToolUse({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'foo' } }, 'orchestrator', pending, 's1')
    parser.handleToolResult({ type: 'tool_result', tool_use_id: 'b1', content: 'bash: foo: command not found' }, 'orchestrator', pending, 's1')
    assert.equal(ofType(events, 'tool_call_end')[0].payload.isError, true)
  })

  it('subagent_return carries full report, toolUseId, durationS and tokenCost', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    const pending = new Map()
    const long = 'x'.repeat(1500)
    parser.handleToolUse(agentToolUse('t9', 'Long'), 'orchestrator', pending, 's1')
    parser.handleToolResult({ type: 'tool_result', tool_use_id: 't9', content: long }, 'orchestrator', pending, 's1')
    const ret = ofType(events, 'subagent_return')[0].payload
    assert.equal((ret.summary as string).length, 1500)
    assert.equal(ret.toolUseId, 't9')
    assert.equal(typeof ret.durationS, 'number')
    assert.equal(typeof ret.tokenCost, 'number')
  })
})

// ─── B: hook SubagentStop ───────────────────────────────────────────────────

describe('SubagentStop hook payload', () => {
  const shim = {
    EventEmitter: class {
      private ls: Array<(d: unknown) => void> = []
      get event() { return (l: (d: unknown) => void) => { this.ls.push(l); return { dispose() {} } } }
      fire(d: unknown) { for (const l of this.ls) l(d) }
      dispose() {}
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M = Module as any
  const origLoad = M._load
  M._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? shim : origLoad.call(this, request, ...rest)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HookServer } = require('../src/hook-server') as typeof import('../src/hook-server')
  M._load = origLoad

  function run(payloads: Array<Record<string, unknown>>): AgentEvent[] {
    const server = new HookServer()
    const events: AgentEvent[] = []
    server.onEvent(e => events.push(e))
    for (const p of payloads) (server as unknown as { handleHook(p: unknown): void }).handleHook({ session_id: 's1', ...p })
    return events
  }

  it('correlates the dispatch by tool_use_id and reports duration/tokens', () => {
    const events = run([
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'Explore codebase', prompt: 'p', subagent_type: 'Explore' } },
      { hook_event_name: 'SubagentStart', agent_id: 'agent-abcdef', agent_type: 'Explore', tool_use_id: 'toolu_1' },
      { hook_event_name: 'SubagentStop', agent_id: 'agent-abcdef', agent_type: 'Explore', last_assistant_message: 'Full final report from the subagent.' },
    ])
    const ret = ofType(events, 'subagent_return')[0].payload
    assert.equal(ret.summary, 'Full final report from the subagent.')
    assert.equal(ret.toolUseId, 'toolu_1')
    assert.equal(typeof ret.durationS, 'number')
    assert.ok((ret.tokenCost as number) > 0)
    assert.equal(ret.isError, undefined)
  })

  it('correlates by agent type when the hook carries no tool_use_id, and honours is_error', () => {
    const events = run([
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'toolu_2', tool_input: { description: 'D', prompt: 'p', subagent_type: 'general-purpose' } },
      { hook_event_name: 'SubagentStart', agent_id: 'agent-zzzzzz', agent_type: 'general-purpose' },
      { hook_event_name: 'SubagentStop', agent_id: 'agent-zzzzzz', agent_type: 'general-purpose', is_error: true },
    ])
    const ret = ofType(events, 'subagent_return')[0].payload
    assert.equal(ret.toolUseId, 'toolu_2')
    assert.equal(ret.isError, true)
    assert.equal(ret.summary, 'general-purpose complete')
    assert.equal(ret.tokenCost, undefined)
  })

  it('PostToolUseFailure marks the call as an error with its toolUseId', () => {
    const events = run([{ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', tool_response: 'nope' }])
    const end = ofType(events, 'tool_call_end')[0].payload
    assert.equal(end.isError, true)
    assert.equal(end.toolUseId, 'b1')
  })
})

describe('buildSubagentReport', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('never reads a transcript path outside the allow-list', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-report-'))
    const file = path.join(dir, 'x.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'SECRET FROM FILE' } }) + '\n')
    assert.equal(buildSubagentReport({ agent_transcript_path: file }), undefined)
    assert.equal(buildSubagentReport({ agent_transcript_path: file, last_assistant_message: 'inline' }), 'inline')
  })

  it('caps the inline message at MESSAGE_MAX', () => {
    const out = buildSubagentReport({ last_assistant_message: 'y'.repeat(MESSAGE_MAX + 500) })
    assert.equal(out?.length, MESSAGE_MAX)
  })
})

// ─── C/D: dispatch payloads and identity ────────────────────────────────────

describe('subagent identity by tool_use_id', () => {
  it('two parallel subagents with the same description become two distinct agents', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    const pending = new Map()
    parser.handleToolUse(agentToolUse('tA', 'Explore codebase', 'prompt A'), 'orchestrator', pending, 's1')
    parser.handleToolUse(agentToolUse('tB', 'Explore codebase', 'prompt B'), 'orchestrator', pending, 's1')

    const spawns = ofType(events, 'agent_spawn').map(e => e.payload)
    assert.equal(spawns.length, 2)
    assert.notEqual(spawns[0].name, spawns[1].name)
    assert.equal(spawns[0].label, 'Explore codebase')
    assert.equal(spawns[1].label, 'Explore codebase')
    assert.deepEqual(spawns.map(s => s.toolUseId), ['tA', 'tB'])

    const dispatches = ofType(events, 'subagent_dispatch').map(e => e.payload)
    assert.deepEqual(dispatches.map(d => d.prompt), ['prompt A', 'prompt B'])

    // Results map back to the right child by tool_use_id
    parser.handleToolResult({ type: 'tool_result', tool_use_id: 'tB', content: 'done B' }, 'orchestrator', pending, 's1')
    const ret = ofType(events, 'subagent_return')[0].payload
    assert.equal(ret.child, spawns[1].name)
    assert.equal(ret.toolUseId, 'tB')
  })

  it('a nested subagent dispatch is attached to the subagent that issued it', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    parser.handleToolUse(agentToolUse('t1', 'Outer'), 'orchestrator', new Map(), 's1')
    const outer = ofType(events, 'agent_spawn')[0].payload.name as string
    parser.handleToolUse(agentToolUse('t2', 'Inner'), outer, new Map(), 's1')
    const inner = ofType(events, 'agent_spawn')[1].payload
    assert.equal(inner.parent, outer)
    assert.equal(ofType(events, 'subagent_dispatch')[1].payload.parent, outer)
  })

  it('payloads without ids keep working (registry-free fallback names)', () => {
    const session = makeSession()
    const { parser, events } = makeParser(session)
    parser.handleToolUse({ type: 'tool_use', id: 'x', name: 'Task', input: {} }, 'orchestrator', new Map(), 's1')
    assert.equal(ofType(events, 'agent_spawn')[0].payload.name, 'subagent')
  })
})

describe('SubagentRegistry', () => {
  it('suffixes colliding labels and binds a late dispatch to a file-first record', () => {
    const reg = new SubagentRegistry()
    const f1 = reg.claimForFile('a1', 'Explore codebase')
    const f2 = reg.claimForFile('a2', 'Explore codebase')
    assert.deepEqual([f1.name, f2.name], ['Explore codebase', 'Explore codebase #2'])
    const d1 = reg.registerDispatch('t1', 'Explore codebase', 'orchestrator')
    assert.equal(d1, f1)
    assert.equal(reg.registerDispatch('t1', 'Explore codebase', 'orchestrator'), f1)
  })

  it('claims by tool_use_id hint before label', () => {
    const reg = new SubagentRegistry()
    reg.registerDispatch('t1', 'Same', 'orchestrator')
    const second = reg.registerDispatch('t2', 'Same', 'orchestrator')
    const claimed = reg.claimForFile('file-b', 'Same', { toolUseId: 't2' })
    assert.equal(claimed, second)
  })
})

// ─── D: subagent files and nested parent ────────────────────────────────────

describe('subagent file watcher identity and parent', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  function setup(files: Record<string, { meta?: Record<string, unknown> }>) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-subs-'))
    const pendingLine = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'Read', input: {} }] } }) + '\n'
    for (const [name, spec] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, `${name}.jsonl`), pendingLine)
      if (spec.meta) fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify(spec.meta))
    }
    const session = makeSession({ subagentsDir: dir })
    const { parser, events } = makeParser(session)
    const delegate = {
      emit: (e: AgentEvent) => { events.push(e) },
      elapsed: () => 0,
      getSession: () => session,
      getLastActivityTime: () => 0,
      resetInactivityTimer: () => {},
    } as unknown as SubagentWatcherDelegate
    scanSubagentsDir(delegate, parser, 's1')
    for (const st of session.subagentWatchers.values()) st.watcher?.close()
    session.subagentsDirWatcher?.close()
    return { events, session }
  }

  it('two same-description subagent files spawn two distinct agents', () => {
    const { events } = setup({
      'agent-a1': { meta: { description: 'Explore codebase' } },
      'agent-a2': { meta: { description: 'Explore codebase' } },
    })
    const names = ofType(events, 'agent_spawn').map(e => e.payload.name)
    assert.equal(names.length, 2)
    assert.notEqual(names[0], names[1])
  })

  it('resolves the real parent of a nested subagent from its meta', () => {
    const { events } = setup({
      'agent-outer': { meta: { description: 'Outer' } },
      'agent-inner': { meta: { description: 'Inner', parentAgentId: 'outer' } },
    })
    const spawns = ofType(events, 'agent_spawn').map(e => e.payload)
    const outer = spawns.find(s => s.label === 'Outer')!
    const inner = spawns.find(s => s.label === 'Inner')!
    assert.equal(outer.parent, 'orchestrator')
    assert.equal(inner.parent, outer.name)
  })

  it('reads parentToolUseID from the first transcript entry when no meta exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-subs-'))
    const file = path.join(dir, 'agent-q.jsonl')
    fs.writeFileSync(file, JSON.stringify({ parentToolUseID: 'toolu_x', message: { role: 'user', content: 'hi' } }) + '\n')
    const info = resolveSubagentFileInfo(file, 3)
    assert.equal(info.agentId, 'q')
    assert.equal(info.toolUseId, 'toolu_x')
    assert.equal(info.label, 'subagent-3')
  })
})

// ─── E: relay replay helpers ────────────────────────────────────────────────

describe('relay /events replay', () => {
  const ev = (sessionId: string, n: number): AgentEvent => ({ time: n, type: 'message', payload: {}, sessionId })
  const buffers = new Map<string, AgentEvent[]>([
    ['a', [ev('a', 1), ev('a', 2)]],
    ['b', [ev('b', 1)]],
    ['empty', []],
  ])

  it('parses /events and ?session=', () => {
    assert.deepEqual(parseEventsUrl('/events'), { isEvents: true })
    assert.deepEqual(parseEventsUrl('/events?session=abc'), { isEvents: true, session: 'abc' })
    assert.equal(parseEventsUrl('/other?session=abc').isEvents, false)
    assert.equal(parseEventsUrl(undefined).isEvents, false)
    assert.equal(parseEventsUrl('/events?session=' + 'z'.repeat(500)).session, undefined)
  })

  it('replays only the requested session', () => {
    const batches = buildReplayBatches(buffers, { session: 'b' })
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0].events.map(e => e.sessionId), ['b'])
    assert.deepEqual(buildReplayBatches(buffers, { session: 'nope' }), [])
  })

  it('replays every session buffer with the primary session last', () => {
    const batches = buildReplayBatches(buffers, { primarySessionId: 'a' })
    assert.deepEqual(batches.map(b => b.events[0].sessionId), ['b', 'a'])
    assert.equal(batches[1].events.length, 2)
  })
})
