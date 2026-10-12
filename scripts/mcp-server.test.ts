/**
 * MCP server "agent-lens" (#235): exposes the relay's bounded, read-only observations to Claude as MCP tools.
 * Protocol (JSON-RPC over stdio lines), strict inputs, loopback-only relay URL, bounded HTTP reads, and a
 * whitelist re-projection of every relay answer: an unexpected value fails the call instead of reaching Claude.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import {
  createMcpServer, runStdio, parseRelayUrl, createRelayGet, projectObservations, projectSessionWork,
  MCP_LINE_MAX, RELAY_BODY_MAX, type RelayGet,
} from './mcp/server'

const SESSION = '55555555-5555-4555-8555-555555555555'

const obsSession = (extra: Record<string, unknown> = {}) => ({
  id: SESSION, runtime: 'claude', status: 'active', startedAt: 1000, lastActivityAt: 2000, ageMs: 10,
  freshness: 'fresh', agentCount: 1, agents: [{ name: 'explorer', state: 'idle' }], ...extra,
})
const obs = (sessions: unknown[] = [obsSession()], extra: Record<string, unknown> = {}) => ({
  schema: 1, generatedAt: 3000, sessions, truncated: false, omittedSessions: 0, ...extra,
})
const REPO = 'https://github.com/j0hn-42/agent-lens'
const work = (extra: Record<string, unknown> = {}) => ({
  scope: 'session', session: SESSION, repo: REPO,
  prs: [{ number: 7, title: 'feat: x', url: `${REPO}/pull/7`, branch: 'feat/x', checks: { state: 'passing', total: 2, failing: 0, pending: 0 } }],
  issues: [{ number: 9, title: 'bug', url: `${REPO}/issues/9` }],
  prsTruncated: false, issuesTruncated: true, ...extra,
})

/** A fake relay: records the requested paths and answers from a table. */
function fakeGet(answers: Record<string, { status: number; body: unknown }>): RelayGet & { calls: string[] } {
  const calls: string[] = []
  const get = (async (p: string) => {
    calls.push(p)
    const a = answers[p.split('?')[0]] ?? answers[p]
    if (!a) throw new Error('relay unreachable')
    return a
  }) as RelayGet & { calls: string[] }
  get.calls = calls
  return get
}

async function rpc(server: ReturnType<typeof createMcpServer>, msg: unknown): Promise<any> {
  const out = await server.handle(typeof msg === 'string' ? msg : JSON.stringify(msg))
  return out === null ? null : JSON.parse(out)
}
const call = (server: ReturnType<typeof createMcpServer>, name: string, args?: unknown, id = 1) =>
  rpc(server, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

describe('MCP protocol', () => {
  const server = createMcpServer(fakeGet({}))

  it('initializes with the tools capability and echoes a supported protocol version', async () => {
    const r = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    assert.equal(r.id, 1)
    assert.equal(r.result.protocolVersion, '2025-03-26')
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } })
    assert.equal(r.result.serverInfo.name, 'agent-lens')
    const unknown = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    assert.equal(unknown.result.protocolVersion, '2025-06-18')
  })

  it('answers no response to notifications and {} to ping', async () => {
    assert.equal(await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }), null)
    assert.deepEqual((await rpc(server, { jsonrpc: '2.0', id: 'p', method: 'ping' })).result, {})
  })

  it('lists exactly the read-only tools, with strict JSON Schemas', async () => {
    const r = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = r.result.tools.map((t: { name: string }) => t.name)
    assert.deepEqual(names, ['observations', 'session_work'])
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, 'object')
      assert.equal(t.inputSchema.additionalProperties, false)
      assert.equal(t.outputSchema.type, 'object')
      assert.equal(t.annotations.readOnlyHint, true)
      assert.equal(t.annotations.openWorldHint, t.name === 'session_work')
      assert.ok(t.description.length > 40)
    }
    // No cost tool: the relay has no bounded endpoint that proves a cost
    assert.ok(!names.some((n: string) => /cost/i.test(n)))
  })

  it('maps protocol errors to JSON-RPC codes', async () => {
    assert.equal((await rpc(server, '{not json')).error.code, -32700)
    assert.equal((await rpc(server, '{not json')).id, null)
    assert.equal((await rpc(server, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).error.code, -32601)
    assert.equal((await rpc(server, { id: 1, method: 'ping' })).error.code, -32600)
    assert.equal((await rpc(server, [1, 2])).error.code, -32600)
    assert.equal((await rpc(server, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })).error.code, -32600)
    assert.equal((await call(server, 'write_files', {})).error.code, -32602)
  })
})

