/**
 * SSE connect-time scan (issues #53, #68). A session discovered by the scan that runs when a client
 * connects must reach that client exactly ONCE (not live and again from the replay buffer).
 * Own file: the relay is a per-process singleton. The project dir does not exist when the relay starts,
 * so no dir watcher can discover the transcript before the client connects.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-conn-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '44444444-4444-4444-8444-444444444444'
const line = (o: unknown) => JSON.stringify(o) + '\n'
/** Polls `cond` until it holds (true) or `ms` elapse (false). Waits for what the relay does, never for a fixed time. */
async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return cond()
}

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let projectDir = ''
let realWs = ''
const open: http.ClientRequest[] = []

function connectSSE(urlPath = '/events'): Promise<{ req: http.ClientRequest; text: () => string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      resolve({ req, text: () => buf })
    })
    open.push(req)
    req.on('error', reject)
  })
}

/** Every SSE message in arrival order, flattened as "<kind>:<type>" with batches expanded. */
function messagesOf(text: string): string[] {
  const out: string[] = []
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data: ')) continue
    const msg = JSON.parse(block.slice(6))
    if (msg.type === 'agent-event') out.push(`E:${msg.event.type}`)
    else if (msg.type === 'agent-event-batch') for (const e of msg.events) out.push(`B:${e.type}`)
    else out.push(msg.type)
  }
  return out
}

describe('relay: session discovered by the scan on SSE connect', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
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

  it('delivers each event of the discovered session once to the connecting client', async () => {
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }))
    assert.equal(relay.debugState().scanRuns, 0, 'precondition: nothing scanned yet, so the scan runs on connect')

    const c = await connectSSE()
    const have = () => messagesOf(c.text())
    assert.ok(await waitFor(() => have().includes('session-list') && have().some(m => m.endsWith(':agent_spawn')) && have().some(m => m.endsWith(':message'))), `the session and its events arrive: ${have().join(',')}`)
    // The connect-time scan ran before the client joined the broadcast: let it finish, so a duplicate would show
    assert.ok(await waitFor(() => relay.debugState().scanRuns >= 1))
    c.req.destroy()
    const msgs = messagesOf(c.text())

    assert.ok(msgs.includes('session-list'), `the session is announced: ${msgs.join(',')}`)
    const spawns = msgs.filter(m => m.endsWith(':agent_spawn'))
    assert.equal(spawns.length, 1, `agent_spawn delivered once, got: ${msgs.join(',')}`)
    const messages = msgs.filter(m => m.endsWith(':message'))
    assert.equal(messages.length, 1, `the user message delivered once, got: ${msgs.join(',')}`)
  })

  it('forgets the delivered ids of every session when the relay is disposed (unwatchSession)', () => {
    assert.equal(relay.debugState().dedupSessions, 1, 'precondition: the watched session is remembered')
    relay.dispose()
    assert.equal(relay.debugState().dedupSessions, 0)
  })
})
