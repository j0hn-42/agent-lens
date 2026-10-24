/**
 * History read at attach (#652). What the relay reads from a transcript it starts following goes to the clients
 * once the read is over, the buffer cap applied first: in `agent-event-batch` messages per session (at most
 * RELAY_REPLAY_BATCH_SIZE events), written with a wait for 'drain' like the connect replay (#203), never as one
 * message per event in a single tick (a client that reads slowly was dropped as slow, then got a full replay).
 * The events the cap let go of before they were sent are not hidden: an `event-loss` follows the batches with them
 * (`gap` for a page that already reconnected, the new figure for one on its first connection), then a `relay-cursor`.
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
import { RELAY_MAX_CLIENT_BACKLOG_BYTES, RELAY_REPLAY_BATCH_SIZE, RELAY_MAX_EVENTS_PER_SESSION } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-history-batches-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const BIG = '65265265-2652-4652-8652-652652652651'
const LONG = '65265265-2652-4652-8652-652652652652'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const line = (o: unknown) => JSON.stringify(o) + '\n'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
type Ev = { type: string; sessionId?: string; replayed?: boolean; payload?: { content?: unknown } }
type Msg = { type: string; event?: Ev; events?: Ev[]; evicted?: Record<string, number>; gap?: Record<string, number> }
let relay: Relay
let server: http.Server
let port = 0
let projectDir = ''
let realWs = ''
const open: http.ClientRequest[] = []

interface Client { req: http.ClientRequest; res: http.IncomingMessage; msgs: Msg[]; closed: () => boolean }

function connectSSE(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      const msgs: Msg[] = []
      let pending = ''
      let isClosed = false
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const blocks = (pending + chunk).split('\n\n')
        pending = blocks.pop() ?? ''
        for (const b of blocks) if (b.startsWith('data: ')) msgs.push(JSON.parse(b.slice(6)))
      })
      res.on('close', () => { isClosed = true })
      res.on('error', () => { isClosed = true })
      resolve({ req, res, msgs, closed: () => isClosed })
    })
    open.push(req)
    req.on('error', reject)
  })
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

/**
 * A session whose attach reads a large history: the lead transcript (its catch-up) and `teammates` teammate files
 * already there, each replayed at attach (#361) with `lines` assistant lines of `blocks` text blocks. The teammate
 * files are written first and the lead transcript is put in place at once, so the attach finds them all.
 */
