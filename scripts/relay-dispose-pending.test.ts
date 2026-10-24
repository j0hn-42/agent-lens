/**
 * dispose() with SSE clients still waiting for the attaches in progress (#651, #613): they are closed and never join.
 * Joining after dispose would start the heartbeat and scan tickers again, with timers nobody stops (tests, hot reload).
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-dp-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSIONS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0

describe('relay: dispose() closes the clients waiting to join (#613)', () => {
  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    // Many transcripts found at start: their attach runs over several ticks of the event loop
    for (let i = 0; i < SESSIONS; i++) {
      const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`
      let body = ''
      for (let j = 0; j < 50; j++) body += JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), uuid: `u-${i}-${j}`, message: { role: 'user', content: `m${j}` } }) + '\n'
      fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), body)
    }
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
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

  it('a client waiting for the attaches never joins once the relay is disposed: no ticker is started again', async () => {
    let closed = false
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.on('close', () => { closed = true }); res.resume() })
    req.on('error', () => { closed = true })
    const end = Date.now() + 3000
    while (relay.debugState().pendingSseClients === 0 && Date.now() < end) await sleep(1)
    assert.equal(relay.debugState().pendingSseClients, 1, 'precondition: the client waits for the attaches')
    assert.equal(relay.debugState().sseClients, 0)

    relay.dispose()
    await sleep(500)

    const state = relay.debugState()
    assert.equal(state.sseClients, 0, 'it did not join')
    assert.equal(state.pendingSseClients, 0, 'its place is freed')
    assert.equal(state.heartbeatTimerActive, false, 'no heartbeat timer left running')
    assert.equal(state.scanTimerActive, false, 'no scan timer left running')
    assert.equal(state.runtimeScanTimerActive, false)
    assert.equal(closed, true, 'its connection was closed')
    req.destroy()
  })
})