describe('tool inputs are strict', () => {
  const get = fakeGet({ '/observations': { status: 200, body: obs() } })
  const server = createMcpServer(get)

  it('refuses unknown keys, wrong types and bad session ids without calling the relay', async () => {
    for (const args of [{ x: 1 }, { session: 5 }, { session: '../etc' }, { includeAgents: 'yes' }, [1]]) {
      const r = await call(server, 'observations', args)
      assert.equal(r.result.isError, true, JSON.stringify(args))
    }
    for (const args of [{}, { session: 'a b' }, { session: SESSION, x: 1 }]) {
      assert.equal((await call(server, 'session_work', args)).result.isError, true, JSON.stringify(args))
    }
    assert.equal(get.calls.length, 0)
  })

  it('passes the input to the relay as its query', async () => {
    await call(server, 'observations', {})
    await call(server, 'observations', { session: SESSION, includeAgents: false })
    assert.deepEqual(get.calls, ['/observations', `/observations?session=${SESSION}&agents=0`])
  })
})

describe('observations tool', () => {
  it('returns the projected observations as structured content and as JSON text', async () => {
    const server = createMcpServer(fakeGet({ '/observations': { status: 200, body: obs() } }))
    const r = await call(server, 'observations', {})
    assert.equal(r.result.isError, false)
    assert.deepEqual(r.result.structuredContent, obs())
    assert.deepEqual(JSON.parse(r.result.content[0].text), obs())
  })

  it('turns a relay failure into an explicit tool error, never an empty list', async () => {
    const cases: Array<[number, RegExp]> = [[429, /rate/i], [503, /shut down|unavailable/i], [500, /relay/i], [403, /refused/i]]
    for (const [status, re] of cases) {
      const server = createMcpServer(fakeGet({ '/observations': { status, body: { error: 'x' } } }))
      const r = await call(server, 'observations', {})
      assert.equal(r.result.isError, true)
      assert.equal(r.result.structuredContent, undefined)
      assert.match(r.result.content[0].text, re)
    }
    const down = await call(createMcpServer(fakeGet({})), 'observations', {})
    assert.equal(down.result.isError, true)
    assert.match(down.result.content[0].text, /not reachable|is Agent Lens running/i)
  })

  it('refuses an answer that does not match the whitelist', async () => {
    const bad = [
      obs([obsSession({ freshness: 'running' })]),
      obs([obsSession({ ageMs: -1 })]),
      obs([obsSession({ agents: [{ name: 'a', state: 'stuck' }] })]),
      obs([obsSession({ id: '../x' })]),
      obs(Array.from({ length: 26 }, () => obsSession())),
      obs([], { schema: 2 }),
      obs([], { truncated: 'no' }),
      { sessions: [] },
      'text',
    ]
    for (const body of bad) {
      const r = await call(createMcpServer(fakeGet({ '/observations': { status: 200, body } })), 'observations', {})
      assert.equal(r.result.isError, true, JSON.stringify(body).slice(0, 80))
      assert.match(r.result.content[0].text, /unexpected/i)
    }
  })

  it('drops fields outside the whitelist and keeps the honesty flags', () => {
    const out = projectObservations(obs([obsSession({ label: 'TOPSECRET prompt', cwd: '/home/me', agentsIncomplete: true, agentsTruncated: true, provenance: 'imported' })], { truncated: true, omittedSessions: 2, extra: 1 }))
    assert.ok(out)
    const text = JSON.stringify(out)
    assert.ok(!text.includes('TOPSECRET') && !text.includes('/home/me') && !text.includes('extra'))
    assert.equal(out.truncated, true)
    assert.equal(out.omittedSessions, 2)
    assert.equal(out.sessions[0].agentsIncomplete, true)
    assert.equal(out.sessions[0].agentsTruncated, true)
    assert.equal(out.sessions[0].provenance, 'imported')
  })

  it('cleans agent names again (control characters, paths, length)', () => {
    const out = projectObservations(obs([obsSession({ agents: [{ name: 'a\u0007b', state: 'active' }, { name: '/home/me/x', state: 'complete' }] })]))
    assert.deepEqual(out?.sessions[0].agents, [{ name: 'a b', state: 'active' }, { name: 'agent', state: 'complete' }])
    assert.equal(projectObservations(obs([obsSession({ agents: [{ name: 'x'.repeat(65), state: 'active' }] })])), null)
  })
})

