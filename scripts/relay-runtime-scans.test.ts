/**
 * The scans of the other runtimes (Codex, Copilot, Pi, Gemini, OpenCode) run through a shared ticker, like the
 * Claude scan: without an SSE client no one-second interval is left running (#654). The relay is a per-process
 * singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, WATCH_SCAN_DEBOUNCE_MS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-rt-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0

// One-second intervals created and not yet cleared, whoever owns them
const liveScanIntervals = new Set<unknown>()
const realSet = global.setInterval
const realClear = global.clearInterval
const realTimeout = global.setTimeout

// The Codex watcher finds a new rollout by itself, WATCH_SCAN_DEBOUNCE_MS after its fs.watch fires. To prove what the
// scan of a CONNECTION finds, the tests hold that deferred scan back (its timer is recorded, not armed) until they have
// connected, then let it run. Only the timers of exactly that delay are held, and only while held.
let heldDeferred: (() => void)[] | null = null
function holdWatcherScans(): () => void {
  const held: (() => void)[] = []
  heldDeferred = held
  return () => { heldDeferred = null; for (const fn of held) fn() }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)) }
  return pred()
}

describe('scans of the other runtimes stop without a client (#654)', () => {
  before(async () => {
    global.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
      const t = (realSet as (...a: unknown[]) => unknown)(fn, ms, ...args)
      if (ms === SCAN_INTERVAL_MS) liveScanIntervals.add(t)
      return t
    }) as typeof setInterval
    global.clearInterval = ((t: unknown) => { liveScanIntervals.delete(t); return (realClear as (t: unknown) => void)(t) }) as typeof clearInterval
    global.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (heldDeferred && ms === WATCH_SCAN_DEBOUNCE_MS && args.length === 0) {
        heldDeferred.push(fn)
        return { ref() { return this }, unref() { return this }, hasRef() { return false }, refresh() { return this }, [Symbol.toPrimitive]() { return 0 } } as unknown as NodeJS.Timeout
      }
      return (realTimeout as (...a: unknown[]) => unknown)(fn, ms, ...args)
    }) as typeof setTimeout

    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    // A Codex session of the workspace, written just now: the relay attaches it at start
    process.env.CODEX_HOME = path.join(fakeHome, '.codex')
    const d = new Date()
    const day = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, 'rollout-2026-10-08T09-00-00-00000000-0000-4000-8000-000000000001.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: ws } }) + '\n')
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'auto' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      if (req.url?.startsWith('/status')) return void relay.handleStatus(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    global.setInterval = realSet
    global.clearInterval = realClear
    global.setTimeout = realTimeout
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('no one-second scan interval runs in auto mode while nobody is connected', () => {
    assert.equal(liveScanIntervals.size, 0, 'neither the Claude scan nor the other runtimes')
    assert.equal(relay.debugState().runtimeScanTimerActive, false)
  })

  it('a client starts the shared runtime scan, the last one leaving stops it', async () => {
    const a = http.get({ host: '127.0.0.1', port, path: '/events', agent: false })
    const b = http.get({ host: '127.0.0.1', port, path: '/events', agent: false })
    a.on('error', () => {}); b.on('error', () => {})
    assert.ok(await waitFor(() => relay.debugState().sseClients === 2))
    assert.equal(relay.debugState().runtimeScanTimerActive, true)
    assert.equal(liveScanIntervals.size, 2, 'the Claude scan and ONE shared scan for the five other runtimes')

    a.destroy()
    assert.ok(await waitFor(() => relay.debugState().sseClients === 1))
    assert.equal(relay.debugState().runtimeScanTimerActive, true, 'still one client')

    b.destroy()
    assert.ok(await waitFor(() => relay.debugState().sseClients === 0))
    assert.equal(relay.debugState().runtimeScanTimerActive, false)
    assert.equal(liveScanIntervals.size, 0)
  })

  it('a session silent past ACTIVE_SESSION_AGE_S is released with no client connected (#654)', async () => {
    const count = async (): Promise<number> => {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/status', agent: false }, res => {
          let b = ''; res.on('data', c => { b += c }); res.on('end', () => resolve(b))
        }).on('error', reject)
      })
      return (JSON.parse(body) as { sessionCount: number }).sessionCount
    }
    assert.equal(relay.debugState().sseClients, 0)
    assert.equal(await count(), 1, 'attached at start')
    mock.timers.enable({ apis: ['Date'], now: Date.now() + (ACTIVE_SESSION_AGE_S + 60) * 1000 })
    try {
      assert.equal(await count(), 0, 'released: no scan ran, no client was there')
    } finally { mock.timers.reset() }
  })

  const ROLLOUT_B = '00000000-0000-4000-8000-000000000002'
  const rolloutDir = () => {
    const d = new Date()
    return path.join(process.env.CODEX_HOME!, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  }
  const rolloutLine = (o: unknown) => JSON.stringify(o) + '\n'
  type Msg = { type: string; sessions?: Array<{ id: string; lastActivityTime: number }>; events?: Array<{ sessionId?: string; type: string }>; event?: { sessionId?: string; type: string } }
  /** Connects, resolves once `until` holds for the messages received (or after `ms`), then disconnects */
  async function connect(until: (msgs: Msg[]) => boolean, ms = 3000): Promise<Msg[]> {
    let text = ''
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.setEncoding('utf8'); res.on('data', c => { text += c }) })
    req.on('error', () => {})
    const read = () => text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Msg)
    await waitFor(() => until(read()), ms)
    req.destroy()
    return read()
  }

  const statusSessionCount = async (): Promise<number> => {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/status', agent: false }, res => {
        let b = ''; res.on('data', c => { b += c }); res.on('end', () => resolve(b))
      }).on('error', reject)
    })
    return (JSON.parse(body) as { sessionCount: number }).sessionCount
  }
  // Real wait, past the window in which a connection reuses the scan that just ran
  const pastScanWindow = () => new Promise(r => (realTimeout as typeof setTimeout)(r, WATCH_SCAN_DEBOUNCE_MS + 50))

  it('a session written while nobody was connected is announced to the next client, and its events reach it once (#682)', async () => {
    const ws = path.join(fakeHome, 'my-workspace')
    const release = holdWatcherScans()
    try {
      fs.writeFileSync(path.join(rolloutDir(), `rollout-2026-10-08T09-00-00-${ROLLOUT_B}.jsonl`),
        rolloutLine({ type: 'session_meta', payload: { cwd: ws } })
        + rolloutLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello from B' }] } }))
      assert.equal(relay.debugState().sseClients, 0)
      await pastScanWindow()
      // The watcher's own scan is held back: only the scan of the connection can find it
      const msgs = await connect(m => m.some(x => x.type === 'session-list' && x.sessions?.some(s => s.id === ROLLOUT_B)))
      const listed = msgs.filter(m => m.type === 'session-list' && m.sessions?.some(s => s.id === ROLLOUT_B))
      assert.equal(listed.length, 1, 'the scan of the connection found it before the client joined: it is in the list')
      const events = msgs.flatMap(m => m.type === 'agent-event-batch' ? (m.events ?? []) : m.type === 'agent-event' && m.event ? [m.event] : [])
        .filter(e => e.sessionId === ROLLOUT_B)
      const spawns = events.filter(e => e.type === 'agent_spawn')
      assert.equal(spawns.length, 1, `its spawn is delivered once (${spawns.length}): not live and again from the replay`)
    } finally { release() }
  })

  it('a session written again after the gap that released it is listed with its new activity time (#682)', async () => {
    const A = '00000000-0000-4000-8000-000000000001'
    const file = path.join(rolloutDir(), `rollout-2026-10-08T09-00-00-${A}.jsonl`)
    await pastScanWindow()
    const release = holdWatcherScans()
    try {
      // Let the session go for real first (nobody connected, a gap past ACTIVE_SESSION_AGE_S, as in the test above)
      mock.timers.enable({ apis: ['Date'], now: Date.now() + (ACTIVE_SESSION_AGE_S + 60) * 1000 })
      try { await statusSessionCount() } finally { mock.timers.reset() }
      assert.equal(await statusSessionCount(), 0, 'precondition: no session is followed, the watcher cannot update the time itself')
      const wrote = Date.now()
      fs.appendFileSync(file, rolloutLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Back again' }] } }))
      await pastScanWindow()
      const msgs = await connect(m => m.some(x => x.type === 'session-list' && x.sessions?.some(s => s.id === A)))
      const entry = msgs.find(m => m.type === 'session-list')?.sessions?.find(s => s.id === A)
      assert.ok(entry, 'the released session is back in the list')
      assert.ok(entry.lastActivityTime >= wrote - 1000, `its activity time is the new write, not the one from before the gap (${entry.lastActivityTime} vs ${wrote})`)
    } finally { release() }
  })

  it('a burst of connections costs exactly one scan of the other runtimes, not one per connection and not none (#682)', async () => {
    await pastScanWindow()
    const before = relay.debugState().runtimeScanRuns
    const reqs = Array.from({ length: 8 }, () => http.get({ host: '127.0.0.1', port, path: '/events', agent: false }))
    for (const r of reqs) r.on('error', () => {})
    assert.ok(await waitFor(() => relay.debugState().sseClients === 8))
    for (const r of reqs) r.destroy()
    assert.ok(await waitFor(() => relay.debugState().sseClients === 0))
    assert.equal(relay.debugState().runtimeScanRuns - before, 1, `8 connections made ${relay.debugState().runtimeScanRuns - before} scans`)
  })
})
