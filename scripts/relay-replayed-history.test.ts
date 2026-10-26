/**
 * Replayed history (#361): what the relay reads from a transcript when it attaches (the catch-up of the
 * current turn) was not seen live. It reaches the clients with `replayed: true`, so they never show it as
 * live; a line appended afterwards is live and carries no such flag.
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

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-replayed-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SESSION = '36136136-1361-4361-8361-361361361361'
const line = (o: unknown) => JSON.stringify(o) + '\n'
async function waitFor(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return cond()
}

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
type Ev = { type: string; replayed?: boolean; sessionId?: string; payload: Record<string, unknown> }
let relay: Relay
let server: http.Server
let port = 0
let projectDir = ''
let realWs = ''
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

/**
 * Events received, in arrival order: one by one (agent-event) and in batches (agent-event-batch), which is how a
 * history read while the client is connected reaches it (#652). The tests connect before the session is found, so
 * their own connect replay holds nothing of it.
 */
function liveEvents(text: string): Ev[] {
  const out: Ev[] = []
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data: ')) continue
    const msg = JSON.parse(block.slice(6))
    if (msg.type === 'agent-event') out.push(msg.event)
    else if (msg.type === 'agent-event-batch') out.push(...msg.events)
  }
  return out
}

describe('relay: events read from a transcript history are marked replayed', () => {
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

  it('the attach catch-up is replayed, the next appended line is live', async () => {
    const c = await connectSSE()
    const file = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(file,
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }))
    const have = () => liveEvents(c.text())
    assert.ok(await waitFor(() => have().some(e => e.type === 'message')), `the catch-up arrives live: ${have().map(e => e.type).join(',')}`)
    const catchUp = have()
    assert.ok(catchUp.length > 0)
    for (const e of catchUp) assert.equal(e.replayed, true, `${e.type} read from the history is marked replayed`)

    fs.appendFileSync(file, line({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'Build done' }] },
    }))
    assert.ok(await waitFor(() => have().length > catchUp.length), 'the appended line arrives')
    const after = have().slice(catchUp.length)
    for (const e of after) assert.equal(e.replayed, undefined, `${e.type} read from the tail is live`)
  })

  it('the sub-agent and teammate files already there at attach are history too', async () => {
    const c = await connectSSE()
    const sid = '36136136-1361-4361-8361-361361361362'
    const subDir = path.join(projectDir, sid, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-tm1.meta.json'), JSON.stringify({ taskKind: 'in_process_teammate', teamName: 'crew', name: 'scout' }))
    fs.writeFileSync(path.join(subDir, 'agent-tm1.jsonl'), line({
      type: 'assistant', timestamp: new Date(Date.now() - 40 * 60_000).toISOString(),
      message: { role: 'assistant', id: 'msg_tm', content: [{ type: 'text', text: 'Scouting the repo' }] },
    }))
    fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Start the crew' } }))
    const mine = () => liveEvents(c.text()).filter(e => e.sessionId === sid)
    const teammateSpawn = () => mine().find(e => e.type === 'agent_spawn' && e.payload.kind === 'teammate')
    assert.ok(await waitFor(() => teammateSpawn() !== undefined), `the teammate is announced: ${mine().map(e => e.type).join(',')}`)
    for (const e of mine()) assert.equal(e.replayed, true, `${e.type} (${String(e.payload.name ?? '')}) read at attach is marked replayed`)
  })
})
