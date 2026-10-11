/**
 * Imported transcripts in the relay (#294, track 1): a JSONL fetched from a cloud agent and passed with
 * `imports` (CLI --import / AGENT_LENS_IMPORT) goes through the same parser and reconciler as a local
 * session, but is marked imported, is never listed as active and is read once (no live watch).
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-imported-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_IMPORT

const CLOUD = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:07:00.000Z'
const line = (o: unknown) => JSON.stringify(o) + '\n'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
const open: http.ClientRequest[] = []
const importDir = path.join(fakeHome, 'downloads', 'cloud-sessions')
const transcript = path.join(importDir, `${CLOUD}.jsonl`)

async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return cond()
}

function get(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
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

const messages = (text: string): Array<Record<string, unknown>> =>
  text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)))

interface ListedSession {
  id: string; status: string; imported?: boolean; importedAt?: number; startTime: number; lastActivityTime: number
  lastActivityUnknown?: boolean; projectId?: string; cwd?: string
}

describe('relay with imported transcripts', () => {
  let importedAfter = 0
  before(async () => {
    fs.mkdirSync(importDir, { recursive: true })
    // A cloud session: container cwd, a finished turn, then a tool call whose result is not in the file
    fs.writeFileSync(transcript, [
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'user', uuid: 'u1', cwd: '/home/user/cloud-repo', gitBranch: 'feat/x', timestamp: T0, message: { role: 'user', content: 'Fix the cloud bug' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:01:00.000Z', message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'On it.' }] } }),
      line({ type: 'assistant', uuid: 'a2', timestamp: T1, message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'tool_use', id: 'toolu_pending', name: 'Bash', input: { command: 'pnpm test' } }] } }),
    ].join(''))
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    importedAfter = Date.now()
    relay = await createRelay({ workspace: ws, runtime: 'claude', imports: [importDir] })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (req.url?.startsWith('/observations')) return void relay.handleObservations(req, res)
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

  it('lists the imported session with its provenance, never as active', async () => {
    const c = await connectSSE()
    assert.ok(await waitFor(() => messages(c.text()).some(m => m.type === 'session-list')), 'the session list arrives')
    const list = messages(c.text()).find(m => m.type === 'session-list') as { sessions: ListedSession[] }
    const s = list.sessions.find(x => x.id === CLOUD)
    assert.ok(s, 'the imported session is listed')
    assert.equal(s.imported, true)
    assert.equal(s.status, 'completed', 'an imported session is never listed as active')
    assert.ok(typeof s.importedAt === 'number' && s.importedAt >= importedAfter, 'the import time is given')
    assert.equal(s.startTime, Date.parse(T0), 'start = first timestamp recorded in the file')
    assert.equal(s.lastActivityTime, Date.parse(T1), 'last activity = last timestamp recorded in the file, not the import time')
    assert.equal(s.lastActivityUnknown, undefined)
    assert.equal(s.projectId, undefined, 'a container cwd is never matched to a local project')
  })

  it('replays the transcript through the usual pipeline, every event marked imported', async () => {
    const c = await connectSSE()
    assert.ok(await waitFor(() => messages(c.text()).some(m => m.type === 'agent-event-batch')), 'the history is replayed')
    const events = messages(c.text()).filter(m => m.type === 'agent-event-batch')
      .flatMap(m => m.events as Array<{ sessionId?: string; type: string; imported?: boolean }>)
      .filter(e => e.sessionId === CLOUD)
    assert.ok(events.some(e => e.type === 'agent_spawn'), 'the orchestrator is spawned')
    assert.ok(events.some(e => e.type === 'tool_call_start'), `the recorded tool call is replayed: ${events.map(e => e.type).join(',')}`)
    assert.ok(events.every(e => e.imported === true), 'every event carries the imported provenance')
    assert.ok(!events.some(e => e.type === 'agent_complete'), 'no end is invented for the imported session')
  })

  it('reads the file once: a line appended later is not followed live', async () => {
    const c = await connectSSE()
    assert.ok(await waitFor(() => messages(c.text()).some(m => m.type === 'agent-event-batch')))
    const before = c.text().length
    fs.appendFileSync(transcript, line({ type: 'assistant', uuid: 'a3', timestamp: '2026-10-01T10:09:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Later line' }] } }))
    // Longer than the poll fallback of a live session (3 s): a live watch would have read the line by now
    await new Promise(r => setTimeout(r, 3500))
    const later = messages(c.text().slice(before)).filter(m => m.type === 'agent-event' || m.type === 'session-started')
    assert.deepEqual(later, [])
  })

  it('reports the provenance in the observations action, never as fresh or closed', async () => {
    const r = await get('/observations')
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body) as { sessions: Array<{ id: string; provenance?: string; freshness: string; agents?: unknown[] }> }
    const s = body.sessions.find(x => x.id === CLOUD)
    assert.ok(s)
    assert.equal(s.provenance, 'imported')
    assert.equal(s.freshness, 'stale', 'what an imported file recorded is only a last known state')
    assert.equal(s.agents, undefined, 'no agent state is reported as current for an imported session')
  })
})