function writeSession(sessionId: string, teammates: number, lines: number, blocks: number, text: (k: number, j: number, b: number) => string): number {
  const now = Date.now()
  const subDir = path.join(projectDir, sessionId, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  let bytes = 0
  for (let k = 0; k < teammates; k++) {
    fs.writeFileSync(path.join(subDir, `agent-tm${k}.meta.json`), JSON.stringify({ taskKind: 'in_process_teammate', teamName: 'crew', name: `mate${k}` }))
    let body = ''
    for (let j = 0; j < lines; j++) {
      const content = Array.from({ length: blocks }, (_, b) => ({ type: 'text', text: text(k, j, b) }))
      for (const c of content) bytes += c.text.length
      body += line({ type: 'assistant', timestamp: new Date(now - 60_000 + j).toISOString(), message: { role: 'assistant', id: `msg_${k}_${j}`, content } })
    }
    fs.writeFileSync(path.join(subDir, `agent-tm${k}.jsonl`), body)
  }
  const lead = line({ type: 'user', cwd: realWs, timestamp: new Date(now - 60_000).toISOString(), message: { role: 'user', content: `start ${sessionId}` } })
  const tmp = path.join(fakeHome, `${sessionId}.tmp`)
  fs.writeFileSync(tmp, lead)
  fs.renameSync(tmp, path.join(projectDir, `${sessionId}.jsonl`))
  return bytes
}

const eventsOf = (msgs: Msg[], sid: string) => msgs.flatMap(m =>
  (m.type === 'agent-event' && m.event ? [m.event] : m.type === 'agent-event-batch' && m.events ? m.events : [])
    .filter(e => e.sessionId === sid))
const contentsOf = (msgs: Msg[], sid: string) => eventsOf(msgs, sid).filter(e => e.type === 'message')
  .map(e => e.payload?.content).filter((c): c is string => typeof c === 'string')

describe('relay: the history read at attach goes out in batches, after the buffer cap (#652)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
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

  it('a client that reads slowly is not dropped by the attach of a history larger than the slow-client limit', async () => {
    const c = await connectSSE()
    await sleep(200)
    // Stops reading at the socket level: the kernel buffers fill up and the relay's backlog grows
    c.res.pause()
    c.res.socket.pause()
    const TEAMMATES = 64, LINES = 40
    const bytes = writeSession(BIG, TEAMMATES, LINES, 1, (k, j) => `tm${k}-${j} ${'x'.repeat(1900)}`)
    assert.ok(bytes > 4 * RELAY_MAX_CLIENT_BACKLOG_BYTES, `precondition: the history is far above the slow-client limit (${bytes} bytes)`)
    // Discovered, read and its sending started while the client does not read
    assert.ok(await waitFor(() => relay.debugState().watchedSessions >= 1, 15_000), 'precondition: the session is attached')
    await sleep(1500)
    assert.equal(relay.debugState().sseClients, 1, 'still connected while it does not read')
    c.res.socket.resume()
    c.res.resume()
    const N = TEAMMATES * LINES
    const all = () => contentsOf(c.msgs, BIG).filter(s => s.startsWith('tm')).length
    assert.ok(await waitFor(() => all() >= N || c.closed(), 20_000) && !c.closed(), `the whole history arrives (${all()}/${N}, dropped: ${c.closed()})`)
    assert.equal(relay.debugState().sseClients, 1, 'the client stays connected')

    const mine = c.msgs.filter(m => eventsOf([m], BIG).length > 0)
    assert.equal(mine.filter(m => m.type === 'agent-event').length, 0, 'no event of the history goes out one by one')
    assert.ok(mine.every(m => m.type === 'agent-event-batch' && m.events!.length <= RELAY_REPLAY_BATCH_SIZE), 'batches of the replay size')
    assert.ok(mine.every(m => m.events!.every(e => e.sessionId === BIG)), 'one session per batch')
    assert.ok(eventsOf(c.msgs, BIG).every(e => e.replayed === true), 'history, not live')
    const contents = contentsOf(c.msgs, BIG).filter(s => s.startsWith('tm')).map(s => s.slice(0, s.indexOf(' ')))
    assert.equal(new Set(contents).size, N, 'once each')
    for (let k = 0; k < TEAMMATES; k++) {
      const own = contents.filter(s => s.startsWith(`tm${k}-`)).map(s => Number(s.slice(s.indexOf('-') + 1)))
      assert.deepEqual(own, Array.from({ length: LINES }, (_, j) => j), `the lines of teammate ${k}, in order`)
    }
    // The resume point follows the history it covers
    const lastBatch = c.msgs.lastIndexOf(mine.at(-1)!)
    assert.ok(c.msgs.slice(lastBatch + 1).some(m => m.type === 'relay-cursor'), 'a relay-cursor after the batches')
    c.req.destroy()
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
  })

  it('applies the buffer cap before sending, and counts what it let go of as lost (event-loss after the batches)', async () => {
    const c = await connectSSE()
    await sleep(200)
    // 64 teammates x 40 lines x 3 blocks: more messages than the per-session buffer holds
    const TEAMMATES = 64, LINES = 40, BLOCKS = 3
    assert.ok(TEAMMATES * LINES * BLOCKS > RELAY_MAX_EVENTS_PER_SESSION, 'precondition: the history exceeds the buffer cap')
    writeSession(LONG, TEAMMATES, LINES, BLOCKS, (k, j, b) => `t${k}-${j}-${b}`)
    const loss = () => c.msgs.find(m => m.type === 'event-loss' && (m.evicted?.[LONG] ?? 0) > 0)
    assert.ok(await waitFor(() => loss() !== undefined, 20_000), 'the clients are told what the cap let go of')
    const sent = eventsOf(c.msgs, LONG)
    const evicted = loss()!.evicted![LONG]
    assert.equal(loss()!.gap?.[LONG], evicted, 'the same count as a gap, for a page that already reconnected')
    assert.ok(sent.length <= RELAY_MAX_EVENTS_PER_SESSION, `at most the buffer cap is sent (${sent.length})`)
    assert.ok(eventsOf(c.msgs.slice(c.msgs.indexOf(loss()!)), LONG).length === 0, 'the loss comes after the batches')
    const contents = contentsOf(c.msgs, LONG)
    assert.ok(contents.includes(`t${TEAMMATES - 1}-${LINES - 1}-${BLOCKS - 1}`), 'the newest events are the ones kept')
    assert.equal(new Set(contents).size, contents.length, 'each event once')

    // A client connecting now gets the buffer and the relay's tally: the same total, nothing hidden
    const late = await connectSSE()
    assert.ok(await waitFor(() => late.msgs.some(m => m.type === 'relay-cursor'), 10_000), 'the late client gets its replay')
    const lateLoss = late.msgs.find(m => m.type === 'event-loss')?.evicted?.[LONG] ?? 0
    assert.equal(sent.length + evicted, eventsOf(late.msgs, LONG).length + lateLoss, 'sent + lost = replayed + lost')
    assert.equal(c.closed(), false)
  })
})
