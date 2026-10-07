/**
 * Optional session index in the relay (#66): the indexed sessions join the session list on SSE connect,
 * a degraded index is reported in GET /status and never breaks the stream. Own file: the relay is a
 * per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveSessionLinks } from '../web/lib/session-links'
import { guardRequest, listenLoopback } from './server-hardening'
import { mergeIndexedSessions, type IndexOpener } from '../extension/src/session-index'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-index-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let mode: 'ok' | 'newer' = 'ok'
let opens = 0
const open: http.ClientRequest[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const opener: IndexOpener = () => {
  opens++
  return {
    all(sql: string) {
      if (/PRAGMA user_version/i.test(sql)) return [{ user_version: mode === 'newer' ? 99 : 1 }]
      if (/PRAGMA table_info/i.test(sql)) return ['id', 'started_at', 'label', 'parent_id'].map(name => ({ name }))
      return [
        { id: 'idx-parent', started_at: 1_700_000_000_000, label: 'Indexed parent', parent_id: null },
        { id: 'idx-child', started_at: 1_700_000_001_000, label: 'Indexed child', parent_id: 'idx-parent' },
      ]
    },
    close() { /* nothing */ },
  }
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

function sessionLists(text: string): Array<Array<{ id: string; status: string; parentSessionId?: string }>> {
  return text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)))
    .filter(m => m.type === 'session-list').map(m => m.sessions)
}

describe('relay with an optional session index', () => {
  const dbFile = path.join(fakeHome, 'index.db')

  before(async () => {
    fs.writeFileSync(dbFile, '')
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    relay = await createRelay({ workspace: ws, runtime: 'claude', sessionIndex: { path: dbFile, opener, cacheMs: 0 } })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      if (req.url?.startsWith('/status')) return void relay.handleStatus(req, res)
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

  it('adds the indexed sessions, as completed, with their declared parent', async () => {
    const c = await connectSSE()
    await sleep(200)
    const lists = sessionLists(c.text())
    assert.equal(lists.length, 1)
    const byId = new Map(lists[0].map(s => [s.id, s]))
    assert.equal(byId.get('idx-parent')?.status, 'completed')
    assert.equal((byId.get('idx-parent') as { indexedOnly?: boolean }).indexedOnly, true, 'index-only entries are marked, so the web never auto-selects them')
    assert.equal(byId.get('idx-child')?.parentSessionId, 'idx-parent')
  })

  it('/status reports the index state', async () => {
    const r = await get('/status')
    const body = JSON.parse(r.body)
    assert.equal(body.sessionIndex.status, 'ok')
    assert.equal(body.sessionIndex.count, 2)
  })

  it('a schema newer than supported is reported in /status and the stream still works', async () => {
    mode = 'newer'
    const body = JSON.parse((await get('/status')).body)
    assert.equal(body.sessionIndex.status, 'degraded')
    assert.match(body.sessionIndex.message, /version/i)
    const c = await connectSSE()
    await sleep(150)
    assert.equal(sessionLists(c.text()).length, 0, 'no session of the index, and no crash')
    mode = 'ok'
    assert.ok(opens > 0)
  })
})

describe('session list merged with the index', () => {
  const live = (id: string, extra: Record<string, unknown> = {}) => ({
    id, label: id, status: 'active' as const, startTime: 100, lastActivityTime: 200, runtime: 'claude', ...extra,
  })
  const idx = (id: string, extra: Record<string, unknown> = {}) => ({ id, startTime: 1, lastActivityTime: 2, ...extra })

  it('a live session adopts the declared parent of its index row, and the Task link is derived', () => {
    const merged = mergeIndexedSessions(
      [live('parent'), live('child')],
      [idx('child', { parentSessionId: 'parent' })] as never,
    )
    assert.equal(merged.length, 2, 'no duplicate entry')
    const child = merged.find(s => s.id === 'child')!
    assert.equal(child.status, 'active', 'the live facts win')
    assert.ok(!child.indexedOnly)
    assert.deepEqual(deriveSessionLinks(merged).map(l => `${l.kind}:${l.parentId}>${l.childId}`), ['task:parent>child'])
  })

  it('never overrides a live parent or cwd, and fills a missing cwd', () => {
    const merged = mergeIndexedSessions(
      [live('a', { parentSessionId: 'live-p', cwd: '/live' }), live('b')],
      [idx('a', { parentSessionId: 'idx-p', cwd: '/idx' }), idx('b', { cwd: '/idx-b' })] as never,
    )
    assert.equal(merged[0].parentSessionId, 'live-p')
    assert.equal(merged[0].cwd, '/live')
    assert.equal(merged[1].cwd, '/idx-b')
  })
})
