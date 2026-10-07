/**
 * Relay integration for issues #53 and #68, over real HTTP on 127.0.0.1 ephemeral ports:
 *  - a tool call present in the transcript AND reported by a hook appears once; a hook-only one is kept
 *  - 50 parallel GET /status share ONE in-flight refresh
 *  - the shared scan interval runs only while an SSE client is connected
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStatusPath } from '../extension/src/relay-guards'
import { guardRequest, listenLoopback } from './server-hardening'
import { CSP_API } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-hard-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '33333333-3333-4333-8333-333333333333'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let hookPort = 0
let probeCalls = 0
let transcript = ''
const open: http.ClientRequest[] = []

function getRaw(urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
  })
}

function connectSSE(urlPath = '/events'): Promise<{ res: http.IncomingMessage; req: http.ClientRequest; text: () => string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      resolve({ res, req, text: () => buf })
    })
    open.push(req)
    req.on('error', reject)
  })
}

function eventsOf(text: string): Array<{ type: string; payload: Record<string, unknown>; sessionId?: string }> {
  const out: Array<{ type: string; payload: Record<string, unknown>; sessionId?: string }> = []
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data: ')) continue
    const msg = JSON.parse(block.slice(6))
    if (msg.type === 'agent-event') out.push(msg.event)
    else if (msg.type === 'agent-event-batch') out.push(...msg.events)
  }
  return out
}

function postHook(payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port: hookPort, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(body)
  })
}

describe('relay: hardening and source reconciliation', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(transcript,
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }))

    relay = await createRelay({
      workspace: ws, runtime: 'claude',
      hooksProbe: async () => { probeCalls++; await sleep(600); return true },
    })
    const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
    const file = fs.readdirSync(discoveryDir).find(f => f.endsWith('.json'))!
    hookPort = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8')).port

    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (isStatusPath(req.url)) return void relay.handleStatus(req, res)
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

  const toolUse = (id: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
  const hook = (id: string) => ({
    session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' },
  })
  async function startsOf(): Promise<Array<Record<string, unknown>>> {
    const c = await connectSSE(`/events?session=${SESSION}`)
    await sleep(300)
    c.req.destroy()
    return eventsOf(c.text()).filter(e => e.type === 'tool_call_start').map(e => e.payload)
  }

  it('a tool call reported by the transcript THEN a hook appears once', async () => {
    fs.appendFileSync(transcript, toolUse('tu-jsonl-first'))
    // Precondition (keeps the test from passing vacuously): the transcript alone reports the call
    await sleep(500)
    assert.equal((await startsOf()).filter(p => p.toolUseId === 'tu-jsonl-first').length, 1, 'transcript copy present')
    assert.equal(await postHook(hook('tu-jsonl-first')), 200)
    await sleep(100)
    assert.equal((await startsOf()).filter(p => p.toolUseId === 'tu-jsonl-first').length, 1, 'late hook copy dropped')
  })

  it('a tool call reported by a hook THEN the transcript appears once (late JSONL)', async () => {
    assert.equal(await postHook(hook('tu-hook-first')), 200)
    await sleep(100)
    assert.equal((await startsOf()).filter(p => p.toolUseId === 'tu-hook-first').length, 1, 'hook copy present')
    fs.appendFileSync(transcript, toolUse('tu-hook-first'))
    await sleep(500)
    assert.equal((await startsOf()).filter(p => p.toolUseId === 'tu-hook-first').length, 1, 'late JSONL copy dropped')
  })

  it('a call only reported by a hook is kept', async () => {
    assert.equal(await postHook(hook('tu-hook-only')), 200)
    await sleep(100)
    assert.equal((await startsOf()).filter(p => p.toolUseId === 'tu-hook-only').length, 1)
  })

  it('serves strict headers on the SSE stream', async () => {
    const c = await connectSSE()
    c.req.destroy()
    assert.equal(c.res.headers['cache-control'], 'no-store')
    assert.equal(c.res.headers['content-security-policy'], CSP_API)
    assert.equal(c.res.headers['x-content-type-options'], 'nosniff')
    assert.equal(c.res.headers['referrer-policy'], 'no-referrer')
  })

  it('shares ONE in-flight refresh between 50 parallel GET /status', async () => {
    const before = relay.debugState().statusRuns
    const probeBefore = probeCalls
    // Distinct User-Agents: each client has its own rate-limit bucket
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => getRaw('/status', { 'User-Agent': `agent-${i}` })))
    assert.ok(results.every(r => r.status === 200), results.map(r => r.status).join(','))
    assert.ok(results.every(r => JSON.parse(r.body).hooksConfigured === true))
    assert.equal(relay.debugState().statusRuns - before, 1, 'one computation for 50 requests')
    assert.equal(probeCalls - probeBefore, 1, 'one settings read for 50 requests')
  })

  it('runs the shared scan interval only while an SSE client is connected', async () => {
    await sleep(200) // clients of the previous tests are gone
    assert.equal(relay.debugState().sseClients, 0)
    assert.equal(relay.debugState().scanTimerActive, false, 'no client, no timer')

    const a = await connectSSE()
    const b = await connectSSE()
    await sleep(100)
    assert.equal(relay.debugState().sseClients, 2)
    assert.equal(relay.debugState().scanTimerActive, true)

    a.req.destroy()
    await sleep(150)
    assert.equal(relay.debugState().sseClients, 1)
    assert.equal(relay.debugState().scanTimerActive, true, 'still one client')

    b.req.destroy()
    await sleep(150)
    assert.equal(relay.debugState().sseClients, 0)
    assert.equal(relay.debugState().scanTimerActive, false, 'last client left: timer stopped')
  })

  it('refreshes (scans) when a client connects', async () => {
    const before = relay.debugState().scanRuns
    const c = await connectSSE()
    await sleep(100)
    c.req.destroy()
    assert.ok(relay.debugState().scanRuns > before)
  })
})
