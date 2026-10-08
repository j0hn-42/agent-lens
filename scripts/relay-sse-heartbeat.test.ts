/**
 * Relay SSE heartbeat (#141): a keep-alive frame on every client at a fixed period, from ONE shared timer
 * that runs only while a client is connected. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-hb-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const HEARTBEAT_MS = 40

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
const open: http.ClientRequest[] = []

function connectSSE(): Promise<{ req: http.ClientRequest; text: () => string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      resolve({ req, text: () => buf })
    })
    open.push(req)
    req.on('error', reject)
  })
}

const heartbeats = (text: string) => text.split('\n\n').filter(b => b === 'data: {"type":"heartbeat"}').length

describe('relay: SSE heartbeat', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    relay = await createRelay({ workspace: ws, runtime: 'claude', sseHeartbeatMs: HEARTBEAT_MS })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
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

  it('runs no timer without a client', () => {
    assert.equal(relay.debugState().heartbeatTimerActive, false)
  })

  it('writes a heartbeat on every connected client, from a single shared timer', async () => {
    const a = await connectSSE()
    const b = await connectSSE()
    assert.equal(relay.debugState().heartbeatTimerActive, true)
    await sleep(HEARTBEAT_MS * 3.5)
    assert.ok(heartbeats(a.text()) >= 2, `client a: ${a.text()}`)
    assert.ok(heartbeats(b.text()) >= 2, `client b: ${b.text()}`)
    a.req.destroy(); b.req.destroy()
  })

  it('stops the timer when the last client leaves', async () => {
    await sleep(100)
    assert.equal(relay.debugState().sseClients, 0)
    assert.equal(relay.debugState().heartbeatTimerActive, false)
  })
})
