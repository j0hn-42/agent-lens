/**
 * Relay GET /observations (#72): the typed action over a real relay with a real transcript.
 * Whitelisted projection (no prompt, no path), loopback only, rate-limited, clean idempotent shutdown.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RELAY_STATUS_RATE_BURST } from '../extension/src/constants'
import { observationsRoute } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-obs-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '33333333-3333-4333-8333-333333333333'

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0

function get(urlPath: string, opts: { method?: string; headers?: http.OutgoingHttpHeaders } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: opts.method ?? 'GET', agent: false, headers: opts.headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Open /events briefly: connecting triggers a session scan. */
function touchEvents(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.resume()
      setTimeout(() => { req.destroy(); resolve() }, 600)
    })
    req.on('error', reject)
  })
}

describe('observationsRoute', () => {
  it('matches the two routes regardless of query', () => {
    assert.equal(observationsRoute('/observations'), 'observations')
    assert.equal(observationsRoute('/observations?session=a'), 'observations')
    assert.equal(observationsRoute('/observations/schema'), 'schema')
    for (const u of ['/observation', '/observations/x', '/status', '', undefined]) assert.equal(observationsRoute(u), null, String(u))
  })
})

describe('relay GET /observations', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'work', 'private-project')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const now = Date.now()
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      JSON.stringify({ type: 'user', cwd: realWs, timestamp: new Date(now - 2000).toISOString(), message: { role: 'user', content: 'TOPSECRET prompt about the launch' } }) + '\n' +
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'TOPSECRET answer' }] } }) + '\n')
    relay = await createRelay({ workspace: realWs, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      if (observationsRoute(req.url)) return relay.handleObservations(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
    await touchEvents()
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('reports the watched session without any prompt, label or path', async () => {
    const r = await get('/observations')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    const o = JSON.parse(r.body)
    assert.equal(o.schema, 1)
    const s = o.sessions.find((x: { id: string }) => x.id === SESSION)
    assert.ok(s, 'session listed')
    assert.equal(s.runtime, 'claude')
    assert.equal(s.status, 'active')
    assert.ok(['fresh', 'stale'].includes(s.freshness))
    for (const leak of ['TOPSECRET', 'private-project', fakeHome, 'cwd', 'label']) assert.ok(!r.body.includes(leak), `leaked ${leak}`)
  })

  it('filters by session and can leave agents out', async () => {
    const o = JSON.parse((await get(`/observations?session=${SESSION}&agents=0`)).body)
    assert.equal(o.sessions.length, 1)
    assert.equal(o.sessions[0].agents, undefined)
    const none = JSON.parse((await get('/observations?session=nope')).body)
    assert.deepEqual(none.sessions, [])
  })

  it('serves the JSON schema of the action', async () => {
    const d = JSON.parse((await get('/observations/schema')).body)
    assert.equal(d.name, 'observations')
    assert.equal(d.inputSchema.type, 'object')
    assert.ok(d.outputSchema.properties.sessions)
  })

  it('rejects bad parameters with 400', async () => {
    assert.equal((await get('/observations?session=../x')).status, 400)
    assert.equal((await get('/observations?bogus=1')).status, 400)
  })

  it('answers 403 to a foreign Host and 405 to POST', async () => {
    assert.equal((await get('/observations', { headers: { Host: 'evil.example' } })).status, 403)
    assert.equal((await get('/observations', { method: 'POST' })).status, 405)
  })

  it('rate-limits a flood with 429, then shuts down cleanly (503) and idempotently', async () => {
    const statuses: number[] = []
    for (let i = 0; i < RELAY_STATUS_RATE_BURST * 3; i++) statuses.push((await get('/observations')).status)
    assert.ok(statuses.includes(429), 'expected a 429')
    relay.dispose()
    relay.dispose()
    await new Promise(r => setTimeout(r, 1200)) // let the limiter refill
    assert.equal((await get('/observations')).status, 503)
  })
})
