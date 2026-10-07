/**
 * Relay SSE limits: client cap (503), session-param validation (400), loopback Host
 * check (403), replay of buffered hook events, cleanup on client close.
 * Real HTTP over 127.0.0.1 on ephemeral ports. The relay is a per-process singleton,
 * so the --all-workspaces behaviour lives in relay-all-workspaces.test.ts.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RELAY_MAX_SSE_CLIENTS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let hookPort = 0
const openRequests: http.ClientRequest[] = []

function connect(urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers }, res => resolve({ status: res.statusCode ?? 0, res, req }))
    openRequests.push(req)
    req.on('error', reject)
  })
}

function readMessages(res: http.IncomingMessage, until: (msgs: Array<Record<string, unknown>>) => boolean, ms = 3000): Promise<Array<Record<string, unknown>>> {
  return new Promise(resolve => {
    const msgs: Array<Record<string, unknown>> = []
    let buf = ''
    const done = () => { clearTimeout(timer); resolve(msgs) }
    const timer = setTimeout(done, ms)
    res.setEncoding('utf8')
    res.on('data', (c: string) => {
      buf += c
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (frame.startsWith('data: ')) msgs.push(JSON.parse(frame.slice(6)))
      }
      if (until(msgs)) done()
    })
    res.on('close', done)
  })
}

function postHook(payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port: hookPort, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(body)
  })
}

describe('relay SSE limits', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    // A recent session from ANOTHER workspace must not be picked up without --all-workspaces
    const other = path.join(fakeHome, '.claude', 'projects', '-elsewhere')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'foreign-session.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
    const file = fs.readdirSync(discoveryDir).find(f => f.endsWith('.json'))!
    hookPort = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8')).port
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    for (const r of openRequests) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('does not discover other workspaces by default', async () => {
    const c = await connect('/events')
    const msgs = await readMessages(c.res, () => false, 300)
    c.req.destroy()
    const ids = msgs.filter(m => m.type === 'session-list').flatMap(m => (m.sessions as Array<{ id: string }>).map(s => s.id))
    assert.ok(!ids.includes('foreign-session'))
  })

  it('answers 400 to a malformed ?session= and does not open a stream', async () => {
    for (const q of ['a%20b', '..%2F..%2Fetc', 'x'.repeat(200), '']) {
      const { status, req } = await connect(`/events?session=${q}`)
      assert.equal(status, 400, q)
      req.destroy()
    }
  })

  it('answers 403 to a foreign Host header (DNS rebinding)', async () => {
    const { status, req } = await connect('/events', { Host: 'evil.example' })
    assert.equal(status, 403)
    req.destroy()
  })

  it('replays buffered hook events, filtered by ?session=', async () => {
    assert.equal(await postHook({ session_id: 'sess-a', hook_event_name: 'SessionStart' }), 200)
    assert.equal(await postHook({ session_id: 'sess-b', hook_event_name: 'SessionStart' }), 200)

    const a = await connect('/events?session=sess-a')
    assert.equal(a.status, 200)
    const msgsA = await readMessages(a.res, m => m.some(x => x.type === 'agent-event-batch'))
    a.req.destroy()
    const batches = msgsA.filter(x => x.type === 'agent-event-batch') as Array<{ events: Array<{ sessionId: string }> }>
    assert.ok(batches.length >= 1)
    assert.ok(batches.every(b => b.events.every(e => e.sessionId === 'sess-a')))
  })

  it('caps simultaneous clients with 503 and frees slots when clients close', async () => {
    const clients = await Promise.all(Array.from({ length: RELAY_MAX_SSE_CLIENTS }, () => connect('/events')))
    assert.ok(clients.every(c => c.status === 200))

    const extra = await connect('/events')
    assert.equal(extra.status, 503)
    assert.equal(extra.res.headers['retry-after'], '5')
    extra.req.destroy()

    // Closing a client releases its slot (listeners cleaned on close)
    clients[0].req.destroy()
    let status = 0
    for (let i = 0; i < 50 && status !== 200; i++) {
      await new Promise(r => setTimeout(r, 20))
      const c = await connect('/events')
      status = c.status
      if (status === 200) clients.push(c); else c.req.destroy()
    }
    assert.equal(status, 200)
    for (const c of clients) c.req.destroy()
  })
})
