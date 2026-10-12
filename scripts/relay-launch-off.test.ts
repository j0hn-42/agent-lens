/**
 * #229 PR 2: without options.launch (the default, no --allow-launch) the relay has no launch surface: POST /launch and
 * /launch/<id>/stop answer 404, even with an Authorization header, /status has no `launch` field, and nothing is spawned.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStatusPath, isLaunchPath } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-launch-off-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0

function request(method: string, urlPath: string, headers: http.OutgoingHttpHeaders = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false, headers: { 'User-Agent': `off-${Math.random()}`, ...headers } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('relay launch is OFF by default (#229)', () => {
  before(async () => {
    const ws = path.join(fakeHome, 'ws')
    fs.mkdirSync(ws, { recursive: true })
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (isStatusPath(req.url)) return relay.handleStatus(req, res)
      if (isLaunchPath(req.url)) return relay.handleLaunch(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { relay.dispose(); server.close(); fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('reports itself as disabled and answers 404 to every launch route', async () => {
    assert.equal(relay.launchEnabled, false)
    const json = { 'Content-Type': 'application/json', Authorization: `Bearer ${'d'.repeat(64)}` }
    assert.equal((await request('POST', '/launch', json, '{"repo":"a/b","issue":1,"role":"qa-engineer"}')).status, 404)
    assert.equal((await request('POST', '/launch/0123456789abcdef/stop', json)).status, 404)
    assert.equal((await request('GET', '/launch')).status, 404)
  })

  it('has no launch field in /status', async () => {
    const r = await request('GET', '/status')
    assert.equal(r.status, 200)
    assert.equal('launch' in JSON.parse(r.body), false)
  })
})
