/**
 * Relay + Agent Teams (#42, #35, #37): a synthetic ~/.claude tree in a fake HOME with a lead
 * session, an idle and a working in-process teammate, a tmux member running as its own session,
 * a team config and inboxes. The relay must show every teammate, report team_info, tag the
 * tmux session and turn inbox files into message_sent (once, deduplicated).
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-teams-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const LEAD = '11111111-1111-4111-8111-111111111111'
const TMUX_MEMBER = '22222222-2222-4222-8222-222222222222'

type Ev = { type: string; payload: Record<string, unknown>; sessionId?: string }

interface Snapshot { events: Ev[]; sessionList: Array<Record<string, unknown>> }

function snapshot(port: number): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => { buf += c })
      setTimeout(() => {
        req.destroy()
        const events: Ev[] = []
        let sessionList: Array<Record<string, unknown>> = []
        for (const block of buf.split('\n\n')) {
          if (!block.startsWith('data: ')) continue
          const msg = JSON.parse(block.slice(6))
          if (msg.type === 'agent-event') events.push(msg.event)
          else if (msg.type === 'agent-event-batch') events.push(...msg.events)
          else if (msg.type === 'session-list') sessionList = msg.sessions
        }
        resolve({ events, sessionList })
      }, 700)
    })
    req.on('error', reject)
  })
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const HOUR = 3_600_000

describe('relay with an Agent Team', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0
  let snap: Snapshot

  before(async () => {
    const ws = path.join(fakeHome, 'work', 'demo')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    const subDir = path.join(projectDir, LEAD, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const joined = Date.now() - 60_000

    // Lead session: spawns teammates and sends one message
    fs.writeFileSync(path.join(projectDir, `${LEAD}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date(joined - 5000).toISOString(), message: { role: 'user', content: 'Build the feature with a team' } }) +
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-send', name: 'SendMessage', input: { to: 'alice', message: 'Please review the cache layer.' } }] } }))

    // Idle in-process teammate (written an hour ago)
    const alice = path.join(subDir, 'agent-alice001.jsonl')
    fs.writeFileSync(alice,
      line({ type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="team-lead" summary="review">Please review the cache layer.</teammate-message>' } }) +
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed. All good.' }] } }))
    fs.writeFileSync(path.join(subDir, 'agent-alice001.meta.json'), JSON.stringify({
      agentType: 'alice', description: 'review', name: 'alice', model: 'claude-sonnet-4-5', taskKind: 'in_process_teammate',
      teamName: 'demo-team', color: '#10b981', spawnedAgentType: 'general-purpose', permissionMode: 'default', spawnDepth: 1,
    }))
    fs.utimesSync(alice, (Date.now() - HOUR) / 1000, (Date.now() - HOUR) / 1000)

    // Working in-process teammate (pending tool call)
    const bob = path.join(subDir, 'agent-bob00002.jsonl')
    fs.writeFileSync(bob, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'make test' } }] } }))
    fs.writeFileSync(path.join(subDir, 'agent-bob00002.meta.json'), JSON.stringify({
      agentType: 'bob', name: 'bob', taskKind: 'in_process_teammate', teamName: 'demo-team', color: 'not-a-color', spawnedAgentType: 'Explore',
    }))

    // tmux member: its own session in the same workspace, started right after joinedAt
    fs.writeFileSync(path.join(projectDir, `${TMUX_MEMBER}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date(joined + 2000).toISOString(), message: { role: 'user', content: 'You are carol, a teammate' } }))

    // Team config + inboxes (one shape variety each); a symlinked inbox must be ignored
    const teams = path.join(fakeHome, '.claude', 'teams')
    const teamDir = path.join(teams, 'demo-team')
    fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true })
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'demo-team', createdAt: joined, leadAgentId: 'team-lead@demo-team', leadSessionId: LEAD,
      members: [
        { agentId: 'team-lead@demo-team', name: 'team-lead', agentType: 'team-lead', joinedAt: joined, tmuxPaneId: 'leader', cwd: realWs, subscriptions: [], backendType: 'in-process' },
        { agentId: 'alice@demo-team', name: 'alice', agentType: 'general-purpose', joinedAt: joined + 1, tmuxPaneId: 'in-process', cwd: realWs, subscriptions: [], backendType: 'in-process', color: '#10b981' },
        { agentId: 'carol@demo-team', name: 'carol', agentType: 'general-purpose', joinedAt: joined, tmuxPaneId: '%4', cwd: realWs, subscriptions: [], backendType: 'tmux' },
      ],
    }))
    // Same text as the lead's SendMessage: must collapse into the one message
    fs.writeFileSync(path.join(teamDir, 'inboxes', 'alice.json'), JSON.stringify([{ from: 'team-lead', text: 'Please review the cache layer.', timestamp: new Date(joined).toISOString() }]))
    fs.writeFileSync(path.join(teamDir, 'inboxes', 'bob.json'), JSON.stringify(['a bare string message']))
    fs.writeFileSync(path.join(teamDir, 'inboxes', 'team-lead.json'), '[]')
    const outside = path.join(fakeHome, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.json'), JSON.stringify([{ from: 'x', text: 'SECRET-FROM-OUTSIDE' }]))
    fs.symlinkSync(path.join(outside, 'secret.json'), path.join(teamDir, 'inboxes', 'carol.json'))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => relay.handleSSE(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
    snap = await snapshot(port)
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  const ofType = (t: string) => snap.events.filter(e => e.type === t && e.sessionId === LEAD)

  it('shows the idle and the working teammate with team extras and activity, never completing them', () => {
    const spawns = ofType('agent_spawn').filter(e => e.payload.kind === 'teammate')
    const byName = new Map(spawns.map(e => [String(e.payload.name), e.payload]))
    assert.ok(byName.has('alice'), 'idle teammate announced')
    assert.ok(byName.has('bob'), 'working teammate announced')
    assert.equal(byName.get('alice')?.teamName, 'demo-team')
    assert.equal(byName.get('alice')?.color, '#10b981')
    assert.equal(byName.get('bob')?.color, undefined, 'invalid color dropped')
    const act = new Map(ofType('agent_activity').map(e => [String(e.payload.name), e.payload.activity]))
    assert.equal(act.get('alice'), 'idle')
    assert.equal(act.get('bob'), 'working')
    assert.ok(!ofType('agent_complete').some(e => e.payload.name === 'alice' || e.payload.name === 'bob'))
    const replayed = ofType('message').filter(e => e.payload.agent === 'alice').map(e => e.payload.content)
    assert.ok(replayed.includes('Reviewed. All good.'), 'history replayed')
  })

  it('emits team_info for the lead session with the tmux member resolved to its session', () => {
    const infos = ofType('team_info')
    assert.ok(infos.length >= 1)
    const info = infos[infos.length - 1].payload as { teamName: string; leadName: string; members: Array<{ name: string; sessionId?: string }> }
    assert.equal(info.teamName, 'demo-team')
    assert.equal(info.leadName, 'team-lead')
    assert.deepEqual(info.members.map(m => m.name).sort(), ['alice', 'carol'])
    assert.equal(info.members.find(m => m.name === 'carol')?.sessionId, TMUX_MEMBER)
  })

  it('tags the lead and the tmux member sessions in the session list', () => {
    const lead = snap.sessionList.find(s => s.id === LEAD)!
    const member = snap.sessionList.find(s => s.id === TMUX_MEMBER)!
    assert.equal(lead.teamName, 'demo-team')
    assert.equal(lead.memberName, 'team-lead')
    assert.equal(lead.runtime, 'claude')
    assert.equal(typeof lead.cwd, 'string')
    assert.equal(typeof lead.workspace, 'string')
    assert.equal(member.teamName, 'demo-team')
    assert.equal(member.memberName, 'carol')
  })

  it('turns inbox files into message_sent once, merged with the SendMessage copy, ignoring symlinks', () => {
    const sent = ofType('message_sent')
    const toAlice = sent.filter(e => e.payload.to === 'alice' && /review the cache layer/i.test(String(e.payload.content)))
    assert.equal(toAlice.length, 1, 'transcript + inbox copies are ONE message')
    assert.equal(toAlice[0].payload.from, 'orchestrator')
    const toBob = sent.filter(e => e.payload.to === 'bob')
    assert.equal(toBob.length, 1)
    assert.equal(toBob[0].payload.source, 'inbox')
    assert.equal(toBob[0].payload.from, 'orchestrator', 'sender-less messages come from the lead')
    assert.ok(!JSON.stringify(snap.events).includes('SECRET-FROM-OUTSIDE'))
    const links = ofType('agent_link').filter(e => e.payload.to === 'bob')
    assert.equal(links.length, 1)
  })
})
