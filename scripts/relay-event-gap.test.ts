/**
 * Events a client missed while its link was down (issue #366): each /events connection gets a `relay-cursor` (the
 * relay's instance id and the number of the last event it delivered) once its replay is written, every live event
 * carries its number, and a client that reconnects with `?since=<instance>.<seq>` is told in `event-loss.gap`, per
 * session, how many events numbered after `since` it will never receive: the replay cap leaves them out, or the buffer
 * evicted them while the link was down. Own file: the relay is a singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'
import { RELAY_MAX_REPLAY_PER_SESSION, RELAY_MAX_EVENTS_PER_SESSION } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-gap-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '88888888-8888-4888-8888-888888888888'
const OTHER_SESSION = '99999999-9999-4999-8999-999999999999'
const MESSAGES = RELAY_MAX_REPLAY_PER_SESSION + 600
// Appended while no client is connected, past the per-session buffer: the buffer evicts, not only the replay cap
const MORE = RELAY_MAX_EVENTS_PER_SESSION + 600
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

interface Msg { type: string; evicted?: Record<string, number>; gap?: Record<string, number>; instance?: string; seq?: number }

/**
 * Connects, collects the SSE messages (type and loss payload), then disconnects: shortly after the cursor (the relay
 * sends it once the replay is written, so the replay is complete whatever the machine load), or after `ms` at most.
 */
function collect(query: string, ms: number): Promise<{ msgs: Msg[]; messages: number }> {
  return new Promise((resolve, reject) => {
    const msgs: Msg[] = []
    let messages = 0
    let pending = ''
    const req = http.get({ host: '127.0.0.1', port, path: '/events' + query, agent: false }, res => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const blocks = (pending + chunk).split('\n\n')
        pending = blocks.pop() ?? ''
        for (const b of blocks) {
          if (!b.startsWith('data: ')) continue
          const m = JSON.parse(b.slice(6))
          msgs.push({ type: m.type, evicted: m.evicted, gap: m.gap, instance: m.instance, seq: m.seq })
          const evs = m.type === 'agent-event-batch' ? m.events : []
          messages += evs.filter((e: { type: string }) => e.type === 'message').length
          if (m.type === 'relay-cursor') setTimeout(done, 100)
        }
      })
      const timer = setTimeout(done, ms)
      function done() { clearTimeout(timer); req.destroy(); resolve({ msgs, messages }) }
    })
    open.push(req)
    req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
  })
}

async function appendLines(file: string, from: number, to: number) {
  for (let i = from; i < to; i += 100) {
    let chunk = ''
    for (let j = i; j < Math.min(i + 100, to); j++) chunk += userLine(`m${j}`)
    fs.appendFileSync(file, chunk)
    await sleep(60)
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await sleep(50) }
  return cond()
}

/** Polls (one short connection per try) until the relay has numbered `count` events more than `from`: the lines appended are read */
async function waitForCursorAdvance(from: number, count: number, ms = 15_000): Promise<number> {
  const end = Date.now() + ms
  let seq = from
  while (Date.now() < end) {
    seq = cursorOf((await collect('?session=' + OTHER_SESSION, 3_000)).msgs)?.seq ?? seq
    if (seq >= from + count) return seq
    await sleep(100)
  }
  return seq
}

/** Messages in the transcript so far, whatever the tests before appended */
const linesWritten = () => fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length

const cursorOf = (msgs: Msg[]) => {
  const c = msgs.find(m => m.type === 'relay-cursor')
  return c && typeof c.instance === 'string' && typeof c.seq === 'number' ? { instance: c.instance, seq: c.seq } : null
}