describe('session_work tool', () => {
  it('asks the relay for the work of the session and projects it', async () => {
    const get = fakeGet({ '/issue-links': { status: 200, body: work() } })
    const r = await call(createMcpServer(get), 'session_work', { session: SESSION })
    assert.deepEqual(get.calls, [`/issue-links?scope=session&session=${SESSION}`])
    assert.equal(r.result.isError, false)
    assert.equal(r.result.structuredContent.repo, REPO)
    assert.equal(r.result.structuredContent.prs[0].checks.state, 'passing')
    assert.equal(r.result.structuredContent.issuesTruncated, true)
    assert.equal(r.result.structuredContent.session, SESSION)
  })

  it('says why there is no answer: unknown project, gh unavailable, busy', async () => {
    const cases: Array<[number, RegExp]> = [[404, /unknown project/i], [502, /unavailable/i], [503, /busy/i]]
    for (const [status, re] of cases) {
      const r = await call(createMcpServer(fakeGet({ '/issue-links': { status, body: 'x' } })), 'session_work', { session: SESSION })
      assert.equal(r.result.isError, true)
      assert.match(r.result.content[0].text, re)
    }
  })

  it('keeps only URLs of the repository itself and refuses a malformed answer', () => {
    assert.equal(projectSessionWork(work({ prs: [{ number: 7, title: 't', url: 'https://evil.example/pull/7', branch: 'b', checks: { state: 'passing', total: 1, failing: 0, pending: 0 } }] })), null)
    assert.equal(projectSessionWork(work({ issues: [{ number: 9, title: 't', url: `${REPO}/issues/10` }] })), null)
    assert.equal(projectSessionWork(work({ repo: 'https://gitlab.com/a/b' })), null)
    assert.equal(projectSessionWork(work({ prs: [{ number: 7, title: 't', url: `${REPO}/pull/7`, branch: 'b', checks: { state: 'green', total: 1, failing: 0, pending: 0 } }] })), null)
    assert.equal(projectSessionWork(work({ prsTruncated: 'maybe' })), null)
    // No GitHub origin is a fact: an empty answer with repo null
    assert.deepEqual(projectSessionWork(work({ repo: null, prs: [], issues: [], issuesTruncated: false })), {
      session: SESSION, repo: null, prs: [], issues: [], prsTruncated: false, issuesTruncated: false,
    })
    assert.equal(projectSessionWork(work({ repo: null })), null, 'links without a repository prove nothing')
  })

  it('strips control characters from the GitHub titles and caps them', () => {
    const out = projectSessionWork(work({ issues: [{ number: 9, title: 'a\u001b[31mb' + 'x'.repeat(300), url: `${REPO}/issues/9` }] }))
    assert.ok(out)
    assert.ok(!/[\u0000-\u001f]/.test(out.issues[0].title))
    assert.ok(out.issues[0].title.length <= 200)
  })
})

