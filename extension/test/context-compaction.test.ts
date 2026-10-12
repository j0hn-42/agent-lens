/**
 * Context compactions (#232): Claude Code writes a `compact_boundary` system record at each compaction,
 * Codex a `compacted` record. Both become a `context_compacted` event that carries only what the
 * transcript proves, and the local context estimate restarts from the system prompt.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'
import { CodexRolloutParser, createCodexRolloutState } from '../src/codex-rollout-parser'
import { AGENT_EVENT_TYPES, SessionNormalizer } from '../src/event-normalize'

function makeSession(): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 5000, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function setup() {
  const session = makeSession()
  const events: AgentEvent[] = []
  const contextUpdates: Array<{ agent: string; total: number }> = []
  const delegate: TranscriptParserDelegate = {
    emit: (e) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: (agent, s) => {
      const bd = s.contextBreakdown
      contextUpdates.push({ agent, total: bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults })
    },
  }
  const parser = new TranscriptParser(delegate)
  // The main transcript of the session: its pending map and seen sets are the session's own
  const feedMain = (obj: object) => parser.processTranscriptLine(
    JSON.stringify(obj), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1', session.seenMessageHashes)
  // A subagent transcript: its own pending map and seen set
  const subPending = new Map()
  const subSeen = new Set<string>()
  const feedSub = (obj: object) => parser.processTranscriptLine(JSON.stringify(obj), 'explorer', subPending, subSeen, 's1')
  const compactions = () => events.filter(e => e.type === 'context_compacted')
  return { session, events, contextUpdates, parser, feedMain, feedSub, compactions }
}

const boundary = (uuid: string | undefined, compactMetadata?: unknown) => ({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', sessionId: 's1',
  ...(uuid ? { uuid } : {}), ...(compactMetadata !== undefined ? { compactMetadata } : {}),
})
const userTurn = (uuid: string, text: string) => ({ type: 'user', sessionId: 's1', uuid, message: { role: 'user', content: text } })

describe('Claude Code compact_boundary', () => {
  it('emits context_compacted with the trigger and the size before, as reported', () => {
    const { feedMain, compactions } = setup()
    feedMain(boundary('b1', { trigger: 'auto', preTokens: 154321 }))
    feedMain(boundary('b2', { trigger: 'manual', preTokens: 80000 }))
    assert.deepEqual(compactions().map(e => e.payload), [
      { agent: 'orchestrator', trigger: 'auto', preTokens: 154321 },
      { agent: 'orchestrator', trigger: 'manual', preTokens: 80000 },
    ])
  })

  it('drops a trigger or a size it cannot prove, never invents one', () => {
    const { feedMain, compactions } = setup()
    feedMain(boundary('b1'))
    feedMain(boundary('b2', 'not an object'))
    feedMain(boundary('b3', { trigger: 'sometimes', preTokens: -5 }))
    feedMain(boundary('b4', { trigger: 'AUTO', preTokens: 1.5 }))
    feedMain(boundary('b5', { trigger: 42, preTokens: '1000' }))
    feedMain(boundary('b6', { preTokens: 0 }))
    feedMain(boundary('b7', { preTokens: Number.MAX_SAFE_INTEGER * 4 }))
    const payloads = compactions().map(e => e.payload)
    assert.equal(payloads.length, 7)
    for (const p of payloads) assert.deepEqual(p, { agent: 'orchestrator' })
  })

  it('a re-read boundary (same uuid) is not reported twice', () => {
    const { feedMain, compactions } = setup()
    feedMain(boundary('b1', { trigger: 'auto', preTokens: 1000 }))
    feedMain(boundary('b1', { trigger: 'auto', preTokens: 1000 }))
    assert.equal(compactions().length, 1)
  })

  it('restarts the local estimate from the system prompt and publishes it', () => {
    const { session, feedMain, contextUpdates } = setup()
    feedMain(userTurn('u1', 'x'.repeat(4000)))
    assert.ok(session.contextBreakdown.userMessages > 0)
    session.contextBreakdown.toolResults = 900
    session.contextBreakdown.reasoning = 800
    session.contextBreakdown.subagentResults = 700
    feedMain(boundary('b1', { trigger: 'auto', preTokens: 150000 }))
    assert.deepEqual(session.contextBreakdown, { systemPrompt: 5000, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 })
    assert.deepEqual(contextUpdates.at(-1), { agent: 'orchestrator', total: 5000 })
  })

  it('counts the compaction summary that follows the boundary in the new estimate', () => {
    const { session, feedMain, events } = setup()
    feedMain(boundary('b1', { trigger: 'auto' }))
    const summary = 'This session is being continued from a previous conversation that ran out of context. ' + 'y'.repeat(4000)
    feedMain({ ...userTurn('u2', summary), isCompactSummary: true })
    assert.ok(session.contextBreakdown.userMessages > 0, 'the summary is now the context')
    assert.equal(events.filter(e => e.type === 'message').length, 0, 'the summary is still not shown as a user prompt')
    // A system-injected text that is not a compaction summary is still not counted
    const before = session.contextBreakdown.userMessages
    feedMain(userTurn('u3', '<system-reminder>noise</system-reminder>'))
    assert.equal(session.contextBreakdown.userMessages, before)
  })

  it('a subagent boundary is reported for the subagent and leaves the session estimate alone', () => {
    const { session, feedSub, compactions } = setup()
    session.contextBreakdown.toolResults = 1234
    feedSub(boundary('s-b1', { trigger: 'auto', preTokens: 9000 }))
    assert.deepEqual(compactions().map(e => e.payload), [{ agent: 'explorer', trigger: 'auto', preTokens: 9000 }])
    assert.equal(session.contextBreakdown.toolResults, 1234)
  })

  it('pre-scan: an earlier compaction resets the estimate, is not listed, and is not reported on a re-read', () => {
    const { session, parser, feedMain, compactions } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-compact-'))
    try {
      const file = path.join(dir, 's1.jsonl')
      const lines = [
        userTurn('u1', 'z'.repeat(8000)),
        boundary('b1', { trigger: 'auto', preTokens: 170000 }),
        userTurn('u2', 'short prompt'),
      ].map(o => JSON.stringify(o)).join('\n') + '\n'
      fs.writeFileSync(file, lines)
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      const shortOnly = Math.ceil('short prompt'.length / 4)
      assert.ok(session.contextBreakdown.userMessages <= shortOnly + 1, `only what follows the boundary is counted (${session.contextBreakdown.userMessages})`)
      assert.equal(compactions().length, 0)
      feedMain(boundary('b1', { trigger: 'auto', preTokens: 170000 }))
      assert.equal(compactions().length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Codex compacted record', () => {
  it('emits context_compacted without a trigger or a size (Codex reports neither)', () => {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history: [] } }), state)
    const compacted = events.filter(e => e.type === 'context_compacted')
    assert.equal(compacted.length, 1)
    assert.deepEqual(compacted[0].payload, { agent: 'orchestrator' })
  })

  it('a pre-compaction reported total is no longer shown as the current reading', () => {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200000 }, model_context_window: 258400 } },
    }), state)
    parser.processLine(JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history: [] } }), state)
    assert.equal(state.lastReportedTokens, null)
    const last = events.filter(e => e.type === 'context_update').at(-1)!
    assert.equal(last.payload.tokenSource, 'estimated')
    assert.ok((last.payload.tokens as number) < 200000)
    assert.equal(last.payload.tokensMax, 258400, 'the reported window still holds')
  })
})

describe('normalization', () => {
  it('context_compacted is a known event type and keeps its fields', () => {
    assert.ok(AGENT_EVENT_TYPES.includes('context_compacted'))
    const norm = new SessionNormalizer('s1')
    const out = norm.processBatch([
      { time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
      { time: 2, type: 'context_compacted', payload: { agent: 'orchestrator', trigger: 'auto', preTokens: 1000 } },
    ])
    norm.dispose()
    const ev = out.find(e => e.type === 'context_compacted')
    assert.deepEqual(ev?.payload, { agent: 'orchestrator', trigger: 'auto', preTokens: 1000 })
  })
})
