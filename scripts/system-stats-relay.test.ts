/**
 * System panel feed (#357), end to end through createRelay: the sampler runs on ONE shared timer, only while a LOCAL
 * SSE client is connected, and `system-stats` is broadcast to local clients only (a tunnel Host never sees machine data).
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-sysstats-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const TUNNEL = 'box.tail1234.ts.net'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Polls `cond` until it holds (true) or `ms` elapse (false). */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0

interface Sse { messages: any[]; close: () => void; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }
function openSse(headers: http.OutgoingHttpHeaders = {}): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{ pred: (m: any) => boolean; done: (m: any) => void }> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          if (!frame.startsWith('data: ')) continue
          let m: any
          try { m = JSON.parse(frame.slice(6)) } catch { continue }
          messages.push(m)
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m) }
        }
      })
      resolve({
        messages, close: () => req.destroy(),
        waitFor: (pred, ms = 3000) => {
          const seen = messages.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('timed out waiting for an SSE message')), ms)
            waiters.push({ pred, done: m => { clearTimeout(t); res2(m) } })
          })
        },
      })
    })
    req.on('error', reject)
  })
}

describe('relay system-stats (#357)', () => {
  before(async () => {
    const dir = path.join(fakeHome, 'ws')
    fs.mkdirSync(dir, { recursive: true })
    const ws = fs.realpathSync(dir)
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', allowedHosts: [TUNNEL], systemIntervalMs: 20 })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => { relay.dispose(); server.close(); fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('a local client receives system-stats; the timer follows the first and the last connection', async () => {
    assert.equal(relay.debugState().systemTimerActive, false)
    const client = await openSse()
    const msg = await client.waitFor(m => m.type === 'system-stats')
    assert.equal(typeof msg.sample.ts, 'number')
    assert.equal(relay.debugState().systemTimerActive, true)
    client.close()
    assert.equal(await waitFor(() => relay.debugState().systemTimerActive === false), true)
  })

  it('after the timer stopped and restarted, the first sample has no CPU figure (counters reset)', async () => {
    const client = await openSse()
    const first = await client.waitFor(m => m.type === 'system-stats')
    assert.equal(first.sample.cpu.total, null)
    client.close()
    assert.equal(await waitFor(() => relay.debugState().systemTimerActive === false), true)
  })

  it('a tunnel Host never receives system-stats, even while a local client does, and never holds the timer', async () => {
    const local = await openSse()
    const remote = await openSse({ Host: TUNNEL })
    assert.equal(await waitFor(() => relay.debugState().remoteSseClients === 1), true, 'the tunnel client is really connected')
    assert.equal(await waitFor(() => local.messages.filter(m => m.type === 'system-stats').length >= 2), true, 'the local client is being fed')
    assert.equal(remote.messages.some(m => m.type === 'system-stats'), false)
    remote.close()
    assert.equal(await waitFor(() => relay.debugState().remoteSseClients === 0), true)
    assert.equal(relay.debugState().systemTimerActive, true, 'the local client still holds the timer')
    local.close()
    assert.equal(await waitFor(() => relay.debugState().systemTimerActive === false), true)
  })

  it('a tunnel Host alone does not start the timer', async () => {
    const remote = await openSse({ Host: TUNNEL })
    assert.equal(await waitFor(() => relay.debugState().remoteSseClients === 1), true)
    await sleep(100)
    assert.equal(relay.debugState().systemTimerActive, false)
    assert.equal(remote.messages.some(m => m.type === 'system-stats'), false)
    remote.close()
  })
})
