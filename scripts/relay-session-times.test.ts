/**
 * Session times listed by the relay (#365): the start is the one the transcript records, the last activity
 * is the file's mtime, never the moment the relay started watching. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-times-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const RECORDED = '55555555-5555-4555-8555-555555555555'
const UNRECORDED = '77777777-7777-4777-8777-777777777777'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const STARTED_AT = Date.now() - 3 * 3600_000
const WRITTEN_AT = Date.now() - 9 * 60_000

async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return cond()
}

type Listed = { id: string; startTime: number; lastActivityTime: number; recordedStartTime?: number; startTimeWatched?: boolean }
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

function listed(text: string): Listed[] {
  const lists = text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)))
    .filter(m => m.type === 'session-list').map(m => m.sessions as Listed[])
  return lists.at(-1) ?? []
}

describe('relay: session times come from the transcript, not from the relay clock', () => {
  let attachedAfter = 0
  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const recorded = path.join(projectDir, `${RECORDED}.jsonl`)
    fs.writeFileSync(recorded,
      line({ type: 'user', cwd: realWs, timestamp: new Date(STARTED_AT).toISOString(), message: { role: 'user', content: 'Long session' } }))
    fs.utimesSync(recorded, WRITTEN_AT / 1000, WRITTEN_AT / 1000)
    const unrecorded = path.join(projectDir, `${UNRECORDED}.jsonl`)
    fs.writeFileSync(unrecorded, line({ type: 'user', cwd: realWs, message: { role: 'user', content: 'No timestamp' } }))
    fs.utimesSync(unrecorded, WRITTEN_AT / 1000, WRITTEN_AT / 1000)

    attachedAfter = Date.now()
    const { createRelay } = await import('./relay')
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

  it('lists the recorded start and the mtime as last activity; an unrecorded start is flagged as watched', async () => {
    const c = await connectSSE()
    assert.ok(await waitFor(() => listed(c.text()).length >= 2), 'both sessions are listed')
    const byId = new Map(listed(c.text()).map(s => [s.id, s]))
    const rec = byId.get(RECORDED)!
    assert.equal(rec.recordedStartTime, STARTED_AT, 'the start the transcript records')
    assert.equal(rec.startTimeWatched, undefined)
    assert.ok(Math.abs(rec.lastActivityTime - WRITTEN_AT) < 2000, `last activity is the mtime (${rec.lastActivityTime} vs ${WRITTEN_AT}), not the attach`)
    assert.ok(rec.startTime >= attachedAfter, 'startTime stays the origin of the event times (watch start)')

    const unrec = byId.get(UNRECORDED)!
    assert.equal(unrec.recordedStartTime, undefined)
    assert.equal(unrec.startTimeWatched, true, 'without a recorded start, the listed start is only when watching began')
    assert.ok(Math.abs(unrec.lastActivityTime - WRITTEN_AT) < 2000)
  })
})
