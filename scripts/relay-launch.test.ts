/**
 * Launching an agent from the relay (#229 PR 2), end to end through createRelay with an injected spawn, issue lookup and
 * origin: the route is ON only with options.launch; the SSE `launch` events and GET /status carry the observed state to
 * LOCAL clients only; the session is "seen" only when a transcript of OUR --session-id appears; dispose kills the children.
 * The relay is a per-process singleton, so the OFF case lives in relay-launch-off.test.ts.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { encodeProjectDirName } from '../extension/src/project-dir'
import { isStatusPath, isLaunchPath } from '../extension/src/relay-guards'
import type { JournalEntry } from './launch-supervisor'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-launch-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const REPO = 'j0hn-42/agent-lens'
const TOKEN = 'c'.repeat(64)
const TUNNEL = 'box.tail1234.ts.net'
const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'

class FakeChild extends EventEmitter {
  pid: number
  stdout = new EventEmitter(); stderr = new EventEmitter()
  constructor(pid: number) { super(); this.pid = pid }
  kill() { return true }
}

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let ws = ''
const children: FakeChild[] = []
const kills: Array<[number, string]> = []
const journal: JournalEntry[] = []
let tokenSeen = ''

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }
let ua = 0
function request(method: string, urlPath: string, opts: { body?: string; headers?: http.OutgoingHttpHeaders } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': `relay-launch-${++ua}`, ...opts.headers }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
const launch = (issue = 229, extra: http.OutgoingHttpHeaders = {}) => request('POST', '/launch', {
  body: JSON.stringify({ repo: REPO, issue, role: 'backend-engineer' }),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...extra },
})

interface Sse { messages: any[]; close: () => void; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }
function openSse(headers: http.OutgoingHttpHeaders = {}): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{ pred: (m: any) => boolean; done: (m: any) => void }> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          if (!frame.startsWith('data: ')) continue
          let m: any
          try { m = JSON.parse(frame.slice(6)) } catch { continue }
          messages.push(m)
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m) }
        }
      })
      resolve({
        messages, close: () => req.destroy(),
        waitFor: (pred, ms = 3000) => {
          const seen = messages.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('timed out waiting for an SSE message')), ms)
            waiters.push({ pred, done: m => { clearTimeout(t); res2(m) } })
          })
        },
      })
    })
    req.on('error', reject)
  })
}

describe('relay launch (#229)', () => {
  before(async () => {
    ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    ws = fs.realpathSync(ws)
    const { createRelay } = await import('./relay')
    // Fail closed: ON without an allow-list, or with a malformed one, does not start
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: [] } }), /launch/)
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: ['https://github.com/a/b'] } }), /launch/)
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: [REPO], budgetUsd: 9999 } }), /budget/)
    // maxConcurrent is validated with the other options, before the relay is marked as created (the next call would
    // otherwise be refused with "can only be called once")
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: [REPO], maxConcurrent: 3 } }), /maxConcurrent/)
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: [REPO], maxConcurrent: 0 } }), /maxConcurrent/)
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', launch: { repos: [REPO], maxConcurrent: 1.5 } }), /maxConcurrent/)
    let pid = 7000
    relay = await createRelay({
      workspace: ws, runtime: 'claude', allowedHosts: [TUNNEL],
      launch: {
        repos: [REPO], token: TOKEN, maxConcurrent: 2, onToken: t => { tokenSeen = t },
        journal: { append: e => { journal.push(e); return true } },
        spawn: () => { const c = new FakeChild(++pid); children.push(c); return c as never },
        killGroup: (p, s) => { kills.push([p, s]) },
        workspaceOrigin: async () => `git@github.com:${REPO}.git`,
        lookupIssue: async cmd => JSON.stringify({
          number: Number(cmd.args[3].split('/').pop()), html_url: `https://github.com/${REPO}/issues/${cmd.args[3].split('/').pop()}`,
          state: 'open', title: 't', body: 'b', author_association: 'OWNER', labels: [{ name: 'agent:backend-engineer' }],
        }),
      },
    })
    server = http.createServer((req, res) => {
      if (isStatusPath(req.url)) return relay.handleStatus(req, res)
      if (isLaunchPath(req.url)) return relay.handleLaunch(req, res)
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => { relay.dispose(); server.close(); fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('is on, and hands the token to the console callback only', async () => {
    assert.equal(relay.launchEnabled, true)
    assert.equal(tokenSeen, TOKEN)
    const status = await request('GET', '/status')
    assert.equal(status.body.includes(TOKEN), false)
    assert.equal((await request('POST', '/launch', { body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401)
  })

  let id = ''
  let sessionId = ''
  let sse: Sse

  it('requested -> started -> session, each state announced to a local SSE client only when observed', async () => {
    sse = await openSse()
    const r = await launch()
    assert.equal(r.status, 202)
    const l = JSON.parse(r.body).launch
    id = l.id; sessionId = l.sessionId
    assert.equal(l.state, 'requested')
    const requested = await sse.waitFor(m => m.type === 'launch' && m.launch.id === id && m.launch.state === 'requested')
    assert.equal(requested.launch.pid, undefined)

    children[0].emit('spawn')
    const startedMsg = await sse.waitFor(m => m.type === 'launch' && m.launch.id === id && m.launch.state === 'started')
    assert.equal(startedMsg.launch.pid, 7001)
    // Started is not "session": no transcript of our uuid exists yet
    const status = JSON.parse((await request('GET', '/status')).body)
    assert.equal(status.launch.launches[0].state, 'started')
    assert.equal(status.launch.maxConcurrent, 2, 'the value the supervisor applies, not a default')

    // The transcript of the SAME uuid appears in the project folder of the worktree: only now the session is seen
    const worktree = path.join(ws, '.claude', 'worktrees', 'issue-229-backend-engineer')
    const dir = path.join(fakeHome, '.claude', 'projects', encodeProjectDirName(worktree))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl'), line)
    const other = await openSse() // a connection triggers a scan
    await new Promise(res => setTimeout(res, 300))
    assert.equal(relay.debugState().watchedSessions >= 1, true)
    assert.equal(JSON.parse((await request('GET', '/status')).body).launch.launches[0].state, 'started', 'another session id proves nothing')
    other.close()

    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), line)
    const third = await openSse()
    const seen = await sse.waitFor(m => m.type === 'launch' && m.launch.id === id && m.launch.state === 'session')
    assert.equal(typeof seen.launch.sessionSeenAt, 'number')
    third.close()
  })

  it('a client that connects later is told the launches, with the same view', async () => {
    const late = await openSse()
    const list = await late.waitFor(m => m.type === 'launch-list')
    assert.equal(list.launches[0].id, id)
    assert.equal(list.launches[0].state, 'session')
    late.close()
  })

  it('a tunnel Host never receives the launches: not in the stream, not in /status', async () => {
    const remote = await openSse({ Host: TUNNEL })
    await new Promise(res => setTimeout(res, 300))
    assert.equal(relay.debugState().remoteSseClients, 1, 'the tunnel client is really connected')
    assert.equal(remote.messages.some(m => m.type === 'launch-list' || m.type === 'launch'), false)
    remote.close()
    const status = await request('GET', '/status', { headers: { Host: TUNNEL } })
    assert.equal(status.status, 200)
    assert.equal('launch' in JSON.parse(status.body), false)
    // And the launch routes are loopback only, token or not
    const viaTunnel = await launch(230, { Host: TUNNEL })
    assert.equal(viaTunnel.status, 403)
  })

  it('stop: SIGTERM to the group, "stopped" once the exit is seen, the slot is free again', async () => {
    const r = await request('POST', `/launch/${id}/stop`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(r.status, 202)
    assert.deepEqual(kills, [[7001, 'SIGTERM']])
    children[0].emit('exit', null, 'SIGTERM')
    const ended = await sse.waitFor(m => m.type === 'launch' && m.launch.id === id && m.launch.state === 'stopped')
    assert.equal(ended.launch.signal, 'SIGTERM')
    assert.equal(journal.some(e => e.event === 'ended' && e.state === 'stopped' && e.uuid === sessionId), true)
  })

  it('dispose kills the children that are still running', async () => {
    const r = await launch(231)
    assert.equal(r.status, 202)
    children[1].emit('spawn')
    sse.close()
    relay.dispose()
    assert.deepEqual(kills.at(-1), [7002, 'SIGKILL'])
    assert.equal(journal.some(e => e.event === 'killed-on-dispose'), true)
  })
})