describe('relay URL', () => {
  it('accepts http loopback only', () => {
    const d = parseRelayUrl(undefined)
    if (!d.ok) throw new Error(d.error)
    assert.equal(d.url.href, 'http://127.0.0.1:3001/')
    assert.ok(parseRelayUrl('').ok)
    for (const u of ['http://127.0.0.1:4000', 'http://localhost:3001/', 'http://[::1]:3001']) assert.ok(parseRelayUrl(u).ok, u)
    for (const u of ['https://127.0.0.1:3001', 'http://example.com', 'http://10.0.0.1:3001', 'http://user:pw@127.0.0.1:3001', 'http://127.0.0.1:3001/x', 'file:///etc/passwd', 'nope']) {
      assert.equal(parseRelayUrl(u).ok, false, u)
    }
  })
})

describe('relay HTTP client', () => {
  let server: http.Server
  let base: URL
  const seen: Array<{ url?: string; method?: string; host?: string }> = []

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, host: req.headers.host })
      if (req.url === '/observations') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obs())); return }
      if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('"' + 'x'.repeat(RELAY_BODY_MAX) + '"'); return }
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); return }
      if (req.url === '/text') { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Issue links unavailable'); return }
      if (req.url === '/slow') return // never answers
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  })
  after(() => { server.closeAllConnections(); server.close() })

  it('GETs JSON from the relay', async () => {
    const r = await createRelayGet(base)('/observations')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, obs())
    assert.equal(seen.at(-1)?.method, 'GET')
  })

  it('refuses a body over the cap, does not follow redirects, keeps non-JSON errors', async () => {
    await assert.rejects(createRelayGet(base)('/big'), /too large/)
    assert.equal((await createRelayGet(base)('/redirect')).status, 302)
    const t = await createRelayGet(base)('/text')
    assert.equal(t.status, 502)
    assert.equal(t.body, undefined)
  })

  it('times out', async () => {
    await assert.rejects(createRelayGet(base, { timeoutMs: 100 })('/slow'), /timed out/)
  })
})

describe('stdio transport', () => {
  it('answers one line per request and ignores an over-long line with -32600', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', c => { text += c })
    const done = runStdio(createMcpServer(fakeGet({})), input, output)
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n')
    input.write('x'.repeat(MCP_LINE_MAX + 10))
    input.write('\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n')
    input.end()
    await done
    const lines = text.trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => l.id), [1, null, 2])
    assert.equal(lines[1].error.code, -32600)
  })
})

describe('end to end against a real relay', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-home-'))
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let base: URL
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }

  before(async () => {
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.AGENT_LENS_ALL_WORKSPACES
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'work', 'private-project')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const now = Date.now()
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      JSON.stringify({ type: 'user', cwd: realWs, timestamp: new Date(now - 2000).toISOString(), message: { role: 'user', content: 'TOPSECRET prompt' } }) + '\n')
    relay = await createRelay({ workspace: realWs, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/observations')) return relay.handleObservations(req, res)
      if (req.url === '/events') return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    // Connecting to /events triggers the session scan
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: base.port, path: '/events', agent: false }, res => {
        res.resume()
        setTimeout(() => { req.destroy(); resolve() }, 600)
      })
      req.on('error', reject)
    })
  })
  after(async () => {
    relay?.dispose?.()
    server?.closeAllConnections()
    server?.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('reads the watched session through the MCP tool, without prompt or path', async () => {
    const mcp = createMcpServer(createRelayGet(base))
    const r = await call(mcp, 'observations', { session: SESSION })
    assert.equal(r.result.isError, false, r.result.content[0].text)
    const s = r.result.structuredContent.sessions
    assert.equal(s.length, 1)
    assert.equal(s[0].id, SESSION)
    assert.equal(s[0].runtime, 'claude')
    const text = r.result.content[0].text
    assert.ok(!text.includes('TOPSECRET') && !text.includes(fakeHome))
  })
})
