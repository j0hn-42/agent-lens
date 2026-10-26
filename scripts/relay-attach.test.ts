/**
 * The relay while a session is attached over several ticks (#651), over a real relay, a real big transcript and the
 * standalone app's request handler. Everything in before() happens while the startup attach is still running (checked:
 * `debugState().attaching`), the assertions read what came out once it ended:
 *  - a live hook of that session (a permission prompt) still triggers its webhook; the history does not;
 *  - an SSE client accepted meanwhile joins once the attach ended: the session list and the replay hold the session, once;
 *  - a client gone before it joins is never added;
 *  - waiting clients count toward the SSE cap (#200) and, through a tunnel, toward the remote cap (#241);
 *  - a queued session whose transcript can no longer be read when its turn comes is dropped (no unhandled rejection).
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listenLoopback } from './server-hardening'
import { RELAY_MAX_REMOTE_SSE_CLIENTS, RELAY_MAX_SSE_CLIENTS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-attach-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_WEBHOOKS
delete process.env.AGENT_LENS_IMPORT

const BIG = '65165165-0651-4651-8651-000000000001'
const GONE = '65165165-0651-4651-8651-000000000002'
const TUNNEL = 'box.tail0651.ts.net'
/** Big enough for the attach to outlast every request of before() (checked there), small enough for a test */
const HISTORY_BYTES = 96 * 1024 * 1024
const line = (o: unknown) => JSON.stringify(o) + '\n'

type Ev = { type: string; payload?: Record<string, unknown>; sessionId?: string }
type Msg = { type: string; event?: Ev; events?: Ev[]; sessions?: Array<{ id: string }> }
interface Stream { status: number; req: http.ClientRequest; text: () => string }

