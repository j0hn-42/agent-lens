/**
 * Relay GET /context?session=<id> (#64): CLAUDE.md + memory of a watched session's cwd, on demand.
 * The client only names a session; the path always comes from the transcript header (never from the request).
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isContextPath } from '../extension/src/relay-guards'
import { guardRequest, listenLoopback } from './server-hardening'
import { RELAY_CONTEXT_RATE_BURST, PROJECT_CONTEXT_MAX_FILE_BYTES } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-relay-ctx-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '44444444-4444-4444-8444-444444444444'
const UNKNOWN = '55555555-5555-4555-8555-555555555555'
const line = (o: unknown) => JSON.stringify(o) + '\n'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let realWs = ''

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

describe('isContextPath', () => {
  it('matches the path regardless of query', () => {
    assert.equal(isContextPath('/context'), true)
    assert.equal(isContextPath('/context?session=x'), true)
    for (const u of ['/contexts', '/events', '/', '', undefined]) assert.equal(isContextPath(u), false, String(u))
  })
})

describe('relay GET /context', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }))
    fs.writeFileSync(path.join(realWs, 'CLAUDE.md'), 'Règles du projet, voir #64')

    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (isContextPath(req.url)) return void relay.handleContext(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('returns the files and issue refs of a watched session', async () => {
    const r = await get(`/context?session=${SESSION}`)
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    const body = JSON.parse(r.body)
    assert.equal(body.sessionId, SESSION)
    assert.equal(typeof body.loadedAt, 'number')
    assert.equal(body.files[0].kind, 'claude-md')
    assert.equal(body.files[0].found, true)
    assert.equal(body.files[0].text, 'Règles du projet, voir #64')
    assert.equal(body.files[1].found, false)
    assert.deepEqual(body.issues, [64])
    assert.ok(!r.body.includes(realWs), 'no absolute path leaks')
  })

  it('reports a symlinked CLAUDE.md as unreadable through the relay', async () => {
    const target = path.join(realWs, 'AGENTS.md')
    const link = path.join(realWs, 'CLAUDE.md')
    fs.writeFileSync(target, 'x')
    fs.rmSync(link)
    fs.symlinkSync('AGENTS.md', link)
    try {
      const body = JSON.parse((await get(`/context?session=${SESSION}`)).body)
      assert.equal(body.files[0].found, false)
      assert.equal(body.files[0].unreadable, 'symlink')
    } finally {
      fs.rmSync(link); fs.writeFileSync(link, 'Règles du projet, voir #64')
    }
  })

  it('reads again on every request (no relay-side cache)', async () => {
    fs.writeFileSync(path.join(realWs, 'CLAUDE.md'), 'changé')
    const body = JSON.parse((await get(`/context?session=${SESSION}`)).body)
    assert.equal(body.files[0].text, 'changé')
  })

  it('bounds the size of what it sends', async () => {
    fs.writeFileSync(path.join(realWs, 'CLAUDE.md'), 'x'.repeat(PROJECT_CONTEXT_MAX_FILE_BYTES * 3))
    const body = JSON.parse((await get(`/context?session=${SESSION}`)).body)
    assert.equal(body.files[0].truncated, true)
    assert.equal(body.files[0].text.length, PROJECT_CONTEXT_MAX_FILE_BYTES)
  })

  it('answers 404 for an unknown session and 400 without session', async () => {
    assert.equal((await get(`/context?session=${UNKNOWN}`)).status, 404)
    assert.equal((await get('/context')).status, 400)
  })

  it('answers 400 for a malformed session (path traversal)', async () => {
    assert.equal((await get('/context?session=..%2F..%2Fetc')).status, 400)
  })

  it('answers 403 to a foreign Host header', async () => {
    assert.equal((await get(`/context?session=${SESSION}`, { headers: { Host: 'evil.example' } })).status, 403)
  })

  it('rejects methods other than GET/HEAD with 405', async () => {
    assert.equal((await get(`/context?session=${SESSION}`, { method: 'POST' })).status, 405)
  })

  it('rate-limits a flood with 429', async () => {
    const statuses: number[] = []
    for (let i = 0; i < RELAY_CONTEXT_RATE_BURST * 3; i++) statuses.push((await get(`/context?session=${SESSION}`)).status)
    assert.ok(statuses.includes(429), 'expected a 429')
  })
})