describe('relay: events missed while the link was down (issue #366)', () => {
  let firstCursor: { instance: string; seq: number } | null = null

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
    fs.writeFileSync(transcript, userLine('m0'))
    // Discovered by the first connect, which keeps the cursor; the bulk is appended once it is gone
    const first = await collect('', 5_000)
    assert.ok(first.messages >= 1, 'precondition: the session is discovered')
    firstCursor = cursorOf(first.msgs)
    await appendLines(transcript, 1, MESSAGES)
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
    await sleep(1_000)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('sends a relay cursor once the replay is written: an instance id and a number', async () => {
    assert.ok(firstCursor, 'the first connection got a cursor')
    assert.match(firstCursor!.instance, /^[0-9a-f]{8,64}$/)
    assert.ok(Number.isSafeInteger(firstCursor!.seq) && firstCursor!.seq >= 0)
    const { msgs } = await collect('', 10_000)
    const at = msgs.findIndex(m => m.type === 'relay-cursor')
    const lastBatch = msgs.map(m => m.type).lastIndexOf('agent-event-batch')
    assert.ok(lastBatch >= 0, 'precondition: a replay')
    assert.ok(at > lastBatch, 'the cursor comes after the whole replay: it never claims events the client has not received')
    assert.equal(cursorOf(msgs)!.instance, firstCursor!.instance, 'one instance id for the life of the relay')
    assert.ok(cursorOf(msgs)!.seq > firstCursor!.seq, 'the events delivered since are numbered after it')
  })

  it('a client back with ?since= is told the events numbered after it that the replay cannot give back', async () => {
    const { msgs, messages } = await collect(`?since=${firstCursor!.instance}.${firstCursor!.seq}`, 10_000)
    assert.ok(cursorOf(msgs), 'precondition: the replay was written in full')
    const loss = msgs.find(m => m.type === 'event-loss')
    const gap = loss?.gap?.[SESSION] ?? 0
    assert.ok(messages < MESSAGES, 'precondition: the replay is partial')
    assert.ok(gap > 0, `a gap is reported (${JSON.stringify(loss)})`)
    assert.ok(gap >= MESSAGES - messages - 1, `the gap accounts for the messages it will never receive (${gap}, ${messages}/${MESSAGES} replayed)`)
    assert.ok(gap <= (loss?.evicted?.[SESSION] ?? 0), 'never more than what the relay lost for that session')
  })

  it('a since from another relay process, or the latest number, reports no gap', async () => {
    const stranger = await collect(`?since=${'0'.repeat(16)}.${firstCursor!.seq}`, 1_500)
    assert.equal(stranger.msgs.find(m => m.type === 'event-loss')?.gap, undefined, 'another instance: nothing can be counted')
    const now = cursorOf((await collect('', 1_500)).msgs)!
    const upToDate = await collect(`?since=${now.instance}.${now.seq}`, 1_500)
    assert.equal(upToDate.msgs.find(m => m.type === 'event-loss')?.gap?.[SESSION], undefined, 'nothing was numbered after it')
    const malformed = await collect('?since=nope', 1_500)
    assert.ok(malformed.msgs.some(m => m.type === 'relay-cursor'), 'a malformed since is ignored, the connection is served')
    assert.equal(malformed.msgs.find(m => m.type === 'event-loss')?.gap, undefined)
    // A number this relay never gave out (ahead of its last one) is not trusted
    const ahead = await collect(`?since=${now.instance}.${now.seq + 1000}`, 1_500)
    assert.ok(ahead.msgs.some(m => m.type === 'relay-cursor'), 'the connection is served')
    assert.equal(ahead.msgs.find(m => m.type === 'event-loss')?.gap, undefined, 'a since ahead of the relay counts nothing')
  })

  it('?session= limits the gap to that session', async () => {
    const other = await collect(`?session=${OTHER_SESSION}&since=${firstCursor!.instance}.${firstCursor!.seq}`, 3_000)
    assert.equal(other.msgs.find(m => m.type === 'event-loss')?.gap?.[SESSION], undefined, 'the gap of another session is not reported')
    const own = await collect(`?session=${SESSION}&since=${firstCursor!.instance}.${firstCursor!.seq}`, 10_000)
    assert.ok((own.msgs.find(m => m.type === 'event-loss')?.gap?.[SESSION] ?? 0) > 0, 'the gap of the requested session is')
  })

  it('counts the events the buffer evicted while the link was down, beyond what the replay cap alone leaves out', async () => {
    const before = cursorOf((await collect('', 10_000)).msgs)!
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
    await appendLines(transcript, linesWritten(), linesWritten() + MORE)
    assert.ok(await waitForCursorAdvance(before.seq, MORE) >= before.seq + MORE, 'precondition: the relay read the appended lines')
    const { msgs, messages } = await collect(`?since=${before.instance}.${before.seq}`, 15_000)
    assert.ok(cursorOf(msgs), 'precondition: the replay was written in full')
    const loss = msgs.find(m => m.type === 'event-loss')
    const gap = loss?.gap?.[SESSION] ?? 0
    // The buffer holds RELAY_MAX_EVENTS_PER_SESSION events and the replay gives back RELAY_MAX_REPLAY_PER_SESSION: the cap
    // alone cannot account for more than their difference, so a larger gap proves the evicted numbers were counted
    assert.ok(gap > RELAY_MAX_EVENTS_PER_SESSION - RELAY_MAX_REPLAY_PER_SESSION, `the evicted events count (${gap})`)
    assert.ok(gap >= MORE - messages, `every message missed is accounted for (${gap}, ${messages} replayed of ${MORE} appended)`)
  })

  it('a client back with a valid ?since= is replayed only the events numbered after it (#653)', async () => {
    const now = cursorOf((await collect('', 10_000)).msgs)!
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
    const FEW = 5
    const base = linesWritten()
    await appendLines(transcript, base, base + FEW)
    assert.ok(await waitForCursorAdvance(now.seq, FEW) >= now.seq + FEW, 'precondition: the relay read the appended lines')
    const full = await collect('', 10_000)
    assert.ok(full.messages > 100, `precondition: a connection without since replays the buffer (${full.messages})`)
    const resumed = await collect(`?since=${now.instance}.${now.seq}`, 10_000)
    assert.ok(cursorOf(resumed.msgs), 'precondition: the replay was written in full')
    assert.equal(resumed.messages, FEW, 'only the messages the client has not received are replayed')
    assert.equal(resumed.msgs.find(m => m.type === 'event-loss')?.gap?.[SESSION], undefined, 'nothing was lost: no gap')
  })
})
