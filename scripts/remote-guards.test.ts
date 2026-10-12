/**
 * Remote access guards (#241, step 1), through the standalone app's real request handler and a real relay
 * created with an allow list. The server still listens on 127.0.0.1: a tunnel's peer is loopback, so the
 * requests below only differ by their Host / Origin headers, exactly like a forwarded request.
 * Separate file: the relay is a singleton per process.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listenLoopback } from './server-hardening'
import { CSP_API, RELAY_MAX_REMOTE_SSE_CLIENTS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-remote-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const TUNNEL = 'box.tail1234.ts.net'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
const open: http.ClientRequest[] = []

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request; with `keep` the reply resolves at the headers and the connection stays open (SSE). */
function request(method: string, urlPath: string, headers: http.OutgoingHttpHeaders = {}, body?: string, keep = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { 'User-Agent': `remote-${Math.random()}`, ...headers } }, res => {
      if (keep) { res.resume(); open.push(req); return resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }) }
      let out = ''
      res.setEncoding('utf8')
      res.on('data', c => { out += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('remote access guards (#241): allowed Host through a tunnel', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const { createAppRequestHandler } = await import('../app/src/server')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    // Fail closed: an invalid allow list stops createRelay (and does not use up the per-process relay)
    await assert.rejects(createRelay({ workspace: ws, runtime: 'claude', allowedHosts: ['*.ts.net'] }), /allowedHosts/)
    relay = await createRelay({ workspace: ws, runtime: 'claude', allowedHosts: [TUNNEL], hooksProbe: () => true, issueLinksProbe: async () => [] })
    server = http.createServer(createAppRequestHandler(relay, { allowedHosts: [TUNNEL] }))
    port = await listenLoopback(server, 0)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('serves the read-only surface to the allowed Host: /events, /status, the static app', async () => {
    const sse = await request('GET', '/events', { Host: TUNNEL }, undefined, true)
    assert.equal(sse.status, 200)
    assert.match(String(sse.headers['content-type']), /text\/event-stream/)
    open.pop()?.destroy()
    const status = await request('GET', '/status', { Host: TUNNEL })
    assert.equal(status.status, 200, status.body)
    assert.equal(typeof JSON.parse(status.body).sessionCount, 'number')
    for (const p of ['/', '/theme.js']) assert.equal((await request('GET', p, { Host: TUNNEL })).status, 200, p)
  })

  it('accepts the tunnel\'s own https origin, refuses http://<host>, other sites and the dev origin', async () => {
    assert.equal((await request('GET', '/status', { Host: TUNNEL, Origin: `https://${TUNNEL}` })).status, 200)
    for (const headers of [
      { Origin: `http://${TUNNEL}` }, { Origin: 'https://evil.example' }, { Origin: 'http://localhost:3000' }, { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      for (const p of ['/status', '/events', '/']) {
        const r = await request('GET', p, { Host: TUNNEL, ...headers }, undefined, p === '/events')
        assert.equal(r.status, 403, `${p} ${JSON.stringify(headers)}`)
      }
    }
  })

  it('refuses the sensitive routes (403) to the allowed Host, before any work', async () => {
    const before = relay.debugState()
    for (const p of ['/context?session=77777777-7777-4777-8777-777777777777', '/issue-links?role=qa-engineer', '/observations', '/observations/schema', '/statusline']) {
      const r = await request('GET', p, { Host: TUNNEL })
      assert.equal(r.status, 403, p)
      assert.equal(r.headers['content-security-policy'], CSP_API, `${p}: strict headers on the 403`)
    }
    const scope = await request('POST', '/scope', { Host: TUNNEL, 'Content-Type': 'application/json' }, '{"scope":"all"}')
    assert.equal(scope.status, 403)
    assert.equal(JSON.parse((await request('GET', '/status')).body).allWorkspaces, false, 'POST /scope through the tunnel changed nothing')
    assert.equal(relay.debugState().statusRuns, before.statusRuns + 1, 'only the loopback /status above was computed')
  })

  it('keeps the loopback surface unchanged (sensitive routes still answer on loopback)', async () => {
    assert.equal((await request('GET', '/observations')).status, 200)
    assert.notEqual((await request('GET', '/context?session=77777777-7777-4777-8777-777777777777')).status, 403)
    assert.equal((await request('GET', '/statusline')).status, 200)
  })

  it('refuses a foreign Host on every path, static files included (DNS rebinding)', async () => {
    for (const host of ['evil.example', `${TUNNEL}.evil.example`, `evil-${TUNNEL}`, `${TUNNEL}.`, `${TUNNEL}:443`]) {
      for (const p of ['/', '/index.js', '/theme.js', '/events', '/status', '/observations']) {
        const r = await request('GET', p, { Host: host }, undefined, p === '/events')
        assert.equal(r.status, 403, `${host} ${p}`)
        assert.ok(r.headers['content-security-policy'], `${host} ${p}: strict headers on the 403`)
      }
    }
    assert.equal(relay.debugState().sseClients, 0, 'no refused request holds a stream')
  })

  it(`caps the remote SSE clients at ${RELAY_MAX_REMOTE_SSE_CLIENTS}; loopback clients are not counted against it`, async () => {
    const remote: Reply[] = []
    const firstRemote = open.length
    for (let i = 0; i < RELAY_MAX_REMOTE_SSE_CLIENTS; i++) remote.push(await request('GET', '/events', { Host: TUNNEL }, undefined, true))
    assert.deepEqual(remote.map(r => r.status), Array(RELAY_MAX_REMOTE_SSE_CLIENTS).fill(200))
    const extra = await request('GET', '/events', { Host: TUNNEL }, undefined, true)
    assert.equal(extra.status, 503)
    assert.ok(Number(extra.headers['retry-after']) >= 1)
    const local = await request('GET', '/events', {}, undefined, true)
    assert.equal(local.status, 200, 'a local tab still connects')
    assert.equal(relay.debugState().remoteSseClients, RELAY_MAX_REMOTE_SSE_CLIENTS)
    // Closing a remote stream frees its slot
    open[firstRemote].destroy()
    await new Promise(r => setTimeout(r, 100))
    assert.equal((await request('GET', '/events', { Host: TUNNEL }, undefined, true)).status, 200)
  })
})
