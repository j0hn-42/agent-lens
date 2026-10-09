/**
 * Replay order and sessions known only from the index (#66): an indexed session is never a candidate
 * for the 'primary' (last replayed) session, even when it looks more recent than the live ones.
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
import type { IndexOpener } from '../extension/src/session-index'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-replay-idx-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const OLD = '55555555-5555-4555-8555-555555555555'
const NEWER = '66666666-6666-4666-8666-666666666666'
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
const open: http.ClientRequest[] = []

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

describe('relay: replay order with indexed sessions', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const real = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const old = Date.now() - 5 * 60 * 1000
    const file = (id: string, at: number) => {
      const f = path.join(projectDir, `${id}.jsonl`)
      fs.writeFileSync(f, line({ type: 'user', cwd: real, timestamp: new Date(at).toISOString(), message: { role: 'user', content: `go ${id}` } }))
      fs.utimesSync(f, new Date(at), new Date(at))
    }
    file(NEWER, old + 60_000)
    file(OLD, old)
    // The index claims a session far more recent than both live ones
    const opener: IndexOpener = () => ({
      all(sql: string) {
        if (/PRAGMA user_version/i.test(sql)) return [{ user_version: 1 }]
        if (/PRAGMA table_info/i.test(sql)) return ['id', 'started_at', 'label', 'parent_id', 'cwd', 'workspace'].map(name => ({ name }))
        return [{ id: 'idx-future', started_at: Date.now() + 3_600_000, label: 'Indexed', cwd: real }]
      },
      close() { /* nothing */ },
    })
    const dbFile = path.join(fakeHome, 'index.db')
    fs.writeFileSync(dbFile, '')
    relay = await createRelay({ workspace: ws, runtime: 'claude', sessionIndex: { path: dbFile, opener, cacheMs: 0 } })
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

  it('the most recent LIVE session is replayed last, whatever the indexed sessions look like', async () => {
    const c = await connectSSE()
    // The list is written first, then one replay batch per live session
    assert.ok(await waitFor(() => messages(c.text()).filter(m => m.type === 'agent-event-batch').length >= 2), 'both live buffers are replayed')
    const msgs = messages(c.text())
    const list = msgs.find(m => m.type === 'session-list') as { sessions: Array<{ id: string; indexedOnly?: boolean; lastActivityTime: number }> }
    const idx = list.sessions.find(s => s.id === 'idx-future')
    assert.ok(idx?.indexedOnly, 'precondition: the indexed session is listed')
    const live = list.sessions.filter(s => !s.indexedOnly)
    assert.ok(idx!.lastActivityTime > Math.max(...live.map(s => s.lastActivityTime)), 'precondition: the indexed one looks the most recent')
    const order = msgs.filter(m => m.type === 'agent-event-batch')
      .map(m => (m.events as Array<{ sessionId: string }>)[0].sessionId)
    assert.deepEqual([...order].sort(), [OLD, NEWER], 'both live buffers are replayed, none for the indexed session')
    const newest = Math.max(...live.map(s => s.lastActivityTime))
    const candidates = live.filter(s => s.lastActivityTime === newest).map(s => s.id)
    assert.ok(candidates.includes(order[order.length - 1]), `the most recent live session comes last, got ${order.join(',')} (live: ${JSON.stringify(live.map(s => [s.id, s.lastActivityTime]))})`)
  })
})
