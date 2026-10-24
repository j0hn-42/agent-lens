/**
 * The paced backlog bound (RELAY_MAX_PACED_BACKLOG_BYTES, 32 MiB counted in UTF-16 units, #613): it also limits the
 * connect replay, so a replay at its own caps must stay under it, or a healthy client would be ejected at every
 * connection, in a loop. The biggest replay a real transcript can give: RELAY_MAX_REPLAY_TOTAL events of messages cut at
 * MESSAGE_MAX characters. Own file: the relay is a singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'
import {
  RELAY_MAX_REPLAY_PER_SESSION, RELAY_MAX_REPLAY_TOTAL, RELAY_MAX_PACED_BACKLOG_BYTES, MESSAGE_MAX,
} from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-paced-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSIONS = Math.ceil(RELAY_MAX_REPLAY_TOTAL / RELAY_MAX_REPLAY_PER_SESSION)
const sessionId = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
let realWsPath = ''
const text = 'x'.repeat(MESSAGE_MAX * 2) // longer than the cut: every message reaches MESSAGE_MAX
const line = (i: number, s: number) => JSON.stringify({
  type: 'user', cwd: realWsPath, timestamp: new Date().toISOString(), uuid: `u-${s}-${i}`, message: { role: 'user', content: `${i} ${text}` },
}) + '\n'
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 50)) }
  return pred()
}

describe('relay: a replay at its caps stays under the paced backlog bound (#613)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    realWsPath = realWs
    // One line each: the sessions are attached at start, the bulk is read live (an attach reads only the current turn)
    for (let s = 0; s < SESSIONS; s++) fs.writeFileSync(path.join(projectDir, `${sessionId(s)}.jsonl`), line(0, s))
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
    assert.ok(await waitFor(() => relay.debugState().watchedSessions === SESSIONS, 10_000), 'precondition: the sessions are watched')
    for (let i = 1; i < RELAY_MAX_REPLAY_PER_SESSION + 400; i += 100) {
      for (let s = 0; s < SESSIONS; s++) {
        let chunk = ''
        for (let j = i; j < Math.min(i + 100, RELAY_MAX_REPLAY_PER_SESSION + 400); j++) chunk += line(j, s)
        fs.appendFileSync(path.join(projectDir, `${sessionId(s)}.jsonl`), chunk)
      }
      await new Promise(r => setTimeout(r, 60))
    }
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('the biggest replay (total cap, messages at MESSAGE_MAX) is written in full and ends with the cursor', async () => {
    const connect = () => new Promise<{ events: number; chars: number; cursor: boolean; ended: boolean }>((resolve, reject) => {
      let events = 0, chars = 0, pending = '', cursor = false, ended = false
      const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          chars += chunk.length
          const blocks = (pending + chunk).split('\n\n')
          pending = blocks.pop() ?? ''
          for (const b of blocks) {
            if (!b.startsWith('data: ')) continue
            const m = JSON.parse(b.slice(6))
            if (m.type === 'agent-event-batch') events += m.events.length
            if (m.type === 'relay-cursor') { cursor = true; req.destroy(); resolve({ events, chars, cursor, ended }) }
          }
        })
        res.on('end', () => { ended = true })
      })
      req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
      setTimeout(() => { req.destroy(); resolve({ events, chars, cursor, ended }) }, 60_000).unref()
    })
    // The relay reads the appended lines on its own pace: connect again until the buffers hold the total cap
    let got = await connect()
    for (let i = 0; i < 40 && got.events < RELAY_MAX_REPLAY_TOTAL; i++) { await new Promise(r => setTimeout(r, 500)); got = await connect() }
    assert.equal(got.cursor, true, `the replay reached its end (client kept: ${!got.ended}, ${got.events} events, ${got.chars} characters)`)
    assert.ok(got.events >= RELAY_MAX_REPLAY_TOTAL, `the replay is at its total cap (${got.events})`)
    assert.ok(got.chars > RELAY_MAX_REPLAY_TOTAL * MESSAGE_MAX, 'the messages are at their full length')
    assert.ok(got.chars < RELAY_MAX_PACED_BACKLOG_BYTES, `and still under the bound (${got.chars} < ${RELAY_MAX_PACED_BACKLOG_BYTES})`)
  })
})
