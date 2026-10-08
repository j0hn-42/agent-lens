/**
 * Relay GET /issue-links?role=<role> (#63): loopback only, rate-limited, bounded, silent when gh is absent.
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isIssueLinksPath } from '../extension/src/relay-guards'
import type { IssueLink } from '../extension/src/issue-links'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-issue-links-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
const probeCalls: string[] = []
const probeCwds: Array<string | undefined> = []
let probeMode: 'ok' | 'fail' = 'ok'

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

const link: IssueLink = { kind: 'issue', number: 7, title: 't', url: 'https://github.com/o/r/issues/7', state: 'open' }

describe('isIssueLinksPath', () => {
  it('matches the path regardless of query', () => {
    assert.equal(isIssueLinksPath('/issue-links'), true)
    assert.equal(isIssueLinksPath('/issue-links?role=x'), true)
    for (const u of ['/issue-linksx', '/status', '/', '', undefined]) assert.equal(isIssueLinksPath(u), false, String(u))
  })
})

describe('relay GET /issue-links', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const workspace = path.join(fakeHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    relay = await createRelay({
      workspace, runtime: 'claude',
      issueLinksProbe: async (role, cwd) => {
        probeCalls.push(role)
        probeCwds.push(cwd)
        if (probeMode === 'fail') throw new Error('gh is not installed')
        return [link]
      },
    })
    server = http.createServer((req, res) => {
      if (isIssueLinksPath(req.url)) return relay.handleIssueLinks(req, res)
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

  it('answers the links of a role as JSON with strict headers', async () => {
    const r = await get('/issue-links?role=frontend-engineer')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.deepEqual(JSON.parse(r.body), { role: 'frontend-engineer', links: [link] })
  })

  it('caches a role for a while: a repeated request does not run gh again', async () => {
    probeCalls.length = 0
    await get('/issue-links?role=backend-engineer')
    await get('/issue-links?role=backend-engineer')
    assert.deepEqual(probeCalls, ['backend-engineer'])
  })

  it('a session the relay does not know falls back to the workspace in a scoped relay', async () => {
    probeCwds.length = 0
    await get('/issue-links?role=designer&session=unknown-session')
    assert.deepEqual(probeCwds, [undefined])
  })

  it('rejects a malformed session parameter with 400', async () => {
    for (const q of ['&session=a%20b', '&session=a&session=b', `&session=${'x'.repeat(130)}`, '&session=..%2F..']) {
      assert.equal((await get(`/issue-links?role=qa${q}`)).status, 400, q)
    }
  })

  it('rejects a missing, malformed or repeated role with 400 and never runs gh', async () => {
    probeCalls.length = 0
    for (const q of ['', '?role=', '?role=--repo', '?role=a%20b', '?role=a&role=b', `?role=${'x'.repeat(41)}`]) {
      assert.equal((await get(`/issue-links${q}`)).status, 400, q)
    }
    assert.deepEqual(probeCalls, [])
  })

  it('degrades silently when gh fails: 200 with no links', async () => {
    probeMode = 'fail'
    const r = await get('/issue-links?role=product-designer')
    probeMode = 'ok'
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { role: 'product-designer', links: [] })
  })

  it('answers 403 to a foreign Host header (DNS rebinding)', async () => {
    assert.equal((await get('/issue-links?role=x', { headers: { Host: 'evil.example' } })).status, 403)
  })

  it('rejects methods other than GET/HEAD with 405', async () => {
    assert.equal((await get('/issue-links?role=x', { method: 'POST' })).status, 405)
  })

  it('rate-limits a flood with 429', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 60; i++) statuses.push((await get(`/issue-links?role=r${i % 5}`)).status)
    assert.ok(statuses.includes(429), 'expected a 429')
  })
})
