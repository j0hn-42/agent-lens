/**
 * Tool-call end payloads must not claim more than is known (#49, #50):
 * - an interrupted call is reported as cancelled, a failed one as failed
 * - a figure that is not known is absent (never tokenCost: 0), and estimates are labelled
 */
import './helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'

type HookServerCtor = typeof import('../src/hook-server').HookServer

function makeSession(): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0,
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function transcriptRun(content: string, isError?: boolean): AgentEvent {
  const events: AgentEvent[] = []
  const session = makeSession()
  const delegate: TranscriptParserDelegate = {
    emit: e => { events.push(e) }, elapsed: () => 0, getSession: () => session,
    fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const pending = new Map()
  parser.handleToolUse({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 99' } }, 'orchestrator', pending, 's1')
  parser.handleToolResult({ type: 'tool_result', tool_use_id: 'b1', content, ...(isError ? { is_error: true } : {}) }, 'orchestrator', pending, 's1')
  return events.filter(e => e.type === 'tool_call_end')[0]
}

describe('transcript tool results', () => {
  it('an interrupted call is reported as cancelled, not as a plain failure', () => {
    const end = transcriptRun('[Request interrupted by user for tool use]', true)
    assert.equal(end.payload.outcome, 'cancelled')
  })

  it('an ordinary error carries no outcome override', () => {
    const end = transcriptRun('bash: foo: command not found', true)
    assert.equal(end.payload.isError, true)
    assert.equal(end.payload.outcome, undefined)
  })

  it('the token figure is labelled as an estimate', () => {
    const end = transcriptRun('ok')
    assert.equal(end.payload.tokenSource, 'estimated')
  })
})

describe('hook tool results', () => {
  let HookServer: HookServerCtor
  async function run(payloads: Array<Record<string, unknown>>): Promise<AgentEvent[]> {
    ({ HookServer } = await import('../src/hook-server'))
    const server = new HookServer()
    const events: AgentEvent[] = []
    server.onEvent(e => events.push(e))
    for (const p of payloads) (server as unknown as { handleHook(p: unknown): void }).handleHook({ session_id: 's1', ...p })
    return events.filter(e => e.type === 'tool_call_end')
  }

  it('PostToolUseFailure has no token figure (unknown, not 0)', async () => {
    const [end] = await run([{ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', tool_response: 'nope' }])
    assert.equal(end.payload.isError, true)
    assert.equal('tokenCost' in end.payload, false)
    assert.equal(end.payload.outcome, undefined)
  })

  it('PostToolUseFailure with is_interrupt is cancelled', async () => {
    const [end] = await run([{ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', tool_response: 'x', is_interrupt: true }])
    assert.equal(end.payload.outcome, 'cancelled')
  })

  it('PostToolUse labels its estimated token cost', async () => {
    const [end] = await run([{ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_response: 'hello' }])
    assert.equal(typeof end.payload.tokenCost, 'number')
    assert.equal(end.payload.tokenSource, 'estimated')
  })
})
