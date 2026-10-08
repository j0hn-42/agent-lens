/**
 * Model facts in the transcript (#108, #109): a pseudo-model written by Claude Code for its own messages
 * is not a model that ran, and the orchestrator model read from the transcript is a runtime fact.
 */
import './helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'
import { withIndexedFacts } from '../src/session-index'

function makeSession(): WatchedSession {
  return {
    sessionId: 's1', filePath: '', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    seenMessageHashes: new Set(), sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null, subagentWatchers: new Map(),
    spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'x', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function feed(models: string[]): { events: AgentEvent[]; session: WatchedSession } {
  const events: AgentEvent[] = []
  const session = makeSession()
  const delegate: TranscriptParserDelegate = {
    emit: e => { events.push(e) }, elapsed: () => 0, getSession: () => session,
    fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const pending = new Map()
  const seen = new Set<string>()
  models.forEach((model, i) => {
    const line = JSON.stringify({ type: 'assistant', uuid: `u${i}`, message: { role: 'assistant', model, content: [{ type: 'text', text: `hi ${i}` }] } })
    parser.processTranscriptLine(line, 'orchestrator', pending, seen, 's1')
  })
  return { events, session }
}

describe('transcript model_detected', () => {
  it('reports a real model', () => {
    const { events, session } = feed(['claude-opus-4-6'])
    assert.deepEqual(events.filter(e => e.type === 'model_detected').map(e => e.payload.model), ['claude-opus-4-6'])
    assert.equal(session.model, 'claude-opus-4-6')
  })

  it('ignores the <synthetic> pseudo-model: no event, no session model, no remembered model', () => {
    const { events, session } = feed(['<synthetic>'])
    assert.equal(events.filter(e => e.type === 'model_detected').length, 0)
    assert.equal(session.model, null)
    assert.equal(session.modelDetectedAgents.size, 0)
  })

  it('a synthetic message between two real ones changes nothing', () => {
    const { events, session } = feed(['claude-opus-4-6', '<synthetic>', 'claude-opus-4-6'])
    assert.equal(events.filter(e => e.type === 'model_detected').length, 1)
    assert.equal(session.modelDetectedAgents.get('orchestrator'), 'claude-opus-4-6')
  })
})

describe('withIndexedFacts (#108)', () => {
  const live = { id: 's', label: 'L', status: 'active' as const, startTime: 1, lastActivityTime: 2 }
  it('adds the declared parent and the cwd a started session does not have', () => {
    const out = withIndexedFacts(live, { id: 's', startTime: 1, parentSessionId: 'p', cwd: '/r' })
    assert.equal(out.parentSessionId, 'p')
    assert.equal(out.cwd, '/r')
  })
  it('never replaces a live fact, and leaves an unindexed session as it is', () => {
    const withCwd = { ...live, cwd: '/live', parentSessionId: 'live-p' }
    const out = withIndexedFacts(withCwd, { id: 's', startTime: 1, parentSessionId: 'p', cwd: '/r' })
    assert.equal(out.cwd, '/live')
    assert.equal(out.parentSessionId, 'live-p')
    assert.equal(withIndexedFacts(live, undefined), live)
  })
})
