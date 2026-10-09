/**
 * Relay robustness for #206: an exception in a transcript watcher or poll callback used to reach the
 * relay's uncaughtException handler, which exits the process (every SSE client and the hook server die).
 *  - a transcript that stats fine but cannot be opened (EPERM of a pending delete on Windows, or a purge)
 *    is skipped: the relay keeps serving /status
 *  - any other exception in the poll is logged and the session is detached with session-ended
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import fsModule from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStatusPath } from '../extension/src/relay-guards'
import { guardRequest, listenLoopback } from './server-hardening'
import { POLL_FALLBACK_MS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-read-errors-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '44444444-4444-4444-8444-444444444444'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let transcript = ''
const open: http.ClientRequest[] = []

function getStatus(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', agent: false }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
  })
}

function connectSSE(): Promise<{ text: () => string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      resolve({ text: () => buf })
    })
    open.push(req)
    req.on('error', reject)
  })
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}

const userLine = (text: string) => line({ type: 'user', cwd: fakeHome, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })

describe('relay: exceptions in transcript callbacks (#206)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(transcript, userLine('Run the build'))

    relay = await createRelay({ workspace: ws, runtime: 'claude', hooksProbe: async () => true })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (isStatusPath(req.url)) return void relay.handleStatus(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
  })

  after(() => {
    mock.restoreAll()
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('a transcript that stats but cannot be opened between two polls does not stop the relay', async () => {
    const sse = await connectSSE()
    assert.ok(await waitFor(() => sse.text().includes(SESSION), 3000), 'session attached first')

    const realOpen = fs.openSync
    const openSync = mock.method(fsModule, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === transcript) throw Object.assign(new Error(`EPERM: operation not permitted, open '${transcript}'`), { code: 'EPERM' })
      return realOpen(...args)
    })
    try {
      fs.appendFileSync(transcript, userLine('more'))
      await sleep(POLL_FALLBACK_MS + 500)
      assert.ok(openSync.mock.calls.some(c => c.arguments[0] === transcript), 'the poll did try to open the transcript')
    } finally { openSync.mock.restore() }
    assert.equal(await getStatus(), 200)
  })

  it('any other exception in the poll is logged and detaches the session with session-ended', async () => {
    const sse = await connectSSE()
    await sleep(200)
    const subagents = path.join(path.dirname(transcript), SESSION, 'subagents')
    const realExists = fs.existsSync
    const existsSync = mock.method(fsModule, 'existsSync', (p: fs.PathLike) => {
      if (p === subagents) throw new Error('injected failure')
      return realExists(p)
    })
    const errors = mock.method(console, 'error', () => {})
    try {
      assert.ok(await waitFor(() => sse.text().includes(`"type":"session-ended","sessionId":"${SESSION}"`), POLL_FALLBACK_MS + 1500),
        'session-ended broadcast')
    } finally { existsSync.mock.restore(); errors.mock.restore() }
    assert.ok(errors.mock.calls.some(c => String(c.arguments.join(' ')).includes('injected failure')), 'the error is logged')
    assert.equal(await getStatus(), 200)
  })
})
