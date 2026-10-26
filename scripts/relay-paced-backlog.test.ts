/**
 * The paced backlog bound (RELAY_MAX_PACED_BACKLOG_BYTES, 32 Mi UTF-16 units) limits what the relay queues for a
 * client that does not read: past it the client is dropped ("paced backlog overflowed") and its page reconnects. It
 * now bounds the replay written at connection, so the largest replay the relay can build must stay under it, or a
 * page would be dropped and reconnect in a loop (#613). That replay is at most RELAY_MAX_REPLAY_TOTAL events, and a
 * message carries at most MESSAGE_MAX characters: this test fills the buffer with the largest ones (25 sessions,
 * so that the 10,000-event total is reached and the replay counts at least that many events), connects a client that
 * reads nothing, and checks it is kept and gets the whole replay, cursor included, once it reads.
 * It measures that case only (messages of MESSAGE_MAX = 2000 characters): other event types (a hook text can reach 4096
 * characters) are not covered, and the "paced backlog overflowed" branch is not run here.
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MESSAGE_MAX, RELAY_MAX_PACED_BACKLOG_BYTES, RELAY_MAX_REPLAY_PER_SESSION, RELAY_MAX_REPLAY_TOTAL } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-pb-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES

// A session attached from its transcript gives the buffer about 450 events (measured: not 2000, the per-session cap of the
// replay), so 25 sessions (the Claude watch limit) are what it takes to fill the 10,000-event total of the replay
const SESSIONS = 25
const sid = (n: number) => `61461461-0614-4614-8614-${String(n).padStart(12, '0')}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await sleep(20) }
  return cond()
}

describe('relay: the replay of 10,000 messages of 2000 characters stays under the paced backlog bound (#613)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0
  const open: http.ClientRequest[] = []

  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    for (let n = 0; n < SESSIONS; n++) {
      // One turn (the attach reads the current turn only): a prompt, then assistant messages of the largest size
      let body = JSON.stringify({ type: 'user', uuid: `u${n}`, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Go' } }) + '\n'
      for (let i = 0; i < RELAY_MAX_REPLAY_PER_SESSION + 100; i++) {
        const text = `${n}-${i}-`.padEnd(MESSAGE_MAX, 'x')
        body += JSON.stringify({ type: 'assistant', uuid: `a${n}-${i}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
      }
      fs.writeFileSync(path.join(projectDir, `${sid(n)}.jsonl`), body)
    }
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: cwd, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
    assert.ok(await waitFor(() => !relay.debugState().attaching && relay.debugState().dedupSessions === SESSIONS, 60_000), 'precondition: every session is attached')
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('a client that reads nothing is kept, then gets the whole replay and its cursor', async () => {
    let length = 0
    let tail = ''
    let text = ''
    let cursor = false
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, r => { r.pause(); resolve(r) })
      open.push(req)
      req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
    })
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      length += chunk.length
      tail = (tail + chunk).slice(-4096)
      text += chunk
      if (tail.includes('"type":"relay-cursor"')) cursor = true
    })
    // Nothing is read: the relay queues the whole replay behind the socket, within the bound
    assert.ok(await waitFor(() => relay.debugState().sseClients === 1, 20_000), 'the client joined')
    await sleep(1_000)
    assert.equal(relay.debugState().sseClients, 1, 'a client that does not read yet is not dropped')
    res.resume()
    assert.ok(await waitFor(() => cursor, 60_000), 'once it reads, the replay ends with the cursor')
    const replayed = text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as { type: string; events?: unknown[] })
    const events = replayed.reduce((n, m) => n + (m.type === 'agent-event-batch' ? m.events?.length ?? 0 : 0), 0)
    // The replay really is the largest one: the total cap is reached (and only its lifecycle reserve goes past it)
    assert.ok(events >= RELAY_MAX_REPLAY_TOTAL, `the replay holds the capped number of events (${events} of ${RELAY_MAX_REPLAY_TOTAL})`)
    // Almost every event is a message of MESSAGE_MAX characters; under the bound (UTF-16 units, as the relay counts)
    assert.ok(length > (RELAY_MAX_REPLAY_TOTAL - SESSIONS * 12) * MESSAGE_MAX, `the replay is large (${length})`)
    assert.ok(length < RELAY_MAX_PACED_BACKLOG_BYTES, `the largest replay (${length}) is under the bound (${RELAY_MAX_PACED_BACKLOG_BYTES})`)
    assert.equal(relay.debugState().sseClients, 1, 'still connected')
  })
})
