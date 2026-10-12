/**
 * `event-loss` SSE message (issue #366): the relay tells each /events client, before the replay, how many
 * events per session it can no longer replay (replay cap here). Filtered by ?session=, absent when nothing
 * was lost. Own file: the relay is a per-process singleton.
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

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-loss-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '66666666-6666-4666-8666-666666666666'
const OTHER = '77777777-7777-4777-8777-777777777777'
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

interface Msg { type: string; evicted?: Record<string, number>; otherEvents?: number }

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
          msgs.push({ type: m.type, evicted: m.evicted, otherEvents: m.otherEvents })
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

describe('relay: event-loss message (issue #366)', () => {
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
    // Discovered by the first connect; the bulk is appended afterwards and read live
    const first = await collect('', 1_500)
    assert.ok(first.messages >= 1, 'precondition: the session is discovered')
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

  it('sends event-loss before the first replay batch, counting what the replay cap left out', async () => {
    const { msgs, messages } = await collect('', 3_000)
    const lossAt = msgs.findIndex(m => m.type === 'event-loss')
    const batchAt = msgs.findIndex(m => m.type === 'agent-event-batch')
    assert.ok(lossAt >= 0, 'event-loss is sent')
    assert.ok(batchAt < 0 || lossAt < batchAt, 'event-loss comes before the replay')
    assert.equal(msgs.filter(m => m.type === 'event-loss').length, 1, 'once per connection')
    const lost = msgs[lossAt].evicted?.[SESSION] ?? 0
    assert.ok(lost > 0, 'the session reports a loss')
    assert.ok(messages < MESSAGES, 'the replay is partial')
    assert.ok(lost >= MESSAGES - messages - 1, `the loss accounts for the missing messages (${lost} lost, ${messages}/${MESSAGES} replayed)`)
  })

  it('?session= keeps only that session in the counts, and sends nothing for a session with no loss', async () => {
    const own = await collect(`?session=${SESSION}`, 2_000)
    const loss = own.msgs.find(m => m.type === 'event-loss')
    assert.deepEqual(Object.keys(loss?.evicted ?? {}), [SESSION])
    assert.equal(loss?.otherEvents, undefined)
    const other = await collect(`?session=${OTHER}`, 1_000)
    assert.equal(other.msgs.some(m => m.type === 'event-loss'), false)
  })
})
