/**
 * Background subagents (#239, upstream patoles/agent-flow#92 and #69).
 *
 * Claude Code runs Agent calls in the background by default, and always for `isolation: "worktree"`.
 * The tool_result written right after the tool_use is only a launch receipt
 * (`toolUseResult.status: "async_launched"`); the finish arrives later as a <task-notification>
 * carrying <tool-use-id> / <task-id> and a <status>. "Done" must only follow that proof.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'

const FIXTURE = path.join(__dirname, 'fixtures', 'background-subagent.jsonl')
const LINES = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim())
const [PROMPT, DISPATCH, RECEIPT, TEXT, RESTARTED, COMPLETED] = LINES

function makeSession(): WatchedSession {
  return {
    sessionId: 's-bg', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function setup() {
  const session = makeSession()
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: e => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const feed = (...lines: string[]) => {
    for (const line of lines) parser.processTranscriptLine(line, 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's-bg')
  }
  return { session, events, parser, feed }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)
const completions = (events: AgentEvent[]) => ofType(events, 'agent_complete').map(e => e.payload.name)

/** The same notification with its <status> (and optionally its <tool-use-id>) replaced. */
function variant(line: string, opts: { status?: string; dropToolUseId?: boolean; uuid?: string; toolUseId?: string }): string {
  const entry = JSON.parse(line)
  let text: string = entry.message.content
  if (opts.status) text = text.replace('<status>completed</status>', `<status>${opts.status}</status>`)
  if (opts.dropToolUseId) text = text.replace(/<tool-use-id>[^<]*<\/tool-use-id>\n/, '')
  if (opts.toolUseId) text = text.replace('toolu_bg1', opts.toolUseId)
  entry.message.content = text
  if (opts.uuid) entry.uuid = opts.uuid
  return JSON.stringify(entry)
}

/** Claude Code also logs a notification it absorbed mid-turn as a queue operation (and only there). */
function queued(line: string, operation = 'enqueue'): string {
  const entry = JSON.parse(line)
  return JSON.stringify({ type: 'queue-operation', operation, sessionId: 's-bg', timestamp: '2026-10-12T00:00:00Z', content: entry.message.content })
}

describe('background subagent: launch receipt is not a finish (#239)', () => {
  it('spawns the subagent and keeps it running after the async launch receipt', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT)
    const spawn = ofType(events, 'agent_spawn')
    assert.equal(spawn.length, 1)
    assert.equal(spawn[0].payload.name, 'Audit parser')
    assert.deepEqual(completions(events), [])
    assert.equal(ofType(events, 'subagent_return').length, 0)
    // The parent's Agent call itself did return (the launch): its tool call ends
    const end = ofType(events, 'tool_call_end')
    assert.equal(end.length, 1)
    assert.equal(end[0].payload.toolUseId, 'toolu_bg1')
  })

  it('a notification without a <status> (restarted agent) does not finish it', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, RESTARTED)
    assert.deepEqual(completions(events), [])
  })

  it('completes the subagent once, on its <task-notification> with status completed', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, RESTARTED, COMPLETED)
    assert.deepEqual(completions(events), ['Audit parser'])
    const ret = ofType(events, 'subagent_return')
    assert.equal(ret.length, 1)
    assert.equal(ret[0].payload.child, 'Audit parser')
    assert.equal(ret[0].payload.parent, 'orchestrator')
    assert.equal(ret[0].payload.toolUseId, 'toolu_bg1')
    assert.equal(ret[0].payload.isError, false)
    assert.equal(ret[0].payload.summary, 'No defect found.')
  })

  it('the notification never becomes a user message', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, RESTARTED, COMPLETED)
    const userMsgs = ofType(events, 'message').filter(e => e.payload.role === 'user')
    assert.equal(userMsgs.length, 1)
    assert.equal(userMsgs[0].payload.content, 'Audit the parser in a worktree')
  })

  it('matches by <task-id> (the agentId of the receipt) when <tool-use-id> is absent', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, variant(COMPLETED, { dropToolUseId: true }))
    assert.deepEqual(completions(events), ['Audit parser'])
    assert.equal(ofType(events, 'subagent_return')[0].payload.toolUseId, 'toolu_bg1')
  })

  it('a failed status finishes the subagent as an error', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, variant(COMPLETED, { status: 'failed' }))
    assert.deepEqual(completions(events), ['Audit parser'])
    assert.equal(ofType(events, 'subagent_return')[0].payload.isError, true)
  })

  it('an unknown status is no proof of a finish', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, variant(COMPLETED, { status: 'something-new' }))
    assert.deepEqual(completions(events), [])
  })

  it('a notification for a launch it never saw finishes nothing', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, variant(COMPLETED, { toolUseId: 'toolu_other', dropToolUseId: false }).replace(/a0123456789abcdef/g, 'affffffffffffffff'))
    assert.deepEqual(completions(events), [])
  })

  it('a notification absorbed mid-turn (queue-operation only) finishes it; the later echo does not finish it twice', () => {
    const { events, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, queued(COMPLETED), queued(COMPLETED, 'remove'), COMPLETED)
    assert.deepEqual(completions(events), ['Audit parser'])
    assert.equal(ofType(events, 'subagent_return').length, 1)
  })

  it('a foreground subagent still completes on its tool_result', () => {
    const { events, feed } = setup()
    const receipt = JSON.parse(RECEIPT)
    delete receipt.toolUseResult
    receipt.message.content[0].content = 'Full report.'
    feed(PROMPT, DISPATCH, JSON.stringify(receipt))
    assert.deepEqual(completions(events), ['Audit parser'])
    assert.equal(ofType(events, 'subagent_return')[0].payload.summary, 'Full report.')
  })

  it('after attaching mid-session (pre-scan), a live notification finishes the subagent launched before', () => {
    const { session, events, parser, feed } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-subagent-'))
    try {
      const file = path.join(dir, 's-bg.jsonl')
      const history = [PROMPT, DISPATCH, RECEIPT, TEXT].join('\n') + '\n'
      fs.writeFileSync(file, history)
      parser.prescanExistingContent(file, Buffer.byteLength(history), session)
      feed(COMPLETED)
      assert.deepEqual(completions(events), ['Audit parser'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('after attaching, a subagent already finished in the history is not finished again', () => {
    const { session, events, parser, feed } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-subagent-'))
    try {
      const file = path.join(dir, 's-bg.jsonl')
      const history = [PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED].join('\n') + '\n'
      fs.writeFileSync(file, history)
      parser.prescanExistingContent(file, Buffer.byteLength(history), session)
      feed(variant(COMPLETED, { uuid: 'u-5' }))
      assert.deepEqual(completions(events), [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