function history(cwd: string, bytes: number): string {
  const pad = 'x'.repeat(2000)
  const t = new Date(Date.now() - 60_000).toISOString()
  const out: string[] = [line({ type: 'user', uuid: 'u0', cwd, timestamp: t, message: { role: 'user', content: 'Old turn' } })]
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const pair = line({ type: 'assistant', uuid: `a${i}`, timestamp: t, message: { role: 'assistant', content: [{ type: 'text', text: pad }, { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `/src/${i}.ts` } }] } })
      + line({ type: 'user', uuid: `r${i}`, timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: pad }] } })
    out.push(pair)
    size += pair.length
  }
  // The current turn is short: what the replay holds is small, the prescan of the rest is what takes time
  out.push(line({ type: 'user', uuid: 'u-last', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Audit the code' } }))
  return out.join('')
}

const messagesOf = (text: string): Msg[] => text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Msg)
const eventsOf = (text: string): Ev[] => messagesOf(text)
  .flatMap(m => m.type === 'agent-event-batch' ? (m.events ?? []) : m.type === 'agent-event' && m.event ? [m.event] : [])

describe('relay: a session attached over several ticks (#651)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let receiver: http.Server
  let port = 0
  let hookPort = 0
  let cookie = ''
  let loopbackCookie = ''
  let pairToken = ''
  const received: Array<Record<string, unknown>> = []
  const open: http.ClientRequest[] = []
  let attachingAtStart = false
  let attachingAtEnd = false
  let early: Stream
  let remote: number[] = []
  let local: number[] = []
  let gonePending = false

  const waitFor = async (cond: () => boolean, ms = 60_000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 20))
  }
  /** GET /events kept open; resolves at the headers */
  const sse = (headers: http.OutgoingHttpHeaders = {}): Promise<Stream> => new Promise((resolve, reject) => {
    const viaTunnel = headers.Host === TUNNEL
    let text = ''
    const req = http.get({
      host: '127.0.0.1', port, path: '/events', agent: false,
      headers: { 'User-Agent': `attach-${Math.random()}`, Cookie: viaTunnel ? cookie : loopbackCookie, ...headers },
    }, res => {
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      open.push(req)
      resolve({ status: res.statusCode ?? 0, req, text: () => text })
    })
    req.on('error', reject)
  })
  const post = (p: number, urlPath: string, body: unknown, headers: http.OutgoingHttpHeaders = {}): Promise<http.IncomingMessage> => new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const r = http.request({
      host: '127.0.0.1', port: p, path: urlPath, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => { res.resume(); resolve(res) })
    r.on('error', reject)
    r.end(data)
  })

  before(async () => {
    receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(204); res.end() })
    })
    await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r))
    const recvPort = (receiver.address() as { port: number }).port

    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const bigFile = path.join(projectDir, `${BIG}.jsonl`)
    const goneFile = path.join(projectDir, `${GONE}.jsonl`)
    fs.writeFileSync(goneFile, line({ type: 'user', uuid: 'g0', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Short one' } }))
    fs.writeFileSync(bigFile, history(cwd, HISTORY_BYTES))
    // Newest first: the big session is attached first, the other one waits in the queue behind it
    const older = new Date(Date.now() - 30_000)
    fs.utimesSync(goneFile, older, older)

    const { createRelay } = await import('./relay')
    const { createAppRequestHandler } = await import('../app/src/server')
    relay = await createRelay({
      workspace: cwd, runtime: 'claude', allowedHosts: [TUNNEL], hooksProbe: () => true, issueLinksProbe: async () => [],
      webhooks: { destinations: [`http://127.0.0.1:${recvPort}/hook`] },
      remotePairing: { tokenFile: path.join(fakeHome, 'pair-token'), onToken: t => { pairToken = t }, rate: { burst: 50, perSecond: 50 } },
    })
    attachingAtStart = relay.debugState().attaching
    // The queued session's transcript is gone before its turn comes
    fs.rmSync(goneFile)

    const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
    const file = fs.readdirSync(discoveryDir).find(f => f.endsWith('.json'))!
    hookPort = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8')).port
    server = http.createServer(createAppRequestHandler(relay))
    port = await listenLoopback(server, 0)

    // A permission prompt pushed by Claude Code for the session being attached
    assert.equal((await post(hookPort, '/', { session_id: BIG, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' })).statusCode, 200)

    const pairOn = async (host: string, origin: string) => {
      const res = await post(port, '/pair', { token: pairToken }, { Host: host, Origin: origin })
      assert.equal(res.statusCode, 204)
      return String(res.headers['set-cookie']?.[0] ?? '').split(';')[0]
    }
    cookie = await pairOn(TUNNEL, `https://${TUNNEL}`)
    loopbackCookie = await pairOn(`127.0.0.1:${port}`, `http://127.0.0.1:${port}`)

    early = await sse()
    // Gone before it joins
    const gone = await sse()
    gone.req.destroy()
    gonePending = relay.debugState().attaching
    // Through the tunnel: one more than the remote cap, all at once, while none of them has joined yet
    remote = (await Promise.all(Array.from({ length: RELAY_MAX_REMOTE_SSE_CLIENTS + 1 }, () => sse({ Host: TUNNEL })))).map(s => s.status)
    // Locally: up to the global cap and one more (the early client and the accepted remote ones hold slots)
    const accepted = 1 + remote.filter(s => s === 200).length
    local = (await Promise.all(Array.from({ length: RELAY_MAX_SSE_CLIENTS - accepted + 1 }, () => sse()))).map(s => s.status)
    attachingAtEnd = relay.debugState().attaching

    await waitFor(() => !relay.debugState().attaching)
    await waitFor(() => relay.debugState().sseClients >= RELAY_MAX_SSE_CLIENTS)
    await waitFor(() => received.some(r => r.type === 'permission_requested'), 5000)
    // What the relay wrote to the early client once it joined is read by this process later, on a loaded machine
    // after the checks above (#440): wait for the cursor, written after the list and the whole replay.
    await waitFor(() => messagesOf(early.text()).some(m => m.type === 'relay-cursor'), 15_000)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay?.dispose()
    server?.close()
    receiver?.closeAllConnections(); receiver?.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('precondition: every request above was made while the attach was running', () => {
    assert.equal(attachingAtStart, true, 'the attach is under way when createRelay returns')
    assert.equal(gonePending, true)
    assert.equal(attachingAtEnd, true, `the attach of ${HISTORY_BYTES >> 20} MB ended before the requests: make it bigger`)
    assert.equal(relay.debugState().attaching, false, 'the attach ended')
  })

  it('a live hook of the session being attached still triggers its webhook', () => {
    const hits = received.filter(r => r.type === 'permission_requested')
    assert.equal(hits.length, 1, JSON.stringify(received))
    assert.equal(hits[0].sessionId, BIG)
  })

  it('what was read from the history triggers no webhook', () => {
    assert.deepEqual(received.filter(r => r.type !== 'permission_requested'), [])
  })

  it('a client accepted during the attach gets the session once, through the list and the replay', () => {
    assert.equal(early.status, 200)
    const lists = messagesOf(early.text()).filter(m => m.type === 'session-list')
    assert.equal(lists.length, 1)
    assert.equal(lists[0].sessions?.filter(s => s.id === BIG).length, 1)
    const spawns = eventsOf(early.text()).filter(e => e.sessionId === BIG && e.type === 'agent_spawn')
    assert.equal(spawns.length, 1, 'the orchestrator is spawned once, not replayed then broadcast again')
    assert.ok(eventsOf(early.text()).some(e => e.sessionId === BIG && e.type === 'permission_requested'), 'the live hook reached it')
  })

  it(`waiting tunnel clients count toward the remote cap (${RELAY_MAX_REMOTE_SSE_CLIENTS})`, () => {
    assert.equal(remote.filter(s => s === 200).length, RELAY_MAX_REMOTE_SSE_CLIENTS, JSON.stringify(remote))
    assert.equal(remote.filter(s => s === 503).length, 1)
    assert.equal(relay.debugState().remoteSseClients, RELAY_MAX_REMOTE_SSE_CLIENTS)
  })

  it(`waiting clients count toward the SSE cap (${RELAY_MAX_SSE_CLIENTS}); the one gone before joining is never added`, () => {
    assert.equal(local.filter(s => s === 503).length, 1, JSON.stringify(local))
    assert.equal(relay.debugState().sseClients, RELAY_MAX_SSE_CLIENTS)
  })

  it('a queued session whose transcript cannot be read at its turn is no longer watched', async () => {
    await waitFor(() => relay.debugState().watchedSessions === 1, 5000)
    assert.equal(relay.debugState().watchedSessions, 1)
    assert.ok(!messagesOf(early.text()).some(m => m.sessions?.some(s => s.id === GONE)))
  })
})
