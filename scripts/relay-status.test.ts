/**
 * Relay GET /status (#30): loopback only, rate-limited, small JSON snapshot.
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RELAY_STATUS_RATE_BURST } from '../extension/src/constants'
import { isStatusPath } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-status-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let workspace = ''

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

describe('isStatusPath', () => {
  it('matches the path regardless of query', () => {
    assert.equal(isStatusPath('/status'), true)
    assert.equal(isStatusPath('/status?x=1'), true)
    for (const u of ['/statuses', '/events', '/', '', undefined]) assert.equal(isStatusPath(u), false, String(u))
  })
})

describe('relay GET /status', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    workspace = path.join(fakeHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    relay = await createRelay({ workspace, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (isStatusPath(req.url)) return relay.handleStatus(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('returns a small JSON snapshot with the documented fields', async () => {
    const r = await get('/status')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.ok(r.body.length < 1024)
    const s = JSON.parse(r.body)
    assert.deepEqual(Object.keys(s).sort(), ['allWorkspaces', 'hooksConfigured', 'relayVersion', 'runtimes', 'sessionCount', 'workspace'])
    assert.deepEqual(s.runtimes, ['claude'])
    assert.equal(s.hooksConfigured, false)
    assert.equal(s.allWorkspaces, false)
    assert.equal(typeof s.sessionCount, 'number')
    assert.equal(typeof s.relayVersion, 'string')
    assert.ok(String(s.workspace).length > 0)
  })

  it('reports hooksConfigured once settings.json has Agent Lens hooks', async () => {
    const dir = path.join(fakeHome, '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /x/.claude/agent-lens/hook.js' }] }] },
    }))
    // Wait for the rate limiter bucket to hold a token (earlier test used one)
    const s = JSON.parse((await get('/status')).body)
    assert.equal(s.hooksConfigured, true)
  })

  it('answers 403 to a foreign Host header (DNS rebinding)', async () => {
    assert.equal((await get('/status', { headers: { Host: 'evil.example' } })).status, 403)
  })

  it('rejects methods other than GET/HEAD with 405', async () => {
    assert.equal((await get('/status', { method: 'POST' })).status, 405)
  })

  it('rate-limits a flood with 429', async () => {
    const statuses: number[] = []
    for (let i = 0; i < RELAY_STATUS_RATE_BURST * 3; i++) statuses.push((await get('/status')).status)
    assert.ok(statuses.includes(429), 'expected a 429')
  })
})
