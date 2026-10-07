/**
 * Team config + inbox watching (#42): synthetic ~/.claude/teams trees in os.tmpdir().
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TeamInfoPayload } from '../src/protocol'
import {
  TeamWatcher, parseTeamConfig, parseInbox, parseInboxTail, inboxKeys, matchMemberSession, toTeamInfoPayload,
  readSessionHeader, type TeamWatcherHost, type TeamSessionTags,
} from '../src/team-watcher'
import { MessageDeduper, extractToolUseLinks } from '../src/team-links'
import {
  TEAM_MAX_MEMBERS, TEAM_CONFIG_MAX_BYTES, TEAM_INBOX_MAX_BYTES, TEAM_INBOX_MAX_MESSAGES, TEAM_MESSAGE_MAX,
  TEAM_MAX_TEAMS, TEAM_INBOX_SEEN_MAX, TEAM_JOIN_MATCH_WINDOW_MS, TEAM_INBOX_FIRST_SCAN_MAX,
} from '../src/constants'
import { TranscriptParser } from '../src/transcript-parser'
import type { AgentEvent } from '../src/protocol'
import { tmpDir, writeTeam, teamConfig, LEAD_SESSION, makeSession, writeJsonl, userText } from './helpers/teams-fixtures'

interface Recorder {
  host: TeamWatcherHost
  infos: Array<{ sessionId: string; payload: TeamInfoPayload }>
  inbox: Array<{ sessionId: string; from: string; to: string; content: string }>
  gone: Array<{ sessionId: string; team: string; names: string[] }>
  tags: Array<{ sessionId: string; tags: TeamSessionTags | null }>
  aliases: string[]
  sessions: Array<{ sessionId: string; filePath: string; startTime: number }>
}

function recorder(sessions: Recorder['sessions'] = [{ sessionId: LEAD_SESSION, filePath: '/nonexistent', startTime: 0 }]): Recorder {
  const r: Recorder = { infos: [], inbox: [], gone: [], tags: [], aliases: [], sessions, host: undefined as unknown as TeamWatcherHost }
  r.host = {
    listSessions: () => r.sessions,
    emitTeamInfo: (sessionId, payload) => { r.infos.push({ sessionId, payload }) },
    emitInbox: (sessionId, from, to, content) => { r.inbox.push({ sessionId, from, to, content }) },
    setLeadAlias: (_s, name) => { r.aliases.push(name) },
    onMembersGone: (sessionId, team, names) => { r.gone.push({ sessionId, team, names: [...names].sort() }) },
    onSessionTags: (sessionId, tags) => { r.tags.push({ sessionId, tags }) },
  }
  return r
}

describe('parseTeamConfig', () => {
  it('parses the observed structure and excludes the lead from members', () => {
    const cfg = parseTeamConfig(teamConfig(), 'demo-team')!
    assert.equal(cfg.name, 'demo-team')
    assert.equal(cfg.leadSessionId, LEAD_SESSION)
    assert.equal(cfg.leadName, 'team-lead')
    assert.deepEqual(cfg.members.map(m => m.name), ['alice'])
    assert.equal(cfg.members[0].color, '#22c55e')
    assert.equal(cfg.members[0].backendType, 'in-process')
  })

  it('rejects malformed configs', () => {
    for (const bad of [null, 'x', 5, [], {}, { leadSessionId: 5 }, { leadSessionId: '../../etc/passwd' }, { leadSessionId: 'a b' }, { leadSessionId: '' }]) {
      assert.equal(parseTeamConfig(bad, 'd'), null, JSON.stringify(bad))
    }
  })

  it('tolerates hostile members: non-objects, missing names, duplicates, bad colors/cwd, huge rosters', () => {
    const members: unknown[] = [null, 'str', 7, [], {}, { name: '' }, { name: 'ok', color: 'not-a-color', cwd: 'bad\u0000cwd', joinedAt: 'nope' }, { name: 'ok' }]
    for (let i = 0; i < TEAM_MAX_MEMBERS + 20; i++) members.push({ name: `m${i}` })
    const cfg = parseTeamConfig({ ...teamConfig(), members }, 'd')!
    assert.equal(cfg.members.length, TEAM_MAX_MEMBERS)
    const ok = cfg.members.find(m => m.name === 'ok')!
    assert.equal(ok.color, undefined)
    assert.equal(ok.cwd, undefined)
    assert.equal(ok.joinedAt, undefined)
    assert.equal(cfg.members.filter(m => m.name === 'ok').length, 1)
  })

  it('falls back to the directory name and derives names from agentId', () => {
    const cfg = parseTeamConfig({ leadSessionId: LEAD_SESSION, members: [{ agentId: 'zed@t' }] }, 'dir-name')!
    assert.equal(cfg.name, 'dir-name')
    assert.deepEqual(cfg.members.map(m => m.name), ['zed'])
  })
})

describe('parseInbox / inboxKeys', () => {
  it('accepts arrays of objects, strings, { messages } and ignores junk', () => {
    const msgs = parseInbox([
      { from: 'team-lead', text: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      'plain string',
      { sender: { name: 'bob' }, content: 'via content' },
      { message: { nested: true } },
      { summary: 'only a summary' },
      { from: 'x' },
      null, 5, [], {},
    ])
    assert.deepEqual(msgs.map(m => m.text), ['hello', 'plain string', 'via content', '{"nested":true}', 'only a summary'])
    assert.equal(msgs[0].from, 'team-lead')
    assert.equal(msgs[2].from, 'bob')
    assert.equal(parseInbox({ messages: [{ text: 'in object' }] })[0].text, 'in object')
    assert.deepEqual(parseInbox('nope'), [])
    assert.deepEqual(parseInbox(null), [])
    assert.deepEqual(parseInbox({}), [])
  })

  it('strips control characters and caps content', () => {
    const [m] = parseInbox([{ text: 'a\u0000b‮' + 'x'.repeat(TEAM_MESSAGE_MAX * 2) }])
    assert.ok(m.text.length <= TEAM_MESSAGE_MAX)
    assert.ok(!/[\u0000‮]/.test(m.text))
  })

  it('keeps only the last TEAM_INBOX_MAX_MESSAGES entries', () => {
    const msgs = parseInbox(Array.from({ length: TEAM_INBOX_MAX_MESSAGES + 50 }, (_, i) => ({ text: `n${i}` })))
    assert.equal(msgs.length, TEAM_INBOX_MAX_MESSAGES)
    assert.equal(msgs[msgs.length - 1].text, `n${TEAM_INBOX_MAX_MESSAGES + 49}`)
  })

  it('keys are stable when the array shifts and distinguish identical messages by occurrence', () => {
    const a = inboxKeys(parseInbox([{ text: 'same' }, { text: 'same' }, { text: 'other' }]))
    assert.equal(new Set(a).size, 3)
    const b = inboxKeys(parseInbox([{ text: 'same' }, { text: 'other' }]))
    assert.equal(b[1], a[2])
    assert.equal(b[0], a[0])
  })
})

describe('matchMemberSession', () => {
  const cands = [
    { sessionId: 's-far', cwd: '/w/a', startMs: 1_000_000 + TEAM_JOIN_MATCH_WINDOW_MS + 1000 },
    { sessionId: 's-near', cwd: '/w/a', startMs: 1_000_500 },
    { sessionId: 's-other-cwd', cwd: '/w/b', startMs: 1_000_100 },
    { sessionId: 's-before', cwd: '/w/a', startMs: 900_000 },
  ]
  it('picks the same-cwd session that started right after joinedAt', () => {
    assert.equal(matchMemberSession({ cwd: '/w/a', joinedAt: 1_000_000 }, cands), 's-near')
  })
  it('skips taken sessions, needs cwd and joinedAt', () => {
    assert.equal(matchMemberSession({ cwd: '/w/a', joinedAt: 1_000_000 }, cands, new Set(['s-near'])), undefined)
    assert.equal(matchMemberSession({ joinedAt: 1_000_000 }, cands), undefined)
    assert.equal(matchMemberSession({ cwd: '/w/a' }, cands), undefined)
  })
})

describe('TeamWatcher scan', () => {
  let root: string
  let watcher: TeamWatcher | undefined
  afterEach(() => { watcher?.dispose(); watcher = undefined; if (root) fs.rmSync(root, { recursive: true, force: true }) })

  function make(rec: Recorder, workspaces: string[] | null = null) {
    watcher = new TeamWatcher({ teamsDir: path.join(root, 'teams'), host: rec.host, workspaces, debounceMs: 0 })
    return watcher
  }

  it('emits team_info once per change for the lead session, with the roster and no lead member', () => {
    root = tmpDir()
    writeTeam(path.join(root, 'teams'), 'demo-team', teamConfig())
    const rec = recorder()
    const w = make(rec)
    w.scan(); w.scan()
    assert.equal(rec.infos.length, 1)
    assert.equal(rec.infos[0].sessionId, LEAD_SESSION)
    assert.equal(rec.infos[0].payload.teamName, 'demo-team')
    assert.equal(rec.infos[0].payload.leadName, 'team-lead')
    assert.deepEqual(rec.infos[0].payload.members.map(m => m.name), ['alice'])
    assert.deepEqual(w.getSessionTags(LEAD_SESSION), { teamName: 'demo-team', memberName: 'team-lead' })
    assert.ok(rec.aliases.includes('team-lead'))

    // roster change -> a second team_info
    writeTeam(path.join(root, 'teams'), 'demo-team', teamConfig({ members: [
      ...(teamConfig().members as unknown[]),
      { agentId: 'bob@demo-team', name: 'bob', backendType: 'in-process', joinedAt: 1_700_000_002_000 },
    ] }))
    w.scan()
    assert.equal(rec.infos.length, 2)
    assert.deepEqual(rec.infos[1].payload.members.map(m => m.name), ['alice', 'bob'])
  })

  it('waits for the lead session to be watched, then emits', () => {
    root = tmpDir()
    writeTeam(path.join(root, 'teams'), 'demo-team', teamConfig())
    const rec = recorder([])
    const w = make(rec)
    w.scan()
    assert.equal(rec.infos.length, 0)
    rec.sessions.push({ sessionId: LEAD_SESSION, filePath: '/nonexistent', startTime: 0 })
    w.scan()
    assert.equal(rec.infos.length, 1)
  })

  it('debounces rapid roster changes', async () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    writeTeam(teams, 'demo-team', teamConfig())
    const rec = recorder()
    watcher = new TeamWatcher({ teamsDir: teams, host: rec.host, workspaces: null, debounceMs: 40 })
    watcher.scan()
    assert.equal(rec.infos.length, 1, 'first discovery is immediate')
    writeTeam(teams, 'demo-team', teamConfig({ members: [{ name: 'x1' }] }))
    watcher.scan()
    writeTeam(teams, 'demo-team', teamConfig({ members: [] }))
    watcher.scan()
    assert.equal(rec.infos.length, 1)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(rec.infos.length, 2, 'only the latest state is emitted')
    assert.deepEqual(rec.infos[1].payload.members, [])
  })

  it('reports members that left the roster and whole teams that vanished as gone', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    writeTeam(teams, 'demo-team', teamConfig())
    const rec = recorder()
    const w = make(rec)
    w.scan()
    writeTeam(teams, 'demo-team', teamConfig({ members: [(teamConfig().members as unknown[])[0]] }))
    w.scan()
    assert.deepEqual(rec.gone, [{ sessionId: LEAD_SESSION, team: 'demo-team', names: ['alice'] }])
    fs.rmSync(path.join(teams, 'demo-team'), { recursive: true })
    w.scan()
    assert.equal(w.teamCount, 0)
  })

  it('a malformed or half-written config neither throws nor drops the known team', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    writeTeam(teams, 'demo-team', teamConfig())
    const rec = recorder()
    const w = make(rec)
    w.scan()
    fs.writeFileSync(path.join(teams, 'demo-team', 'config.json'), '{"name": "demo-team", "lead')
    assert.doesNotThrow(() => w.scan())
    assert.equal(w.teamCount, 1)
    assert.equal(rec.gone.length, 0)
    writeTeam(teams, 'broken', 'not json at all')
    writeTeam(teams, 'wrongshape', JSON.stringify([1, 2, 3]))
    assert.doesNotThrow(() => w.scan())
    assert.equal(w.teamCount, 1)
  })

  it('refuses an oversized config.json', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    writeTeam(teams, 'huge', teamConfig({ padding: 'x'.repeat(TEAM_CONFIG_MAX_BYTES + 10) }))
    const rec = recorder()
    make(rec).scan()
    assert.equal(rec.infos.length, 0)
  })

  it('does not follow a config.json symlink, a symlinked team dir or a symlinked inboxes dir out of the teams root', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(teams, { recursive: true })
    // outside tree holding a valid config + an inbox with a message
    writeTeam(outside, 'evil', teamConfig(), { alice: [{ from: 'x', text: 'stolen' }] })
    // 1) team dir is a symlink to the outside team
    fs.symlinkSync(path.join(outside, 'evil'), path.join(teams, 'linked-team'))
    // 2) config.json is a symlink
    fs.mkdirSync(path.join(teams, 'cfg-link'))
    fs.symlinkSync(path.join(outside, 'evil', 'config.json'), path.join(teams, 'cfg-link', 'config.json'))
    // 3) real team with a symlinked inboxes dir
    fs.mkdirSync(path.join(teams, 'inbox-link'))
    fs.writeFileSync(path.join(teams, 'inbox-link', 'config.json'), JSON.stringify(teamConfig({ name: 'inbox-link' })))
    fs.symlinkSync(path.join(outside, 'evil', 'inboxes'), path.join(teams, 'inbox-link', 'inboxes'))
    // 4) real team with a symlinked inbox file
    writeTeam(teams, 'file-link', teamConfig({ name: 'file-link' }))
    fs.symlinkSync(path.join(outside, 'evil', 'inboxes', 'alice.json'), path.join(teams, 'file-link', 'inboxes', 'alice.json'))

    const rec = recorder()
    const w = make(rec)
    w.scan()
    assert.equal(rec.inbox.length, 0, 'nothing may be read through symlinks')
    // only the two real teams (inbox-link, file-link) produce team_info; the symlinked ones do not
    const names = rec.infos.map(i => i.payload.teamName).sort()
    assert.deepEqual(names, ['file-link', 'inbox-link'])
  })

  it('serves only teams of the watched workspace unless all workspaces are enabled', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    const ws = path.join(root, 'ws')
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
    const other = '66666666-6666-4666-8666-666666666666'
    writeTeam(teams, 'mine', teamConfig({ name: 'mine', leadSessionId: other, members: [{ name: 'a', cwd: path.join(ws, 'sub'), backendType: 'tmux' }] }))
    writeTeam(teams, 'foreign', teamConfig({ name: 'foreign', leadSessionId: '77777777-7777-4777-8777-777777777777', members: [{ name: 'a', cwd: '/somewhere/else', backendType: 'tmux' }] }))
    const rec = recorder([
      { sessionId: other, filePath: '/nonexistent', startTime: 0 },
      { sessionId: '77777777-7777-4777-8777-777777777777', filePath: '/nonexistent', startTime: 0 },
    ])
    const scoped = new TeamWatcher({ teamsDir: teams, host: rec.host, workspaces: [ws], debounceMs: 0 })
    scoped.scan()
    // 'foreign' is also served because its lead session is one this relay watches (leadSessionId rule)
    assert.deepEqual(rec.infos.map(i => i.payload.teamName).sort(), ['foreign', 'mine'])
    scoped.dispose()

    const rec2 = recorder([])
    const scoped2 = new TeamWatcher({ teamsDir: teams, host: rec2.host, workspaces: [ws], debounceMs: 0 })
    scoped2.scan()
    assert.equal(scoped2.teamCount, 1, 'only the team with a member cwd in the workspace is tracked')
    scoped2.dispose()
    const rec3 = recorder([])
    const all = new TeamWatcher({ teamsDir: teams, host: rec3.host, workspaces: null, debounceMs: 0 })
    all.scan()
    assert.equal(all.teamCount, 2)
    all.dispose()
    watcher = undefined
  })

  it('bounds the number of tracked teams', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    for (let i = 0; i < TEAM_MAX_TEAMS + 10; i++) {
      writeTeam(teams, `t${String(i).padStart(3, '0')}`, teamConfig({ name: `t${i}` }))
    }
    const w = make(recorder())
    w.scan()
    assert.ok(w.teamCount <= TEAM_MAX_TEAMS)
  })

  it('resolves a tmux member to its separate session by cwd + joinedAt and tags it', () => {
    root = tmpDir()
    const teams = path.join(root, 'teams')
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    const joined = Date.now() - 60_000
    const memberSession = '22222222-2222-4222-8222-222222222222'
    const unrelated = '33333333-3333-4333-8333-333333333333'
    const memberFile = path.join(root, `${memberSession}.jsonl`)
    const otherFile = path.join(root, `${unrelated}.jsonl`)
    writeJsonl(memberFile, [{ type: 'user', cwd: work, timestamp: new Date(joined + 3000).toISOString(), message: { role: 'user', content: 'hi' } }])
    writeJsonl(otherFile, [{ type: 'user', cwd: path.join(root, 'elsewhere'), timestamp: new Date(joined + 2000).toISOString(), message: { role: 'user', content: 'hi' } }])
    writeTeam(teams, 'demo-team', teamConfig({ members: [
      (teamConfig().members as unknown[])[0],
      { agentId: 'tm@demo-team', name: 'tm', agentType: 'general-purpose', joinedAt: joined, tmuxPaneId: '%3', cwd: work, backendType: 'tmux' },
      { agentId: 'ip@demo-team', name: 'ip', joinedAt: joined, cwd: work, backendType: 'in-process' },
    ] }))
    const rec = recorder([
      { sessionId: LEAD_SESSION, filePath: '/nonexistent', startTime: 0 },
      { sessionId: memberSession, filePath: memberFile, startTime: Date.now() },
      { sessionId: unrelated, filePath: otherFile, startTime: Date.now() },
    ])
    const w = make(rec)
    w.scan()
    const members = rec.infos[0].payload.members
    assert.equal(members.find(m => m.name === 'tm')?.sessionId, memberSession)
    assert.equal(members.find(m => m.name === 'ip')?.sessionId, undefined)
    assert.deepEqual(w.getSessionTags(memberSession), { teamName: 'demo-team', memberName: 'tm' })
    assert.equal(w.getSessionTags(unrelated), undefined)
    w.forgetSession(memberSession)
    assert.equal(w.getSessionTags(memberSession), undefined)
  })

  describe('inboxes', () => {
    it('emits each message once, to the inbox owner, from the sender or the lead as fallback', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      writeTeam(teams, 'demo-team', teamConfig(), {
        alice: [{ from: 'bob', text: 'ping', timestamp: '2025-01-01T00:00:00Z' }, 'bare string', { content: 'no sender' }],
        'team-lead': [],
      })
      const rec = recorder()
      const w = make(rec)
      w.scan(); w.scan()
      assert.deepEqual(rec.inbox.map(m => [m.from, m.to, m.content]), [
        ['bob', 'alice', 'ping'], ['team-lead', 'alice', 'bare string'], ['team-lead', 'alice', 'no sender'],
      ])
      assert.ok(rec.inbox.every(m => m.sessionId === LEAD_SESSION))

      // an appended message is the only new one
      const file = path.join(teams, 'demo-team', 'inboxes', 'alice.json')
      fs.writeFileSync(file, JSON.stringify([{ from: 'bob', text: 'ping', timestamp: '2025-01-01T00:00:00Z' }, 'bare string', { content: 'no sender' }, { from: 'bob', text: 'second' }]))
      w.scan()
      assert.equal(rec.inbox.length, 4)
      assert.equal(rec.inbox[3].content, 'second')
    })

    it('an emptied (delivered) inbox forgets its keys so an identical later message is new again', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      writeTeam(teams, 'demo-team', teamConfig(), { alice: [{ from: 'bob', text: 'again' }] })
      const rec = recorder()
      const w = make(rec)
      const file = path.join(teams, 'demo-team', 'inboxes', 'alice.json')
      w.scan()
      fs.writeFileSync(file, '[]')
      w.scan()
      fs.writeFileSync(file, JSON.stringify([{ from: 'bob', text: 'again' }]))
      w.scan()
      assert.equal(rec.inbox.length, 2)
    })

    it('tolerates garbage inbox files and unsafe names; does not emit before the lead is watched', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      writeTeam(teams, 'demo-team', teamConfig(), {
        broken: '{not json', obj: JSON.stringify({ messages: [{ text: 'in messages' }] }), num: '5', nul: 'null',
      })
      fs.writeFileSync(path.join(teams, 'demo-team', 'inboxes', 'notjson.txt'), 'x')
      const rec = recorder([])
      const w = make(rec)
      assert.doesNotThrow(() => w.scan())
      assert.equal(rec.inbox.length, 0)
      rec.sessions.push({ sessionId: LEAD_SESSION, filePath: '/nonexistent', startTime: 0 })
      w.scan()
      assert.deepEqual(rec.inbox.map(m => m.content), ['in messages'])
    })

    it('ignores an oversized inbox file whose single message exceeds the whole window', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      writeTeam(teams, 'demo-team', teamConfig(), { alice: [{ from: 'bob', text: 'y'.repeat(TEAM_INBOX_MAX_BYTES + 10) }] })
      const rec = recorder()
      make(rec).scan()
      assert.equal(rec.inbox.length, 0)
    })

    it('reads the TAIL of an inbox larger than TEAM_INBOX_MAX_BYTES instead of skipping it', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      const msgs = Array.from({ length: 6000 }, (_, i) => ({ from: 'bob', text: `message number ${i} ${'x'.repeat(100)}`, timestamp: '2025-01-01T00:00:00Z' }))
      writeTeam(teams, 'demo-team', teamConfig(), { alice: JSON.stringify(msgs, null, 2) })
      const file = path.join(teams, 'demo-team', 'inboxes', 'alice.json')
      assert.ok(fs.statSync(file).size > TEAM_INBOX_MAX_BYTES)
      const rec = recorder()
      make(rec).scan()
      assert.ok(rec.inbox.length > 0, 'the newest messages are delivered')
      assert.ok(rec.inbox[rec.inbox.length - 1].content.startsWith('message number 5999 '))
      assert.ok(rec.inbox.every(m => !m.content.startsWith('message number 0 ')))
    })

    it('replays only the newest messages of an inbox seen for the first time, then every new one', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      const history = Array.from({ length: 150 }, (_, i) => ({ from: 'bob', text: `old ${i}` }))
      writeTeam(teams, 'demo-team', teamConfig(), { alice: history })
      const rec = recorder()
      const w = make(rec)
      w.scan()
      assert.equal(rec.inbox.length, TEAM_INBOX_FIRST_SCAN_MAX)
      assert.equal(rec.inbox[rec.inbox.length - 1].content, 'old 149')
      const file = path.join(teams, 'demo-team', 'inboxes', 'alice.json')
      fs.writeFileSync(file, JSON.stringify([...history, { from: 'bob', text: 'fresh' }]))
      w.scan()
      assert.equal(rec.inbox.length, TEAM_INBOX_FIRST_SCAN_MAX + 1, 'old messages are remembered, not replayed again')
      assert.equal(rec.inbox[rec.inbox.length - 1].content, 'fresh')
    })

    it('parseInboxTail drops the cut head and tolerates garbage', () => {
      const whole = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ from: 'a', text: `m${i}` })))
      const cut = whole.slice(whole.indexOf('"m4"'))
      const parsed = parseInboxTail(cut) as Array<{ text: string }>
      assert.deepEqual(parsed.map(m => m.text), ['m5', 'm6', 'm7', 'm8', 'm9'])
      assert.equal(parseInboxTail('no objects here'), undefined)
      assert.equal(parseInboxTail('{"a":1}, {"b": '), undefined)
    })

    it('remembers a bounded number of keys per inbox', () => {
      root = tmpDir()
      const teams = path.join(root, 'teams')
      writeTeam(teams, 'demo-team', teamConfig(), { alice: [{ text: 'seed' }] })
      const rec = recorder()
      const w = make(rec)
      const file = path.join(teams, 'demo-team', 'inboxes', 'alice.json')
      // many successive appends: the window of 200 messages slides, memory stays bounded
      let all: unknown[] = []
      for (let i = 0; i < TEAM_INBOX_SEEN_MAX / 100 + 5; i++) {
        all = all.concat(Array.from({ length: 150 }, (_, j) => ({ from: 'b', text: `msg-${i}-${j}` })))
        fs.writeFileSync(file, JSON.stringify(all.slice(-TEAM_INBOX_MAX_MESSAGES)))
        w.scan()
      }
      assert.ok(rec.inbox.length > 0)
    })
  })

  it('stops everything on dispose', () => {
    root = tmpDir()
    writeTeam(path.join(root, 'teams'), 'demo-team', teamConfig())
    const rec = recorder()
    const w = make(rec)
    w.start()
    w.dispose()
    const before = rec.infos.length
    w.scan()
    assert.equal(rec.infos.length, before)
    assert.equal(w.teamCount, 0)
  })
})

describe('toTeamInfoPayload / readSessionHeader', () => {
  it('maps member sessions and drops absent optionals', () => {
    const cfg = parseTeamConfig(teamConfig(), 'd')!
    const p = toTeamInfoPayload(cfg, new Map([['alice', 'sess-9']]))
    assert.equal(p.members[0].sessionId, 'sess-9')
    assert.ok(!('sessionId' in toTeamInfoPayload(cfg).members[0]))
  })

  it('reads cwd and the first timestamp from the head, ignores partial or binary content', () => {
    const dir = tmpDir()
    try {
      const f = path.join(dir, 's.jsonl')
      fs.writeFileSync(f, '{"type":"summary"}\n{"type":"user","cwd":"/w/x","timestamp":"2025-03-01T10:00:00.000Z"}\n{"type":"user","cwd":"/w/y"')
      assert.deepEqual(readSessionHeader(f), { cwd: '/w/x', startMs: Date.parse('2025-03-01T10:00:00.000Z') })
      fs.writeFileSync(f, Buffer.from([0, 1, 2, 255, 254]))
      assert.deepEqual(readSessionHeader(f), {})
      assert.deepEqual(readSessionHeader(path.join(dir, 'missing')), {})
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('message dedupe across transcript and inbox sources', () => {
  function parserHarness() {
    const session = makeSession()
    const events: AgentEvent[] = []
    const parser = new TranscriptParser({
      emit: (e) => { events.push(e) }, elapsed: () => 0, getSession: () => session,
      fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
    })
    return { parser, events, session }
  }
  const sendMessageLine = (to: string, message: string) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${Math.random()}`, name: 'SendMessage', input: { to, message, summary: 's' } }] },
  })
  const sent = (events: AgentEvent[]) => events.filter(e => e.type === 'message_sent')
  const links = (events: AgentEvent[]) => events.filter(e => e.type === 'agent_link')

  it('a SendMessage tool_use and the inbox echo of the same text produce ONE message and one link', () => {
    const { parser, events, session } = parserHarness()
    parser.processTranscriptLine(sendMessageLine('alice', 'Please review the cache layer.'), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    parser.emitInboxMessage('s1', 'team-lead', 'alice', '  please   REVIEW the cache layer. ')
    assert.equal(sent(events).length, 1)
    assert.equal(links(events).length, 1)
    assert.equal(sent(events)[0].payload.from, 'orchestrator')
    assert.equal(sent(events)[0].payload.source, undefined)
  })

  it('inbox first, then the transcript copy: still one message, tagged source inbox', () => {
    const { parser, events, session } = parserHarness()
    parser.emitInboxMessage('s1', 'team-lead', 'alice', 'Ship it')
    parser.processTranscriptLine(sendMessageLine('alice', 'Ship it'), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    assert.equal(sent(events).length, 1)
    assert.equal(sent(events)[0].payload.source, 'inbox')
  })

  it('different text, different pair, or outside the window are separate messages', () => {
    const d = new MessageDeduper(1000, 10)
    assert.equal(d.accept('l1', 'hello', 0), true)
    assert.equal(d.accept('l1', 'Hello', 500), false)
    assert.equal(d.accept('l1', 'hello world', 500), true)
    assert.equal(d.accept('l2', 'hello', 500), true)
    assert.equal(d.accept('l1', 'hello', 1500), true)
  })

  it('the lead name maps to the orchestrator node and a self-message is dropped', () => {
    const { parser, events } = parserHarness()
    parser.setLeadAlias('s1', 'boss')
    parser.emitInboxMessage('s1', 'alice', 'boss', 'done')
    assert.equal(sent(events)[0].payload.to, 'orchestrator')
    assert.equal(sent(events)[0].payload.linkId, 'teammate:alice>orchestrator')
    parser.emitInboxMessage('s1', 'boss', 'orchestrator', 'self')
    assert.equal(sent(events).length, 1)
  })

  it('inbox messages get the source and sessionId, empty content is dropped, state is freed on clear', () => {
    const { parser, events } = parserHarness()
    parser.emitInboxMessage('s1', 'a', 'b', '')
    parser.emitInboxMessage('s1', 'a\u0000', 'b', 'x')
    assert.equal(sent(events).length, 1)
    assert.equal(sent(events)[0].payload.sessionId, 's1')
    assert.equal(sent(events)[0].payload.source, 'inbox')
    parser.clearSessionState([], 's1')
    parser.emitInboxMessage('s1', 'a', 'b', 'x')
    assert.equal(sent(events).length, 2, 'dedupe memory was released with the session')
    assert.equal(links(events).length, 2)
  })

  it('SendMessage without usable text keeps the link but emits no empty message', () => {
    const r = extractToolUseLinks('SendMessage', { to: 'alice' }, 'orchestrator', 'tu1')
    assert.ok(r?.link)
    assert.equal(r?.message, undefined)
  })

  it('userText fixture sanity (teammate-message echo is deduped against SendMessage)', () => {
    const { parser, events, session } = parserHarness()
    parser.processTranscriptLine(sendMessageLine('alice', 'Audit the parser'), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    parser.processTranscriptLine(JSON.stringify(userText('<teammate-message teammate_id="team-lead" summary="s">Audit the parser</teammate-message>')), 'alice', new Map(), new Set(), 's1')
    assert.equal(sent(events).length, 1)
  })
})
