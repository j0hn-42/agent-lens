/**
 * SSE replay back-pressure (issue #203). A replay larger than the slow-client backlog limit
 * (RELAY_MAX_CLIENT_BACKLOG_BYTES, 1 MiB) must reach a healthy client in full, even one that reads
 * slowly at first, instead of dropping it mid-replay (which made the web client reconnect in a loop).
 * Live events arriving during the replay come after it, and a client that stops reading is still
 * dropped on live broadcasts.
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
import { RELAY_MAX_CLIENT_BACKLOG_BYTES } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-replay-bp-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '55555555-5555-4555-8555-555555555555'
// Below the per-session buffer (each message also buffers a context update), well above 1 MiB in total
const MESSAGES = 900
const BODY = 'x'.repeat(1900)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const userLine = (text: string) => JSON.stringify({
  type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: text },
}) + '\n'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let realWs = ''
let transcript = ''
const open: http.ClientRequest[] = []

/** A connected SSE client; `messages` holds the content of every user message delivered, in arrival order. */
interface Client { req: http.ClientRequest; res: http.IncomingMessage; messages: string[]; closed: () => boolean }

/** Parsed as it arrives (not re-parsed on every poll): the test stays light enough not to slow down the others. */
function collectMessages(block: string, out: string[]) {
  if (!block.startsWith('data: ')) return
  const msg = JSON.parse(block.slice(6))
  const events = msg.type === 'agent-event' ? [msg.event] : msg.type === 'agent-event-batch' ? msg.events : []
  for (const e of events) {
    const content = e.type === 'message' ? (e.payload as { content?: unknown })?.content : undefined
    if (typeof content === 'string') out.push(content)
  }
}

function connectSSE(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      const messages: string[] = []
      let pending = ''
      let isClosed = false
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const blocks = (pending + chunk).split('\n\n')
        pending = blocks.pop() ?? ''
        for (const block of blocks) collectMessages(block, messages)
      })
      res.on('close', () => { isClosed = true })
      res.on('error', () => { isClosed = true })
      resolve({ req, res, messages, closed: () => isClosed })
    })
    open.push(req)
    // Rejects a failed connect; a later error (dropped by the relay) is asserted through closed()
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

describe('relay: SSE replay larger than the slow-client limit (issue #203)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)

    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    // The session is discovered from its first line (the scan on the first connect), then the bulk is
    // appended and read live: the catch-up of a discovered transcript only keeps its tail.
    fs.writeFileSync(transcript, userLine('m0 ' + BODY))
    const warm = await connectSSE()
    assert.ok(await waitFor(() => warm.messages.length >= 1, 10_000), 'precondition: the session is discovered')
    // Appended in small steps so this live client keeps up (a single 1.8 MB burst would drop it as slow)
    for (let i = 1; i < MESSAGES; i += 100) {
      let chunk = ''
      for (let j = i; j < Math.min(i + 100, MESSAGES); j++) chunk += userLine(`m${j} ${BODY}`)
      fs.appendFileSync(transcript, chunk)
      await waitFor(() => warm.messages.length >= Math.min(i + 100, MESSAGES), 2_000)
    }
    const loaded = await waitFor(() => warm.messages.length >= MESSAGES, 10_000)
    warm.req.destroy()
    assert.ok(loaded, `precondition: the transcript is loaded (${warm.messages.length}/${MESSAGES})`)
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('the buffered replay is larger than the slow-client limit', () => {
    assert.ok(MESSAGES * BODY.length > 1.5 * RELAY_MAX_CLIENT_BACKLOG_BYTES)
  })

  it('delivers the whole replay to a client that reads slowly at first, then live events after it', async () => {
    const c = await connectSSE()
    c.res.pause()
    await sleep(100)
    // Live event arriving while the replay is still blocked on the paused socket
    fs.appendFileSync(transcript, userLine('live-after-replay'))
    await sleep(400)
    assert.equal(c.closed(), false, 'not dropped while its replay waits for drain')
    c.res.resume()

    const done = await waitFor(() => c.messages.includes('live-after-replay'), 10_000)
    const contents = c.messages
    assert.ok(done, `the live event arrives (${contents.length} messages received)`)
    assert.equal(c.closed(), false, 'the client stays connected after the replay')
    assert.equal(relay.debugState().sseClients, 1)
    assert.equal(contents.filter(m => m.startsWith('m')).length, MESSAGES, 'every replayed message is delivered')
    assert.equal(contents.at(-1), 'live-after-replay', 'the live event comes after the replay, not in the middle of it')
    c.req.destroy()
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
  })

  it('still drops a client that never reads: its live backlog overflows while its replay waits', async () => {
    const c = await connectSSE()
    // Stop reading at the socket level, so the kernel buffers fill up instead of the client's memory
    c.res.pause()
    c.res.socket.pause()
    // Checked on the relay side: the paused client does not process the close until it reads again
    const connected = () => relay.debugState().sseClients > 0
    const big = 'y'.repeat(1900)
    for (let round = 0; round < 20 && connected(); round++) {
      let chunk = ''
      for (let i = 0; i < 100; i++) chunk += userLine(`live${round}-${i} ${big}`)
      fs.appendFileSync(transcript, chunk)
      await waitFor(() => !connected(), 100)
    }
    assert.equal(connected(), false, 'the stalled client is dropped once its held live messages exceed the limit')
  })
})
