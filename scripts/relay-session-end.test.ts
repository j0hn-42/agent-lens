/**
 * Relay side of #360: a session ends only when its end is observed. A Stop hook is a turn end (agent_idle
 * `turnEnd`), never agent_complete for the orchestrator; a SessionEnd hook of a watched session ends it
 * (agent_complete `sessionEnd`, then session-ended), once. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-session-end-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_IMPORT

const SESSION = '36036036-0360-4360-8360-000000000360'
const line = (o: unknown) => JSON.stringify(o) + '\n'
type Msg = { type: string; sessionId?: string; event?: Ev; events?: Ev[] }
type Ev = { type: string; payload: Record<string, unknown>; sessionId?: string }

describe('relay: only an observed end ends a session (#360)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let req: http.ClientRequest | undefined
  let hookPort = 0
  let buf = ''

  const messages = (): Msg[] => buf.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Msg)
  const events = (): Ev[] => messages()
    .flatMap(m => m.type === 'agent-event-batch' ? (m.events ?? []) : m.type === 'agent-event' && m.event ? [m.event] : [])
    .filter(e => e.sessionId === SESSION)
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 20))
  }
  const postHook = (payload: unknown): Promise<number> => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const r = http.request({
      host: '127.0.0.1', port: hookPort, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    r.on('error', reject)
    r.end(body)
  })

  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      line({ type: 'user', uuid: 'u1', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the tests' } }))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: cwd, runtime: 'claude' })
    const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
    const file = fs.readdirSync(discoveryDir).find(f => f.endsWith('.json'))!
    hookPort = JSON.parse(fs.readFileSync(path.join(discoveryDir, file), 'utf8')).port
    server = http.createServer((rq, res) => {
      if (guardRequest(rq, res, { kind: 'api' })) return
      if (rq.url?.startsWith('/events')) return void relay.handleSSE(rq, res)
      res.writeHead(404); res.end()
    })
    const port = await listenLoopback(server, 0)
    req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.setEncoding('utf8'); res.on('data', c => { buf += c }) })
    await waitFor(() => events().some(e => e.type === 'agent_spawn'))
    assert.ok(events().some(e => e.type === 'agent_spawn'), 'precondition: the relay watches the session')
  })

  after(() => {
    req?.destroy()
    relay?.dispose()
    server?.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('a Stop is a turn end: agent_idle turnEnd, no agent_complete, no session-ended', async () => {
    assert.equal(await postHook({ session_id: SESSION, hook_event_name: 'Stop' }), 200)
    await waitFor(() => events().some(e => e.type === 'agent_idle' && e.payload.turnEnd === true))
    assert.ok(events().some(e => e.type === 'agent_idle' && e.payload.turnEnd === true))
    assert.ok(!events().some(e => e.type === 'agent_complete'), 'the orchestrator is not done after a turn')
    assert.ok(!messages().some(m => m.type === 'session-ended' && m.sessionId === SESSION))
  })

  it('a SessionEnd ends the session: agent_complete sessionEnd, then session-ended, once', async () => {
    assert.equal(await postHook({ session_id: SESSION, hook_event_name: 'SessionEnd' }), 200)
    await waitFor(() => messages().some(m => m.type === 'session-ended' && m.sessionId === SESSION))
    assert.ok(events().some(e => e.type === 'agent_complete' && e.payload.sessionEnd === true))
    assert.equal(messages().filter(m => m.type === 'session-ended' && m.sessionId === SESSION).length, 1)
  })
})
