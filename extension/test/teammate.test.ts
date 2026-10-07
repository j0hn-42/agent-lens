/**
 * In-process Agent Team teammates (#42, #35): idle / finished / working teammates are always
 * announced, history is replayed within a cap, activity follows the transcript, 'done' never
 * becomes agent_complete.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  parseTeammateMeta, sanitizeTeamColor, TeammateTracker, readTranscriptTail, selectReplayLines,
} from '../src/teammate'
import {
  scanSubagentsDir, resolveSubagentFileInfo, markTeammatesDone, emitTeammateActivity, readSubagentNewLines,
} from '../src/subagent-watcher'
import {
  TEAMMATE_RECENT_WRITE_MS, TEAMMATE_STALE_WORKING_MS, TEAMMATE_REPLAY_MAX_MESSAGES, TEAMMATE_MAX_PER_SESSION,
} from '../src/constants'
import {
  tmpDir, makeSession, makeHarness, ofType, writeTeammate, writeJsonl, teammateMeta,
  userText, assistantText, assistantThinking, assistantToolUse, toolResult,
} from './helpers/teams-fixtures'

const HOUR = 3_600_000

describe('parseTeammateMeta', () => {
  it('reads name, team, role and model from a teammate sidecar', () => {
    const m = parseTeammateMeta(teammateMeta('alice', { agentType: 'ignored-role-label' }))!
    assert.equal(m.name, 'alice')
    assert.equal(m.teamName, 'demo-team')
    assert.equal(m.agentType, 'general-purpose')
    assert.equal(m.color, '#3b82f6')
    assert.equal(m.model, 'claude-sonnet-4-5')
  })

  it('falls back to agentType when name is missing, and ignores ordinary subagent metas', () => {
    assert.equal(parseTeammateMeta({ taskKind: 'in_process_teammate', agentType: 'bob', teamName: 't' })!.name, 'bob')
    assert.equal(parseTeammateMeta({ description: 'Explore', subagent_type: 'Explore' }), null)
    assert.equal(parseTeammateMeta(null), null)
    assert.equal(parseTeammateMeta([]), null)
    assert.equal(parseTeammateMeta('x'), null)
    assert.equal(parseTeammateMeta({ teamName: 't' }), null, 'no usable name')
  })

  it('accepts only #rrggbb colors', () => {
    assert.equal(sanitizeTeamColor('#AABBCC'), '#aabbcc')
    for (const bad of ['red', '#abc', '#12345g', 'javascript:alert(1)', '#1234567', 12, null, 'url(#x)', '#aabbcc;x']) {
      assert.equal(sanitizeTeamColor(bad), undefined, String(bad))
    }
  })

  it('strips control characters and caps hostile names', () => {
    const m = parseTeammateMeta(teammateMeta('x', { name: 'evil\u0000‮' + 'n'.repeat(500), teamName: 'team\u001b[31m' }))!
    assert.ok(m.name.length <= 64)
    assert.ok(!/[\u0000-\u001f‮]/.test(m.name + m.teamName))
  })
})

describe('TeammateTracker', () => {
  it('is working while a tool is pending, whatever the age', () => {
    const t = new TeammateTracker(0)
    t.feed(JSON.stringify(assistantToolUse('t1')), 0)
    assert.equal(t.activity(10 * HOUR), 'working')
    t.feed(JSON.stringify(toolResult('t1')), 0)
    assert.equal(t.activity(10 * HOUR), 'idle', 'result seen but turn not ended and file is old: stale -> idle')
  })

  it('is idle after a finished turn once the recent-write window passed', () => {
    const t = new TeammateTracker(1000)
    t.feed(JSON.stringify(assistantText('done')), 1000)
    assert.equal(t.activity(1000 + TEAMMATE_RECENT_WRITE_MS - 1), 'working')
    assert.equal(t.activity(1000 + TEAMMATE_RECENT_WRITE_MS), 'idle')
  })

  it('a turn that did not end stays working until the stale limit', () => {
    const t = new TeammateTracker(0)
    t.feed(JSON.stringify(userText('please do x')), 0)
    assert.equal(t.activity(TEAMMATE_RECENT_WRITE_MS + 1), 'working')
    assert.equal(t.activity(TEAMMATE_STALE_WORKING_MS + 1), 'idle')
  })

  it('a thinking-only assistant fragment does not end the turn', () => {
    const t = new TeammateTracker(0)
    t.feed(JSON.stringify(assistantThinking('hmm')), 0)
    assert.equal(t.turnEnded, false)
    t.feed(JSON.stringify(assistantText('answer')), 0)
    assert.equal(t.turnEnded, true)
  })

  it('done is sticky until the next transcript line, ignores garbage lines', () => {
    const t = new TeammateTracker(0)
    t.done = true
    t.feed('not json', 5)
    t.feed('{"type":"progress"}', 5)
    assert.equal(t.activity(10 * HOUR), 'done')
    t.feed(JSON.stringify(assistantText('back')), 6)
    assert.equal(t.activity(6), 'working')
  })
})

describe('transcript tail helpers', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns only complete lines and leaves a partial trailing line for the live tail', () => {
    dir = tmpDir()
    const file = path.join(dir, 'a.jsonl')
    const complete = JSON.stringify(userText('one')) + '\n'
    fs.writeFileSync(file, complete + '{"type":"user","mess')
    const tail = readTranscriptTail(file)
    assert.equal(tail.lines.length, 1)
    assert.equal(tail.size, Buffer.byteLength(complete))
  })

  it('reads at most maxBytes from the end and drops the cut first line', () => {
    dir = tmpDir()
    const file = path.join(dir, 'a.jsonl')
    writeJsonl(file, Array.from({ length: 200 }, (_, i) => userText(`message number ${i}`)))
    const tail = readTranscriptTail(file, 2000)
    assert.ok(tail.lines.length > 0 && tail.lines.length < 200)
    for (const line of tail.lines) assert.doesNotThrow(() => JSON.parse(line))
    assert.match(tail.lines[tail.lines.length - 1], /message number 199/)
  })

  it('handles missing and empty files', () => {
    dir = tmpDir()
    assert.deepEqual(readTranscriptTail(path.join(dir, 'missing.jsonl')), { lines: [], size: 0 })
    fs.writeFileSync(path.join(dir, 'e.jsonl'), '')
    assert.deepEqual(readTranscriptTail(path.join(dir, 'e.jsonl')), { lines: [], size: 0 })
  })

  it('selectReplayLines keeps the last N conversation entries only', () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => JSON.stringify(userText(`m${i}`))),
      JSON.stringify({ type: 'progress' }), 'garbage',
    ]
    const picked = selectReplayLines(lines)
    assert.equal(picked.length, TEAMMATE_REPLAY_MAX_MESSAGES)
    assert.match(picked[picked.length - 1], /m99/)
    assert.equal(selectReplayLines(lines, 3).length, 3)
  })
})

describe('teammate discovery in the subagents directory', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  function setup(fixtures: Parameters<typeof writeTeammate>[1][]) {
    dir = tmpDir()
    for (const fx of fixtures) writeTeammate(dir, fx)
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    return { session, ...h }
  }

  const activities = (events: ReturnType<typeof setup>['events']) =>
    ofType(events, 'agent_activity').map(e => `${e.payload.name}:${e.payload.activity}`)

  it('announces an IDLE teammate (turn ended, file written long ago) with teammate extras', () => {
    const { events } = setup([{
      agentId: 'aaaa1111',
      meta: teammateMeta('alice'),
      entries: [userText('<teammate-message teammate_id="team-lead" summary="start">Investigate the cache</teammate-message>'), assistantText('Investigated, report sent.')],
      mtimeMs: Date.now() - HOUR,
    }])
    const spawn = ofType(events, 'agent_spawn').find(e => e.payload.name === 'alice')!
    assert.ok(spawn, 'idle teammate must be spawned')
    assert.equal(spawn.payload.kind, 'teammate')
    assert.equal(spawn.payload.teamName, 'demo-team')
    assert.equal(spawn.payload.color, '#3b82f6')
    assert.equal(spawn.payload.agentType, 'general-purpose')
    assert.equal(spawn.payload.backendType, 'in-process')
    assert.equal(spawn.payload.model, 'claude-sonnet-4-5')
    assert.equal(spawn.payload.parent, 'orchestrator')
    assert.deepEqual(activities(events), ['alice:idle'])
    assert.equal(ofType(events, 'agent_complete').length, 0)
  })

  it('announces a teammate whose pending tool_use is unmatched as working', () => {
    const { events } = setup([{
      agentId: 'bbbb2222', meta: teammateMeta('bob'),
      entries: [userText('go'), assistantToolUse('tool-1', 'Bash', { command: 'ls' })],
      mtimeMs: Date.now() - HOUR,
    }])
    assert.deepEqual(activities(events), ['bob:working'])
  })

  it('a just-written teammate is working even when its turn ended', () => {
    const { events } = setup([{
      agentId: 'cccc3333', meta: teammateMeta('carol'),
      entries: [userText('go'), assistantText('ok')],
    }])
    assert.deepEqual(activities(events), ['carol:working'])
  })

  it('replays history: user message, thinking-free text and tool calls reach the agent', () => {
    const { events } = setup([{
      agentId: 'dddd4444', meta: teammateMeta('dave'),
      entries: [
        userText('<teammate-message teammate_id="team-lead" summary="s">Please audit the parser</teammate-message>'),
        assistantToolUse('t9', 'Read', { file_path: '/p.ts' }), toolResult('t9', 'contents'),
        assistantText('Parser audited.'),
      ],
      mtimeMs: Date.now() - HOUR,
    }])
    const msgs = ofType(events, 'message').filter(e => e.payload.agent === 'dave').map(e => e.payload.content)
    assert.ok(msgs.includes('Parser audited.'))
    assert.equal(ofType(events, 'tool_call_start').filter(e => e.payload.agent === 'dave').length, 1)
    assert.equal(ofType(events, 'tool_call_end').filter(e => e.payload.agent === 'dave').length, 1)
    // the lead's instruction becomes a link/message, labelled from the orchestrator
    const sent = ofType(events, 'message_sent').find(e => e.payload.to === 'dave')!
    assert.equal(sent.payload.from, 'orchestrator')
    assert.match(String(sent.payload.content), /audit the parser/)
  })

  it('replay is bounded to the last TEAMMATE_REPLAY_MAX_MESSAGES entries', () => {
    const entries = Array.from({ length: TEAMMATE_REPLAY_MAX_MESSAGES * 3 }, (_, i) => assistantText(`note ${i}`))
    const { events } = setup([{ agentId: 'eeee5555', meta: teammateMeta('erin'), entries, mtimeMs: Date.now() - HOUR }])
    const msgs = ofType(events, 'message').filter(e => e.payload.agent === 'erin')
    assert.equal(msgs.length, TEAMMATE_REPLAY_MAX_MESSAGES)
    assert.equal(msgs[msgs.length - 1].payload.content, `note ${TEAMMATE_REPLAY_MAX_MESSAGES * 3 - 1}`)
  })

  it('uses meta.name, not the description, and keeps names unique with the agentId suffix on collision', () => {
    const { events, session } = setup([
      { agentId: 'ffff6666', meta: teammateMeta('frank', { description: 'a long task description' }), entries: [assistantText('a')], mtimeMs: Date.now() - HOUR },
      { agentId: 'gggg7777', meta: teammateMeta('frank', { description: 'another' }), entries: [assistantText('b')], mtimeMs: Date.now() - HOUR },
    ])
    const names = ofType(events, 'agent_spawn').map(e => String(e.payload.name))
    assert.equal(new Set(names).size, 2, names.join(','))
    assert.ok(names.includes('frank'))
    assert.ok(names.includes('frank-gg7777'), 'collision suffix is the last 6 chars of the agentId')
    assert.equal(session.subagentWatchers.size, 2)
  })

  it('a teammate named like the orchestrator gets a suffix', () => {
    const { events } = setup([{ agentId: 'hhhh8888', meta: teammateMeta('orchestrator'), entries: [assistantText('x')], mtimeMs: Date.now() - HOUR }])
    const name = String(ofType(events, 'agent_spawn')[0].payload.name)
    assert.notEqual(name, 'orchestrator')
  })

  it('drops an invalid color but keeps the teammate', () => {
    const { events } = setup([{ agentId: 'iiii9999', meta: teammateMeta('ivy', { color: 'blue' }), entries: [assistantText('x')], mtimeMs: Date.now() - HOUR }])
    const spawn = ofType(events, 'agent_spawn')[0]
    assert.equal(spawn.payload.color, undefined)
    assert.equal(spawn.payload.name, 'ivy')
  })

  it('ordinary subagents keep the old behaviour: idle ones are not announced', () => {
    dir = tmpDir()
    writeJsonl(path.join(dir, 'agent-zz.jsonl'), [userText('hi'), assistantText('bye')], Date.now() - HOUR)
    fs.writeFileSync(path.join(dir, 'agent-zz.meta.json'), JSON.stringify({ description: 'Explore', subagent_type: 'Explore' }))
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    assert.equal(ofType(h.events, 'agent_spawn').length, 0)
    assert.equal(ofType(h.events, 'agent_activity').length, 0)
  })

  it('resolveSubagentFileInfo exposes the teammate meta', () => {
    dir = tmpDir()
    const file = writeTeammate(dir, { agentId: 'q1', meta: teammateMeta('quinn'), entries: [assistantText('x')] })
    const info = resolveSubagentFileInfo(file, 1)
    assert.equal(info.label, 'quinn')
    assert.equal(info.teammate?.teamName, 'demo-team')
  })

  it('a meta.json that is a symlink is ignored (no teammate identity from outside)', () => {
    dir = tmpDir()
    const outside = tmpDir('agent-lens-outside-')
    try {
      const file = path.join(dir, 'agent-s1.jsonl')
      writeJsonl(file, [assistantText('x')])
      fs.writeFileSync(path.join(outside, 'meta.json'), JSON.stringify(teammateMeta('smuggled')))
      fs.symlinkSync(path.join(outside, 'meta.json'), path.join(dir, 'agent-s1.meta.json'))
      const info = resolveSubagentFileInfo(file, 4)
      assert.equal(info.teammate, undefined)
      assert.equal(info.label, 'subagent-4')
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })

  it('an oversized meta.json is ignored', () => {
    dir = tmpDir()
    const file = path.join(dir, 'agent-big.jsonl')
    writeJsonl(file, [assistantText('x')])
    fs.writeFileSync(path.join(dir, 'agent-big.meta.json'), JSON.stringify(teammateMeta('big', { description: 'd'.repeat(200_000) })))
    assert.equal(resolveSubagentFileInfo(file, 2).teammate, undefined)
  })

  it('announces at most TEAMMATE_MAX_PER_SESSION teammates', () => {
    const fixtures = Array.from({ length: TEAMMATE_MAX_PER_SESSION + 5 }, (_, i) => ({
      agentId: `t${String(i).padStart(4, '0')}`, meta: teammateMeta(`mate${i}`), entries: [assistantText('x')], mtimeMs: Date.now() - HOUR,
    }))
    const { session } = setup(fixtures)
    const teammates = [...session.subagentWatchers.values()].filter(s => s.teammate)
    assert.equal(teammates.length, TEAMMATE_MAX_PER_SESSION)
  })
})

describe('teammate activity over time', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('turns idle later, goes back to working on new lines, becomes done only when told, never agent_complete', () => {
    dir = tmpDir()
    const file = writeTeammate(dir, { agentId: 'live0001', meta: teammateMeta('liv'), entries: [userText('go'), assistantText('ok')] })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    const state = [...session.subagentWatchers.values()][0]
    const acts = () => ofType(h.events, 'agent_activity').map(e => e.payload.activity)
    assert.deepEqual(acts(), ['working'])

    emitTeammateActivity(h.delegate, state, 's1', Date.now() + TEAMMATE_RECENT_WRITE_MS + 1)
    assert.deepEqual(acts(), ['working', 'idle'])
    emitTeammateActivity(h.delegate, state, 's1', Date.now() + TEAMMATE_RECENT_WRITE_MS + 2)
    assert.deepEqual(acts(), ['working', 'idle'], 'no repeated emission')

    fs.appendFileSync(file, JSON.stringify(assistantToolUse('late-1', 'Bash', { command: 'make' })) + '\n')
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    assert.deepEqual(acts(), ['working', 'idle', 'working'])

    markTeammatesDone(h.delegate, session, 's1', new Set(['liv']))
    assert.deepEqual(acts(), ['working', 'idle', 'working', 'done'])
    assert.equal(ofType(h.events, 'agent_complete').length, 0)

    fs.appendFileSync(file, JSON.stringify(toolResult('late-1')) + '\n' + JSON.stringify(assistantText('finished')) + '\n')
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    assert.equal(acts()[acts().length - 1], 'working', 'a new write revives a done teammate')
  })

  it('markTeammatesDone with names only touches those teammates', () => {
    dir = tmpDir()
    writeTeammate(dir, { agentId: 'n0001', meta: teammateMeta('one'), entries: [assistantText('x')], mtimeMs: Date.now() - HOUR })
    writeTeammate(dir, { agentId: 'n0002', meta: teammateMeta('two'), entries: [assistantText('x')], mtimeMs: Date.now() - HOUR })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    markTeammatesDone(h.delegate, session, 's1', new Set(['two']))
    const last = ofType(h.events, 'agent_activity').map(e => `${e.payload.name}:${e.payload.activity}`)
    assert.deepEqual(last, ['one:idle', 'two:idle', 'two:done'])
  })
})

describe('lead Agent tool_use that spawns a teammate', () => {
  it('uses the member name as identity and does not complete the teammate on the spawn ack', () => {
    const session = makeSession()
    const h = makeHarness(session)
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { name: 'researcher', team_name: 'demo-team', description: 'Research stuff', subagent_type: 'general-purpose', prompt: 'p' } }] },
    })
    h.parser.processTranscriptLine(line, 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    const spawn = ofType(h.events, 'agent_spawn')[0]
    assert.equal(spawn.payload.name, 'researcher')
    assert.equal(spawn.payload.kind, 'teammate')
    assert.equal(spawn.payload.teamName, 'demo-team')

    h.parser.processTranscriptLine(JSON.stringify(toolResult('toolu_spawn', 'Spawned successfully')), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    assert.equal(ofType(h.events, 'agent_complete').length, 0)
    assert.equal(ofType(h.events, 'subagent_return').length, 0)
    assert.equal(ofType(h.events, 'tool_call_end').length, 1)
  })

  it('an ordinary Agent call still completes when its result arrives', () => {
    const session = makeSession()
    const h = makeHarness(session)
    h.parser.processTranscriptLine(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { description: 'Explore', prompt: 'p' } }] },
    }), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    h.parser.processTranscriptLine(JSON.stringify(toolResult('toolu_x', 'report')), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    assert.equal(ofType(h.events, 'agent_complete').length, 1)
  })

  it('TeamCreate announces the team', () => {
    const session = makeSession()
    const h = makeHarness(session)
    h.parser.processTranscriptLine(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'TeamCreate', input: { team_name: 'demo-team' } }] },
    }), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    const info = ofType(h.events, 'team_info')[0]
    assert.equal(info.payload.teamName, 'demo-team')
    assert.deepEqual(info.payload.members, [])
  })
})
