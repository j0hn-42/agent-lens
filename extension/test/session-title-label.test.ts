/**
 * The session label comes from the session name written by Claude Code
 * (custom-title > agent-name > ai-title), not from the start of the first prompt.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { WatchedSession } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'

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

function setup() {
  const session = makeSession()
  const updates: string[] = []
  const delegate: TranscriptParserDelegate = {
    emit: () => {},
    elapsed: () => 0,
    getSession: () => session,
    fireSessionLifecycle: (e) => { updates.push(e.label) },
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const feed = (obj: object) => parser.processTranscriptLine(JSON.stringify(obj), 'orchestrator', new Map(), new Set(), 's1')
  return { session, updates, feed }
}

const prompt = { type: 'user', sessionId: 's1', uuid: 'u1', message: { role: 'user', content: 'Fix login bug' } }

describe('session label from session name', () => {
  it('ai-title replaces the label taken from the first prompt', () => {
    const { session, updates, feed } = setup()
    feed(prompt)
    assert.equal(session.label, 'Fix login bug')
    feed({ type: 'ai-title', aiTitle: 'Login bug fix', sessionId: 's1' })
    assert.equal(session.label, 'Login bug fix')
    assert.equal(updates.at(-1), 'Login bug fix')
  })

  it('the first prompt no longer overrides an existing session name', () => {
    const { session, feed } = setup()
    feed({ type: 'ai-title', aiTitle: 'Login bug fix', sessionId: 's1' })
    feed(prompt)
    assert.equal(session.label, 'Login bug fix')
  })

  it('custom-title (/rename) wins over ai-title and agent-name', () => {
    const { session, feed } = setup()
    feed({ type: 'custom-title', customTitle: 'Mon nom', sessionId: 's1' })
    feed({ type: 'ai-title', aiTitle: 'Auto title', sessionId: 's1' })
    feed({ type: 'agent-name', agentName: 'Auto title', sessionId: 's1' })
    assert.equal(session.label, 'Mon nom')
    feed({ type: 'custom-title', customTitle: 'Nouveau nom', sessionId: 's1' })
    assert.equal(session.label, 'Nouveau nom')
  })

  it('ignores empty titles', () => {
    const { session, feed } = setup()
    feed(prompt)
    feed({ type: 'ai-title', aiTitle: '  ', sessionId: 's1' })
    assert.equal(session.label, 'Fix login bug')
  })
})
