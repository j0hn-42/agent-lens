/**
 * Hook server resource-exhaustion / untrusted-input tests. Real HTTP over
 * 127.0.0.1 on an ephemeral port; nothing leaves the machine.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { HOOK_RATE_IP_BURST, HOOK_MAX_SESSIONS, HOOK_MAX_TRACKED_PER_SESSION, HTTP_CONNECTIONS_CHECK_INTERVAL_MS, TEAM_MAX_LINKS_PER_SESSION } from '../src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hook-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

type HookServerCtor = typeof import('../src/hook-server').HookServer
let HookServer: HookServerCtor

interface Reply { status: number; body: string }

function request(port: number, opts: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.body
    const req = http.request({
      host: '127.0.0.1', port, method: opts.method ?? 'POST', path: '/',
      agent: false,
      headers: { 'Content-Type': 'application/json', ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...opts.headers },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const post = (port: number, payload: unknown, headers?: http.OutgoingHttpHeaders) =>
  request(port, { body: JSON.stringify(payload), headers })

async function startServer() {
  const server = new HookServer()
  const port = await server.start()
  const events: Array<{ type: string; payload: Record<string, unknown>; sessionId?: string }> = []
  server.onEvent(e => events.push(e as never))
  return { server, port, events }
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
}

describe('HookServer hardening', () => {
  before(async () => { ({ HookServer } = await import('../src/hook-server')) })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('binds to loopback only', async () => {
    const { server, port } = await startServer()
    try {
      const addr = (server as unknown as { server: http.Server }).server.address() as { address: string }
      assert.equal(addr.address, '127.0.0.1')
      assert.ok(port > 0)
    } finally { server.dispose() }
  })

  it('accepts a valid hook and emits an event', async () => {
    const { server, port, events } = await startServer()
    try {
      const r = await post(port, { session_id: 's1', hook_event_name: 'SessionStart' })
      assert.equal(r.status, 200)
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'agent_spawn')
    } finally { server.dispose() }
  })

  it('rejects invalid JSON with 400', async () => {
    const { server, port, events } = await startServer()
    try {
      const r = await request(port, { body: '{not json' })
      assert.equal(r.status, 400)
      assert.equal(events.length, 0)
    } finally { server.dispose() }
  })

  it('rejects non-JSON content types with 415', async () => {
    const { server, port } = await startServer()
    try {
      const r = await request(port, { body: '{"session_id":"a","hook_event_name":"Stop"}', headers: { 'Content-Type': 'text/plain' } })
      assert.equal(r.status, 415)
    } finally { server.dispose() }
  })

  it('rejects an oversized declared body with 413', async () => {
    const { server, port, events } = await startServer()
    try {
      const big = Buffer.alloc(1024 * 1024 + 1, 0x20)
      const r = await request(port, { body: big }).catch(e => ({ status: -1, body: String(e) }))
      // Either the 413 arrived, or the server already destroyed the socket mid-upload
      assert.ok(r.status === 413 || r.status === -1, `status ${r.status}`)
      assert.equal(events.length, 0)
      // The server must stay healthy after rejecting the body
      assert.equal((await post(port, { session_id: 'after-big', hook_event_name: 'SessionStart' })).status, 200)
    } finally { server.dispose() }
  })

  it('rejects an oversized chunked body (no Content-Length) and destroys the socket', async () => {
    const { server, port, events } = await startServer()
    try {
      const outcome = await new Promise<string>(resolve => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST', agent: false,
          headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        }, res => { resolve(`status ${res.statusCode}`); res.resume() })
        req.on('error', () => resolve('closed'))
        const chunk = Buffer.alloc(256 * 1024, 0x20)
        for (let i = 0; i < 8; i++) req.write(chunk)
        req.end()
      })
      assert.ok(outcome === 'status 413' || outcome === 'closed', outcome)
      assert.equal(events.length, 0)
    } finally { server.dispose() }
  })

  it('rejects cross-site browser requests (Origin) and foreign Host headers with 403', async () => {
    const { server, port, events } = await startServer()
    try {
      const ok = { session_id: 's1', hook_event_name: 'SessionStart' }
      assert.equal((await post(port, ok, { Origin: 'https://evil.example' })).status, 403)
      assert.equal((await post(port, ok, { Host: 'evil.example' })).status, 403)
      assert.equal(events.length, 0)
      assert.equal((await post(port, ok, { Host: `localhost:${port}` })).status, 200)
    } finally { server.dispose() }
  })

  it('validates identifier fields (type, length, charset) with 400', async () => {
    const { server, port, events } = await startServer()
    try {
      const base = { hook_event_name: 'PreToolUse', session_id: 's1' }
      for (const bad of [
        { ...base, session_id: 42 },
        { ...base, session_id: 'x'.repeat(129) },
        { ...base, session_id: '../../etc/passwd' },
        { ...base, agent_id: 'x'.repeat(65) },
        { ...base, agent_type: { a: 1 } },
        { ...base, tool_input: 'nope' },
      ]) {
        assert.equal((await post(port, bad)).status, 400, JSON.stringify(bad).slice(0, 80))
      }
      assert.equal(events.length, 0)
    } finally { server.dispose() }
  })

  it('rate-limits a session flood with 429 (token bucket) while other sessions still pass', async () => {
    const { server, port } = await startServer()
    try {
      const statuses: number[] = []
      for (let i = 0; i < 130; i++) statuses.push((await post(port, { session_id: 'flood', hook_event_name: 'Stop' })).status)
      assert.ok(statuses.includes(429), 'expected a 429')
      assert.equal(statuses[0], 200)
      assert.equal((await post(port, { session_id: 'other', hook_event_name: 'Stop' })).status, 200)
    } finally { server.dispose() }
  })

  it('rate-limits per client address with 429', async (t) => {
    // The token bucket refills with elapsed time, so a flood only gets a 429 when the machine is fast
    // enough to outrun the refill (it failed under CPU load). Freeze the clock: no refill at all, so the
    // outcome depends only on the burst: the HOOK_RATE_IP_BURST-th request passes, the next is refused.
    const frozen = Date.now()
    t.mock.method(Date, 'now', () => frozen)
    const { server, port } = await startServer()
    try {
      const statuses: number[] = []
      for (let i = 0; i <= HOOK_RATE_IP_BURST; i++) {
        statuses.push((await post(port, { session_id: `s${i}`, hook_event_name: 'Stop' })).status)
      }
      assert.equal(statuses[HOOK_RATE_IP_BURST - 1], 200, 'the request at the burst limit is served')
      assert.equal(statuses[HOOK_RATE_IP_BURST], 429, 'the next one is refused')
      assert.ok(statuses.slice(0, HOOK_RATE_IP_BURST).every(s => s === 200), 'everything under the limit is served')
    } finally { server.dispose() }
  })

  it('SubagentStop reads only the tail of an allow-listed transcript, asynchronously', async () => {
    const dir = path.join(fakeHome, '.claude', 'projects', 'proj')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'agent-1.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } }) + '\n'
    fs.writeFileSync(file, filler.repeat(4000) + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final report' }] } }) + '\n')
    const { server, port, events } = await startServer()
    try {
      const r = await post(port, { session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: file })
      assert.equal(r.status, 200)
      await waitFor(() => events.some(e => e.type === 'subagent_return'))
      assert.equal(events.find(e => e.type === 'subagent_return')?.payload.summary, 'final report')
    } finally { server.dispose() }
  })

  it('SubagentStop ignores transcript paths outside the allowed root', async () => {
    const outside = path.join(os.tmpdir(), `af-outside-${process.pid}.jsonl`)
    fs.writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'secret' } }) + '\n')
    const { server, port, events } = await startServer()
    try {
      await post(port, { session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'x', agent_transcript_path: outside, last_assistant_message: 'from payload' })
      await waitFor(() => events.some(e => e.type === 'subagent_return'))
      assert.equal(events.find(e => e.type === 'subagent_return')?.payload.summary, 'from payload')
    } finally { server.dispose(); fs.rmSync(outside, { force: true }) }
  })

  it('a flood of SubagentStop hooks keeps the event loop responsive', async () => {
    const dir = path.join(fakeHome, '.claude', 'projects', 'proj')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'agent-flood.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } }) + '\n'
    fs.writeFileSync(file, filler.repeat(2000) + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'flood report' }] } }) + '\n')
    const { server, port, events } = await startServer()
    try {
      let maxGap = 0
      let last = Date.now()
      const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n }, 5)
      await Promise.all(Array.from({ length: 60 }, (_, i) =>
        post(port, { session_id: `f${i % 3}`, hook_event_name: 'SubagentStop', agent_id: `a${i}`, agent_type: 'x', agent_transcript_path: file }).catch(() => undefined)))
      clearInterval(timer)
      assert.ok(maxGap < 500, `event loop stalled ${maxGap}ms`)
      // The transcript path was really exercised: at least one report came from the tail read
      await waitFor(() => events.some(e => e.type === 'subagent_return' && e.payload.summary === 'flood report'))
      assert.ok(events.some(e => e.type === 'subagent_return' && e.payload.summary === 'flood report'))
    } finally { server.dispose() }
  })

  it('bounds per-session tracked state: sessions evict LRU at HOOK_MAX_SESSIONS', async () => {
    const { server } = await startServer()
    try {
      const internal = server as unknown as {
        sessionState: Map<string, unknown>
        getOrCreateSession(id: string): unknown
      }
      internal.getOrCreateSession('keep-me')
      for (let i = 0; i < HOOK_MAX_SESSIONS + 50; i++) {
        internal.getOrCreateSession(`bound-${i}`)
        internal.getOrCreateSession('keep-me') // still active: must survive eviction
      }
      assert.equal(internal.sessionState.size, HOOK_MAX_SESSIONS)
      assert.ok(internal.sessionState.has('keep-me'), 'active session was evicted')
      assert.ok(!internal.sessionState.has('bound-0'), 'oldest idle session should be evicted')
      assert.ok(internal.sessionState.has(`bound-${HOOK_MAX_SESSIONS + 49}`))
    } finally { server.dispose() }
  })

  it('bounds per-session agentNames / dispatches / links at HOOK_MAX_TRACKED_PER_SESSION', async () => {
    const { server, port } = await startServer()
    try {
      // PreToolUse(Agent) registers a dispatch; spread over sessions to stay under the rate limit
      const sid = 'tracked'
      for (let i = 0; i < 90; i++) {
        await post(port, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `t${i}`, tool_input: { description: `d${i}`, prompt: 'p' } })
      }
      const internal = server as unknown as { sessionState: Map<string, { dispatches: Map<string, unknown> }> }
      assert.equal(internal.sessionState.get(sid)?.dispatches.size, 90)
      // Direct fill past the bound
      const state = (server as unknown as { getOrCreateSession(id: string): { dispatches: Map<string, unknown>; agentNames: Map<string, string> } }).getOrCreateSession(sid)
      const setBounded = (server as unknown as { setBounded<K, V>(m: Map<K, V>, k: K, v: V): void }).setBounded.bind(server)
      for (let i = 0; i < HOOK_MAX_TRACKED_PER_SESSION + 40; i++) setBounded(state.agentNames, `a${i}`, `n${i}`)
      assert.equal(state.agentNames.size, HOOK_MAX_TRACKED_PER_SESSION)
      assert.ok(!state.agentNames.has('a0'))
    } finally { server.dispose() }
  })

  it('emits agent_link + message_sent once per link for SendMessage (hooks)', async () => {
    const { server, port, events } = await startServer()
    try {
      const send = (id: string, msg: string) => post(port, {
        session_id: 'team', hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_use_id: id,
        tool_input: { to: 'researcher', message: msg },
      })
      await send('tu1', 'hello\u0007 there')
      await send('tu2', 'again')
      assert.equal(events.filter(e => e.type === 'agent_link').length, 1)
      const sent = events.filter(e => e.type === 'message_sent')
      assert.equal(sent.length, 2)
      assert.equal(sent[0].payload.content, 'hello there')
      assert.equal(sent[0].payload.to, 'researcher')
      assert.equal(sent[0].payload.toolUseId, 'tu1')
    } finally { server.dispose() }
  })

  it('a full link set evicts its oldest entry so a new edge is still announced', async () => {
    const { server, port, events } = await startServer()
    try {
      const state = (server as unknown as { getOrCreateSession(id: string): { links: Set<string> } }).getOrCreateSession('full')
      for (let i = 0; i < TEAM_MAX_LINKS_PER_SESSION; i++) state.links.add(`old-${i}`)
      await post(port, {
        session_id: 'full', hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_use_id: 'tuN',
        tool_input: { to: 'newcomer', message: 'hi' },
      })
      assert.equal(events.filter(e => e.type === 'agent_link').length, 1)
      assert.equal(state.links.size, TEAM_MAX_LINKS_PER_SESSION)
      assert.ok(!state.links.has('old-0'))
    } finally { server.dispose() }
  })

  it('applies a short connection sweep interval (slowloris window)', async () => {
    const { server } = await startServer()
    try {
      const raw = (server as unknown as { server: { connectionsCheckingInterval?: number } }).server
      assert.equal(raw.connectionsCheckingInterval, HTTP_CONNECTIONS_CHECK_INTERVAL_MS)
    } finally { server.dispose() }
  })
})
