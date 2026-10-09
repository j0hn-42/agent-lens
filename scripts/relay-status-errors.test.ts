/**
 * Relay handlers used WITHOUT the request guard in front (a caller may mount them directly):
 * handleSSE and handleStatus set the security headers themselves, on success and on every error they
 * produce, and a failing /status refresh answers 500 and does not poison the next one (issue #68).
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStatusPath } from '../extension/src/relay-guards'
import { listenLoopback } from './server-hardening'
import { CSP_API } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-err-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let probeMode: 'ok' | 'throw' = 'ok'
let probeCalls = 0
const open: http.ClientRequest[] = []

function get(urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
  })
}

function sseHeaders(urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers }, res => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
      req.destroy()
    })
    open.push(req)
    req.on('error', () => {})
    req.on('close', () => resolve({ status: 0, headers: {} }))
    void reject
  })
}

function assertStrict(h: http.IncomingHttpHeaders, label: string) {
  assert.equal(h['content-security-policy'], CSP_API, `${label}: CSP`)
  assert.equal(h['cache-control'], 'no-store', `${label}: Cache-Control`)
  assert.equal(h['x-content-type-options'], 'nosniff', `${label}: nosniff`)
  assert.equal(h['referrer-policy'], 'no-referrer', `${label}: Referrer-Policy`)
}

describe('relay handlers mounted without the request guard', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    relay = await createRelay({
      workspace: ws, runtime: 'claude',
      hooksProbe: async () => { probeCalls++; if (probeMode === 'throw') throw new Error('settings unreadable'); return true },
    })
    // Deliberately NO guardRequest: the handlers must stand on their own
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (isStatusPath(req.url)) return void relay.handleStatus(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('handleStatus: strict headers on 200', async () => {
    const r = await get('/status')
    assert.equal(r.status, 200)
    assertStrict(r.headers, '200')
  })

  it('handleStatus: strict headers on the 403 of a foreign Host header', async () => {
    const r = await get('/status', { Host: 'evil.example' })
    assert.equal(r.status, 403)
    assertStrict(r.headers, '403')
  })

  it('handleStatus: a failing refresh answers 500 with strict headers, then recovers', async () => {
    probeMode = 'throw'
    const failed = await get('/status', { 'User-Agent': 'err-1' })
    assert.equal(failed.status, 500)
    assertStrict(failed.headers, '500')
    const callsAfterFailure = probeCalls
    probeMode = 'ok'
    const recovered = await get('/status', { 'User-Agent': 'err-2' })
    assert.equal(recovered.status, 200, 'the failed refresh is not shared with later requests')
    assert.equal(probeCalls, callsAfterFailure + 1)
    assert.equal(JSON.parse(recovered.body).hooksConfigured, true)
  })

  it('handleSSE: strict headers on the stream', async () => {
    const r = await sseHeaders('/events')
    assert.equal(r.status, 200)
    assertStrict(r.headers, 'stream')
    assert.match(String(r.headers['content-type']), /text\/event-stream/)
  })

  it('handleSSE: strict headers on the 403 of a foreign Host header', async () => {
    const r = await sseHeaders('/events', { Host: 'evil.example' })
    assert.equal(r.status, 403)
    assertStrict(r.headers, '403')
  })

  it('handleSSE: strict headers on the 400 of a bad session parameter', async () => {
    const r = await sseHeaders('/events?session=../x')
    assert.equal(r.status, 400)
    assertStrict(r.headers, '400')
  })
})
