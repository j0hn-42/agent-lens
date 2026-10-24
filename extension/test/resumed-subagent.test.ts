/**
 * A subagent that finished and is resumed (SendMessage "Resuming agent") appends to the same
 * subagents/agent-*.jsonl file (#433). What the extension emits for those lines decides what the web side
 * can know: no second agent_spawn, no agent_complete, but the agent's own tool_call_start and messages.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import {
  tmpDir, makeSession, makeHarness, ofType, userText, assistantText, assistantThinking, assistantToolUse, toolResult, writeTeammate,
} from './helpers/teams-fixtures'

const jl = (o: unknown) => JSON.stringify(o) + '\n'

describe('a resumed subagent keeps writing to its transcript (#433)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  function firstRun() {
    dir = tmpDir()
    const file = writeTeammate(dir, {
      agentId: 'resume01', meta: null,
      entries: [userText('audit the parser'), assistantToolUse('sub-t1', 'Read', { file_path: '/a.ts' })],
    })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    fs.appendFileSync(file, jl(toolResult('sub-t1')) + jl(assistantText('Done, no defect.')))
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    return { file, h }
  }

  it('the first run announces the subagent once', () => {
    const { h } = firstRun()
    assert.equal(ofType(h.events, 'agent_spawn').length, 1)
  })

  it('on resume: its tool call and messages are emitted under the same name, with no new agent_spawn and no agent_complete', () => {
    const { file, h } = firstRun()
    const name = String(ofType(h.events, 'agent_spawn')[0].payload.name)
    const before = h.events.length

    fs.appendFileSync(file, jl(userText('Resuming agent'))
      + jl(assistantThinking('where was I'))
      + jl(assistantText('picking it up'))
      + jl(assistantToolUse('sub-t2', 'Bash', { command: 'pnpm test' })))
    readSubagentNewLines(h.delegate, h.parser, file, 's1')

    const resumed = h.events.slice(before)
    assert.equal(ofType(resumed, 'agent_spawn').length, 0, 'the spawn is emitted once per subagent')
    assert.equal(ofType(resumed, 'agent_complete').length, 0)
    const starts = ofType(resumed, 'tool_call_start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].payload.agent, name)
    assert.equal(starts[0].payload.toolUseId, 'sub-t2')
    const roles = ofType(resumed, 'message').map(e => [e.payload.agent, e.payload.role])
    assert.deepEqual(roles, [[name, 'user'], [name, 'thinking'], [name, 'assistant']])
  })
})

// The end of a RESUMED background subagent (#433). Format taken from a real session transcript: the
// SendMessage tool_result carries toolUseResult.resumedAgentId, and the next <task-notification> has the
// same <task-id> but the <tool-use-id> of the SendMessage call (not the one of the original launch).
describe('the end of a resumed background subagent comes from its second notification (#433)', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'background-subagent.jsonl')
  const [PROMPT, DISPATCH, RECEIPT, TEXT, , COMPLETED] = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim())
  const AGENT_ID = 'a0123456789abcdef'

  const sendMessage = (id: string, to = AGENT_ID) => JSON.stringify({
    type: 'assistant', uuid: `a-${id}`, sessionId: 's-bg',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, summary: 'continue', message: 'Carry on.' } }] },
  })
  const sendResult = (id: string, agentId = AGENT_ID) => JSON.stringify({
    type: 'user', uuid: `u-${id}`, sessionId: 's-bg',
    toolUseResult: { success: true, message: `Resuming agent ${agentId.slice(0, 7)}`, resumedAgentId: agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `{"success":true,"message":"Resuming agent","resumedAgentId":"${agentId}"}` }] }] },
  })
  /** The notice of the end after a resume: same task-id, tool-use-id of the SendMessage call. */
  const secondNotice = (id: string, uuid: string) => {
    const entry = JSON.parse(COMPLETED)
    entry.uuid = uuid
    entry.message.content = entry.message.content
      .replace(/<tool-use-id>[^<]*<\/tool-use-id>/, `<tool-use-id>${id}</tool-use-id>`)
    return JSON.stringify(entry)
  }
  const queued = (line: string, operation: string) =>
    JSON.stringify({ type: 'queue-operation', operation, sessionId: 's-bg', timestamp: '2026-10-12T00:00:00Z', content: JSON.parse(line).message.content })

  function setup() {
    const session = makeSession({ sessionId: 's-bg' })
    const h = makeHarness(session)
    const feed = (...lines: string[]) => {
      for (const line of lines) h.parser.processTranscriptLine(line, 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's-bg')
    }
    return { session, h, feed }
  }
  const completions = (events: AgentEvent[]) => events.filter(e => e.type === 'agent_complete').map(e => e.payload.name)

  it('a second completed notice after a SendMessage resume finishes the subagent again', () => {
    const { h, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED)
    assert.deepEqual(completions(h.events), ['Audit parser'])
    feed(sendMessage('toolu_send1'), sendResult('toolu_send1'), secondNotice('toolu_send1', 'u-n2'))
    assert.deepEqual(completions(h.events), ['Audit parser', 'Audit parser'])
    // The return keeps the original launch's tool_use id, which the normalizer already delivered once: only the end is new
    assert.equal(ofType(h.events, 'subagent_return').length, 1)
  })

  it('the copies of the second notice (queue enqueue, user turn, queue remove) finish it once', () => {
    const { h, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED, sendMessage('toolu_send1'), sendResult('toolu_send1'))
    const n2 = secondNotice('toolu_send1', 'u-n2')
    feed(queued(n2, 'enqueue'), n2, queued(n2, 'remove'))
    assert.equal(completions(h.events).length, 2)
  })

  it('without a SendMessage resume, a second notice finishes nothing more', () => {
    const { h, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED, secondNotice('toolu_send1', 'u-n2'))
    assert.equal(completions(h.events).length, 1)
  })

  it('a SendMessage that resumes another agent, or fails, re-arms nothing', () => {
    const { h, feed } = setup()
    const failed = JSON.stringify({ type: 'user', uuid: 'u-x', sessionId: 's-bg', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send2', is_error: true, content: 'no such agent' }] } })
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED,
      sendMessage('toolu_send1', 'affffffffffffffff'), sendResult('toolu_send1', 'affffffffffffffff'),
      sendMessage('toolu_send2'), failed,
      secondNotice('toolu_send2', 'u-n2'))
    assert.equal(completions(h.events).length, 1)
  })

  it('it can be resumed and finished again, more than once', () => {
    const { h, feed } = setup()
    feed(PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED,
      sendMessage('toolu_send1'), sendResult('toolu_send1'), secondNotice('toolu_send1', 'u-n2'),
      sendMessage('toolu_send2'), sendResult('toolu_send2'), secondNotice('toolu_send2', 'u-n3'))
    assert.equal(completions(h.events).length, 3)
  })

  it('attached mid-session: a launch finished and resumed in the history is finished by its live second notice', () => {
    const { session, h, feed } = setup()
    const dir = tmpDir()
    try {
      const file = path.join(dir, 's-bg.jsonl')
      const history = [PROMPT, DISPATCH, RECEIPT, TEXT, COMPLETED, sendMessage('toolu_send1'), sendResult('toolu_send1')].join('\n') + '\n'
      fs.writeFileSync(file, history)
      h.parser.prescanExistingContent(file, Buffer.byteLength(history), session)
      feed(secondNotice('toolu_send1', 'u-n2'))
      assert.equal(completions(h.events).length, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
