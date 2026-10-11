/**
 * GET /events: refus cross-site et limiteur de débit des connexions (issue #200).
 * Un site web ne doit ni saturer les 32 flux SSE, ni déclencher un scan disque / un replay.
 * Fichier à part : le relais est un singleton par processus.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'
import { RELAY_SSE_RATE_BURST } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-sseg-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
const open: http.ClientRequest[] = []

/** Ouvre /events ; résout à la réception des en-têtes (la connexion reste ouverte si 200). */
function connect(headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; retryAfter?: string; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, res => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined, req })
    })
    open.push(req)
    req.on('error', reject)
  })
}

describe('relay: GET /events guards (#200)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (req.url?.startsWith('/status')) return void relay.handleStatus(req, res)
      if (req.url?.startsWith('/context')) return void relay.handleContext(req, res)
      if (req.url?.startsWith('/observations')) return void relay.handleObservations(req, res)
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

  it('refuses a cross-site request with 403, before any scan, replay or client registration', async () => {
    const before = relay.debugState()
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]) {
      const r = await connect(headers)
      assert.equal(r.status, 403, JSON.stringify(headers))
    }
    const after = relay.debugState()
    assert.equal(after.sseClients, before.sseClients)
    assert.equal(after.scanRuns, before.scanRuns)
  })

  it('accepts a same-site dev UI origin and a request without Origin', async () => {
    const a = await connect({ Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'same-site' })
    assert.equal(a.status, 200)
    const b = await connect()
    assert.equal(b.status, 200)
    a.req.destroy(); b.req.destroy()
  })

  it('rate-limits connection attempts per client with 429 and Retry-After', async () => {
    const statuses: number[] = []
    let retryAfter: string | undefined
    for (let i = 0; i < RELAY_SSE_RATE_BURST + 5; i++) {
      const r = await connect()
      statuses.push(r.status)
      if (r.status === 429) retryAfter = r.retryAfter
      r.req.destroy()
    }
    assert.ok(statuses.includes(429), `a 429 appears after the burst: ${statuses.join(',')}`)
    assert.ok(retryAfter && Number(retryAfter) >= 1, `Retry-After present: ${retryAfter}`)
  })

  it('refuses a cross-site request on the read routes /status, /context and /observations', async () => {
    for (const url of ['/status', '/context?session=x', '/observations']) {
      const status = await new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: url, agent: false, headers: { 'Sec-Fetch-Site': 'cross-site' } }, res => {
          res.resume(); resolve(res.statusCode ?? 0)
        }).on('error', reject)
      })
      assert.equal(status, 403, url)
    }
  })
})
