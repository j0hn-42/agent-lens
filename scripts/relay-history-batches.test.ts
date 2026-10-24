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

/** A transcript whose current turn holds `n` assistant messages, put in place at once (never seen half written). */
function writeTranscript(sessionId: string, n: number, body: (i: number) => string) {
  const now = Date.now()
  let text = line({ type: 'user', cwd: realWs, timestamp: new Date(now - 60_000).toISOString(), message: { role: 'user', content: `start ${sessionId}` } })
  for (let i = 0; i < n; i++) {
    text += line({
      type: 'assistant', timestamp: new Date(now - 60_000 + i).toISOString(),
      message: { role: 'assistant', id: `msg_${sessionId.slice(-4)}_${i}`, content: [{ type: 'text', text: body(i) }] },
    })
  }
  const tmp = path.join(fakeHome, `${sessionId}.tmp`)
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, path.join(projectDir, `${sessionId}.jsonl`))
  return text.length
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
    const N = 4000
    const bytes = writeTranscript(BIG, N, i => `big${i} ${'x'.repeat(1900)}`)
    assert.ok(bytes > 4 * RELAY_MAX_CLIENT_BACKLOG_BYTES, 'precondition: the history is far above the slow-client limit')
    // Discovered, read and its sending started while the client does not read
    assert.ok(await waitFor(() => relay.debugState().watchedSessions >= 1, 15_000), 'precondition: the session is attached')
    await sleep(1500)
    assert.equal(relay.debugState().sseClients, 1, 'still connected while it does not read')
    c.res.socket.resume()
    c.res.resume()
    const all = () => contentsOf(c.msgs, BIG).filter(s => s.startsWith('big')).length
    assert.ok(await waitFor(() => all() >= N, 20_000), `the whole history arrives (${all()}/${N})`)
    assert.equal(c.closed(), false, 'the client stays connected')
    assert.equal(relay.debugState().sseClients, 1)

    const mine = c.msgs.filter(m => eventsOf([m], BIG).length > 0)
    assert.equal(mine.filter(m => m.type === 'agent-event').length, 0, 'no event of the history goes out one by one')
    assert.ok(mine.every(m => m.type === 'agent-event-batch' && m.events!.length <= RELAY_REPLAY_BATCH_SIZE), 'batches of the replay size')
    assert.ok(mine.every(m => m.events!.every(e => e.sessionId === BIG)), 'one session per batch')
    assert.ok(eventsOf(c.msgs, BIG).every(e => e.replayed === true), 'history, not live')
    const contents = contentsOf(c.msgs, BIG).filter(s => s.startsWith('big'))
    assert.deepEqual(contents.map(s => Number(s.slice(3, s.indexOf(' ')))), Array.from({ length: N }, (_, i) => i), 'in order, once each')
    // The resume point follows the history it covers
    const lastBatch = c.msgs.lastIndexOf(mine.at(-1)!)
    assert.ok(c.msgs.slice(lastBatch + 1).some(m => m.type === 'relay-cursor'), 'a relay-cursor after the batches')
    c.req.destroy()
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
  })

  it('applies the buffer cap before sending, and counts what it let go of as lost (event-loss after the batches)', async () => {
    const c = await connectSSE()
    await sleep(200)
    const N = RELAY_MAX_EVENTS_PER_SESSION + 1500
    writeTranscript(LONG, N, i => `long${i}`)
    const loss = () => c.msgs.find(m => m.type === 'event-loss' && (m.evicted?.[LONG] ?? 0) > 0)
    assert.ok(await waitFor(() => loss() !== undefined, 20_000), 'the clients are told what the cap let go of')
    const sent = eventsOf(c.msgs, LONG)
    const evicted = loss()!.evicted![LONG]
    assert.equal(loss()!.gap?.[LONG], evicted, 'the same count as a gap, for a page that already reconnected')
    assert.ok(sent.length <= RELAY_MAX_EVENTS_PER_SESSION, `at most the buffer cap is sent (${sent.length})`)
    assert.ok(eventsOf(c.msgs.slice(c.msgs.indexOf(loss()!)), LONG).length === 0, 'the loss comes after the batches')
    const contents = contentsOf(c.msgs, LONG)
    assert.ok(contents.includes(`long${N - 1}`), 'the newest events are the ones kept')
    assert.equal(new Set(contents).size, contents.length, 'each event once')

    // A client connecting now gets the buffer and the relay's tally: the same total, nothing hidden
    const late = await connectSSE()
    assert.ok(await waitFor(() => late.msgs.some(m => m.type === 'relay-cursor'), 10_000), 'the late client gets its replay')
    const lateLoss = late.msgs.find(m => m.type === 'event-loss')?.evicted?.[LONG] ?? 0
    assert.equal(sent.length + evicted, eventsOf(late.msgs, LONG).length + lateLoss, 'sent + lost = replayed + lost')
    assert.equal(c.closed(), false)
  })
})
