/**
 * Teammates in the event model (#42): SendMessage / Agent tool uses and
 * <teammate-message> / <task-notification> turns become agent_link + message_sent,
 * never the session/agent display name. Realistic transcript lines, untrusted content.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, WatchedSession, TranscriptEntry } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'
import {
  sanitizeMessageContent, sanitizeAgentName, buildLinkId, extractToolUseLinks,
  parseTeamNotifications, isTeamNotification,
} from '../src/team-links'
import { TEAM_MESSAGE_MAX, TEAM_NAME_MAX, TEAM_NOTIFICATIONS_PER_TURN_MAX, TEAM_MAX_LINKS_PER_SESSION, SYSTEM_CONTENT_PREFIXES } from '../src/constants'

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
  const parser = new TranscriptParser(delegate)
  const feed = (entry: unknown, agent = 'orchestrator') =>
    parser.processTranscriptLine(JSON.stringify(entry), agent, session.pendingToolCalls, session.seenToolUseIds, session.sessionId, session.seenMessageHashes)
  return { parser, events, feed }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

const assistantToolUse = (id: string, name: string, input: Record<string, unknown>, uuid = `u-${id}`) => ({
  type: 'assistant', uuid, sessionId: 's1',
  message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'tool_use', id, name, input }] },
})

describe('sanitizers', () => {
  it('strips control and bidi characters but keeps newlines and tabs', () => {
    const dirty = 'a\u0000b\u0007c\u001b[31md\u009be‮f​g\nh\ti'
    assert.equal(sanitizeMessageContent(dirty), 'abc[31mdefg\nh\ti')
  })
  it('caps content at TEAM_MESSAGE_MAX without splitting a surrogate pair', () => {
    const long = 'x'.repeat(TEAM_MESSAGE_MAX - 1) + '\u{1F600}' + 'tail'
    const out = sanitizeMessageContent(long)
    assert.ok(out.length <= TEAM_MESSAGE_MAX)
    assert.ok(!/[\ud800-\udbff]$/.test(out), 'dangling high surrogate')
    assert.equal(sanitizeMessageContent('y'.repeat(50_000)).length, TEAM_MESSAGE_MAX)
  })
  it('returns empty / null for non-strings and blank names', () => {
    assert.equal(sanitizeMessageContent(42), '')
    assert.equal(sanitizeAgentName('   \u0000 '), null)
    assert.equal(sanitizeAgentName({ a: 1 }), null)
  })
  it('makes agent names single-line and capped', () => {
    assert.equal(sanitizeAgentName('re\nsearch\u0000er'), 're searcher')
    assert.equal(sanitizeAgentName('n'.repeat(500))?.length, TEAM_NAME_MAX)
  })
  it('builds deterministic link ids', () => {
    assert.equal(buildLinkId('teammate', 'a', 'b'), 'teammate:a>b')
    assert.ok(buildLinkId('spawn', 'a'.repeat(300), 'b').length <= 160)
  })
})

describe('extractToolUseLinks', () => {
  it('SendMessage with a recipient yields a teammate link and a message', () => {
    const r = extractToolUseLinks('SendMessage', { to: 'researcher', message: 'Please check the auth module', summary: 'auth check' }, 'orchestrator', 'toolu_01')
    assert.deepEqual(r?.link, { from: 'orchestrator', to: 'researcher', kind: 'teammate', linkId: 'teammate:orchestrator>researcher' })
    assert.equal(r?.message?.content, 'Please check the auth module')
    assert.equal(r?.message?.toolUseId, 'toolu_01')
  })
  it('accepts the legacy recipient field and structured messages', () => {
    const r = extractToolUseLinks('SendMessage', { recipient: 'qa', message: { type: 'shutdown_request', reason: 'done' } }, 'lead')
    assert.equal(r?.link.to, 'qa')
    assert.equal(r?.message?.content, '{"type":"shutdown_request","reason":"done"}')
  })
  it('ignores broadcasts, missing recipients, TeamCreate and non-object input', () => {
    assert.equal(extractToolUseLinks('SendMessage', { type: 'broadcast', message: 'hi' }, 'lead'), null)
    assert.equal(extractToolUseLinks('SendMessage', { to: '*', message: 'hi' }, 'lead'), null)
    assert.equal(extractToolUseLinks('TeamCreate', { team_name: 'alpha', description: 'x' }, 'lead'), null)
    assert.equal(extractToolUseLinks('SendMessage', 'nope', 'lead'), null)
    assert.equal(extractToolUseLinks('SendMessage', null, 'lead'), null)
  })
  it('Agent is a spawn link, or a teammate link when it names the agent/team', () => {
    assert.equal(extractToolUseLinks('Agent', { description: 'Explore', prompt: 'p' }, 'orchestrator', 't1', 'Explore')?.link.kind, 'spawn')
    const named = extractToolUseLinks('Agent', { name: 'researcher', team_name: 'alpha', prompt: 'p' }, 'orchestrator', 't2', 'researcher')
    assert.equal(named?.link.kind, 'teammate')
    assert.equal(named?.message, undefined)
  })
  it('sanitizes hostile recipients and content', () => {
    const r = extractToolUseLinks('SendMessage', { to: 'ev\u0000il\n', message: 'x'.repeat(10_000) + '\u0007' }, 'lead')
    assert.equal(r?.link.to, 'evil')
    assert.equal(r?.message?.content.length, TEAM_MESSAGE_MAX)
  })
})

describe('parseTeamNotifications', () => {
  it('parses a teammate message turn', () => {
    const text = '<teammate-message teammate_id="researcher" color="blue" summary="Found it">The bug is in auth.ts line 42.</teammate-message>'
    assert.deepEqual(parseTeamNotifications(text), [
      { from: 'researcher', content: 'The bug is in auth.ts line 42.', kind: 'teammate-message' },
    ])
  })
  it('parses a task notification', () => {
    const text = `<task-notification>
<task-id>b3k9x2</task-id>
<status>completed</status>
<summary>Background command "pnpm test" completed (exit code 0)</summary>
<result>250 passing</result>
</task-notification>`
    const [n] = parseTeamNotifications(text)
    assert.equal(n.kind, 'task-notification')
    assert.equal(n.from, 'task-b3k9x2')
    assert.ok(n.content.startsWith('[completed]'))
    assert.ok(n.content.includes('250 passing'))
  })
  it('returns nothing for ordinary text and skips entries without an id', () => {
    assert.deepEqual(parseTeamNotifications('just a normal <b>message</b>'), [])
    assert.deepEqual(parseTeamNotifications('<teammate-message color="red">orphan</teammate-message>'), [])
  })
  it('bounds the number of notifications per turn and the scanned size', () => {
    const one = '<teammate-message teammate_id="t">x</teammate-message>'
    assert.equal(parseTeamNotifications(one.repeat(500)).length, TEAM_NOTIFICATIONS_PER_TURN_MAX)
    const huge = '<teammate-message teammate_id="t">' + 'a'.repeat(200_000) + '</teammate-message>'
    assert.deepEqual(parseTeamNotifications(huge), []) // closing tag lies beyond the scan window
  })
  it('detects notification prefixes', () => {
    assert.equal(isTeamNotification('  <teammate-message teammate_id="a">x</teammate-message>'), true)
    assert.equal(isTeamNotification('<task-notification>'), true)
    assert.equal(isTeamNotification('hello'), false)
  })
})

describe('TranscriptParser: teammates', () => {
  it('emits agent_link + message_sent for SendMessage, link once per edge', () => {
    const { feed, events } = makeParser(makeSession())
    feed(assistantToolUse('toolu_a', 'SendMessage', { to: 'researcher', message: 'start on the parser' }))
    feed(assistantToolUse('toolu_b', 'SendMessage', { to: 'researcher', message: 'and the tests' }))
    const links = ofType(events, 'agent_link')
    assert.equal(links.length, 1)
    assert.deepEqual(links[0].payload, { from: 'orchestrator', to: 'researcher', kind: 'teammate', linkId: 'teammate:orchestrator>researcher', sessionId: 's1' })
    const sent = ofType(events, 'message_sent')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].payload.content, 'and the tests')
    assert.equal(sent[1].payload.toolUseId, 'toolu_b')
    // Tool call events still flow
    assert.equal(ofType(events, 'tool_call_start').length, 2)
  })

  it('does not re-emit when the same tool_use is replayed', () => {
    const { feed, events } = makeParser(makeSession())
    const line = assistantToolUse('toolu_dup', 'SendMessage', { to: 'qa', message: 'once' })
    feed(line); feed(line)
    assert.equal(ofType(events, 'message_sent').length, 1)
  })

  it('emits a spawn link for Agent tool uses', () => {
    const { feed, events } = makeParser(makeSession())
    feed(assistantToolUse('toolu_ag', 'Agent', { description: 'Explore repo', prompt: 'look', subagent_type: 'Explore' }))
    const [link] = ofType(events, 'agent_link')
    assert.equal(link.payload.kind, 'spawn')
    assert.equal(link.payload.from, 'orchestrator')
    assert.equal(link.payload.to, 'Explore repo')
  })

  it('turns an incoming <teammate-message> user turn into message_sent, not a message', () => {
    const { feed, events } = makeParser(makeSession())
    feed({
      type: 'user', uuid: 'u1', sessionId: 's1',
      message: { role: 'user', content: '<teammate-message teammate_id="researcher" summary="done">Parser fixed.\u0007</teammate-message>' },
    })
    const sent = ofType(events, 'message_sent')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.from, 'researcher')
    assert.equal(sent[0].payload.to, 'orchestrator')
    assert.equal(sent[0].payload.content, 'Parser fixed.')
    assert.equal(ofType(events, 'message').length, 0)
    assert.equal(ofType(events, 'agent_link').length, 1)
  })

  it('handles <task-notification> inside a text block (array content) once', () => {
    const { feed, events } = makeParser(makeSession())
    const entry = {
      type: 'user', uuid: 'u2', sessionId: 's1',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification><task-id>abc123</task-id><status>completed</status><summary>Agent "Explore" finished</summary><result>Found 3 files</result></task-notification>' }] },
    }
    feed(entry); feed(entry)
    const sent = ofType(events, 'message_sent')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.from, 'task-abc123')
    assert.match(String(sent[0].payload.content), /Found 3 files/)
    assert.equal(ofType(events, 'message').length, 0)
  })

  it('never lets a notification become the session label', () => {
    const session = makeSession()
    const { parser, feed } = makeParser(session)
    feed({
      type: 'user', uuid: 'u3', sessionId: 's1',
      message: { role: 'user', content: '<teammate-message teammate_id="researcher">I am the label?</teammate-message>' },
    })
    assert.equal(session.labelSet, false)
    feed({ type: 'user', uuid: 'u4', sessionId: 's1', message: { role: 'user', content: 'Fix the login bug' } })
    assert.equal(session.label, 'Fix the logi..')
    const entry: TranscriptEntry = { sessionId: 's1', type: 'user', message: { role: 'user', content: '<task-notification><task-id>z</task-id></task-notification>' } }
    assert.equal(parser.extractUserMessageText(entry), null)
    assert.ok(SYSTEM_CONTENT_PREFIXES.includes('<teammate-message' as never))
  })

  it('caps remembered links per session and forgets them when the session is cleared', () => {
    const session = makeSession()
    const { parser, feed, events } = makeParser(session)
    for (let i = 0; i < TEAM_MAX_LINKS_PER_SESSION + 20; i++) {
      feed(assistantToolUse(`toolu_${i}`, 'SendMessage', { to: `mate-${i}`, message: 'hi' }))
    }
    assert.equal(ofType(events, 'agent_link').length, TEAM_MAX_LINKS_PER_SESSION + 20)
    const internal = parser as unknown as { emittedLinks: Map<string, Set<string>> }
    assert.equal(internal.emittedLinks.get('s1')?.size, TEAM_MAX_LINKS_PER_SESSION)
    parser.clearSessionState([], 's1')
    assert.equal(internal.emittedLinks.has('s1'), false)
  })

  it('survives malformed tool_use input', () => {
    const { feed, events } = makeParser(makeSession())
    feed(assistantToolUse('toolu_bad', 'SendMessage', { to: { nested: true }, message: 5 }))
    feed(assistantToolUse('toolu_bad2', 'SendMessage', {} as never))
    assert.equal(ofType(events, 'agent_link').length, 0)
    assert.equal(ofType(events, 'tool_call_start').length, 2)
  })
})
