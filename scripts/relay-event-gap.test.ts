/**
 * Events a client missed while its link was down (issue #366): each /events connection gets a `relay-cursor` (the
 * relay's instance id and the number of the last event it delivered) before the replay, every live event carries its
 * number, and a client that reconnects with `?since=<instance>.<seq>` is told in `event-loss.gap`, per session, how
 * many events numbered after `since` it will never receive (the replay cap here). Own file: the relay is a singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'
import { RELAY_MAX_REPLAY_PER_SESSION } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-gap-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '88888888-8888-4888-8888-888888888888'
const MESSAGES = RELAY_MAX_REPLAY_PER_SESSION + 600
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const userLine = (text: string) => JSON.stringify({
  type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: text },
}) + '\n'

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let realWs = ''
const open: http.ClientRequest[] = []

interface Msg { type: string; evicted?: Record<string, number>; gap?: Record<string, number>; instance?: string; seq?: number }

/** Connects, collects the SSE messages (type and loss payload) for `ms`, then disconnects. */
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
        }
      })
      setTimeout(() => { req.destroy(); resolve({ msgs, messages }) }, ms)
    })
    open.push(req)
    req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
  })
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await sleep(50) }
  return cond()
}

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
    const transcript = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(transcript, userLine('m0'))
    // Discovered by the first connect, which keeps the cursor; the bulk is appended once it is gone
    const first = await collect('', 1_500)
    assert.ok(first.messages >= 1, 'precondition: the session is discovered')
    firstCursor = cursorOf(first.msgs)
    for (let i = 1; i < MESSAGES; i += 100) {
      let chunk = ''
      for (let j = i; j < Math.min(i + 100, MESSAGES); j++) chunk += userLine(`m${j}`)
      fs.appendFileSync(transcript, chunk)
      await sleep(60)
    }
    await waitFor(() => relay.debugState().sseClients === 0, 2_000)
    await sleep(1_000)
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('sends a relay cursor before the replay: an instance id and a number', async () => {
    assert.ok(firstCursor, 'the first connection got a cursor')
    assert.match(firstCursor!.instance, /^[0-9a-f]{8,64}$/)
    assert.ok(Number.isSafeInteger(firstCursor!.seq) && firstCursor!.seq >= 0)
    const { msgs } = await collect('', 2_000)
    const at = msgs.findIndex(m => m.type === 'relay-cursor')
    const batchAt = msgs.findIndex(m => m.type === 'agent-event-batch')
    assert.ok(at >= 0 && (batchAt < 0 || at < batchAt), 'the cursor comes before the replay')
    assert.equal(cursorOf(msgs)!.instance, firstCursor!.instance, 'one instance id for the life of the relay')
    assert.ok(cursorOf(msgs)!.seq > firstCursor!.seq, 'the events delivered since are numbered after it')
  })

  it('a client back with ?since= is told the events numbered after it that the replay cannot give back', async () => {
    const { msgs, messages } = await collect(`?since=${firstCursor!.instance}.${firstCursor!.seq}`, 3_000)
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
  })
})
