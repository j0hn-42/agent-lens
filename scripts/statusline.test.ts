/** GET /statusline (#236): une ligne pour tmux / zellij, dérivée des observations, jamais plus que ce qui est prouvé. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { isStatusLinePath } from '../extension/src/relay-guards'
import { KeyedRateLimiter } from '../extension/src/hook-guards'
import type { Observations, ObservedSession } from '../extension/src/observations'
import { formatStatusline, createStatusLineRoute } from './routes/statusline'

function session(over: Partial<ObservedSession> = {}): ObservedSession {
  return { id: 's1', runtime: 'claude', status: 'active', startedAt: 1, lastActivityAt: 2, ageMs: 10, freshness: 'fresh', agentCount: 0, agents: [], ...over }
}
function obs(sessions: ObservedSession[], over: Partial<Observations> = {}): Observations {
  return { schema: 1, generatedAt: 5, sessions, truncated: false, omittedSessions: 0, ...over }
}

describe('isStatusLinePath', () => {
  it('matches the path regardless of the query', () => {
    assert.equal(isStatusLinePath('/statusline'), true)
    assert.equal(isStatusLinePath('/statusline?format=json'), true)
    for (const u of ['/status', '/statuslines', '/', '', undefined]) assert.equal(isStatusLinePath(u), false, String(u))
  })
})

describe('formatStatusline', () => {
  it('says 0 live when nothing is observed', () => {
    assert.deepEqual(formatStatusline(obs([])), { live: 0, active: 0, idle: 0, atLeast: false, text: 'lens 0 live' })
  })
  it('counts only fresh active sessions as live, and their agents by state', () => {
    const r = formatStatusline(obs([
      session({ id: 'a', agentCount: 2, agents: [{ name: 'x', state: 'active' }, { name: 'y', state: 'idle' }] }),
      session({ id: 'b', freshness: 'stale', agentCount: 1, agents: [{ name: 'z', state: 'active' }] }),
      session({ id: 'c', status: 'completed', freshness: 'closed' }),
      session({ id: 'd', provenance: 'imported', freshness: 'stale' }),
    ]))
    assert.equal(r.live, 1)
    assert.equal(r.active, 1)
    assert.equal(r.idle, 1)
    assert.equal(r.text, 'lens 1 live 1 active 1 idle')
  })
  it('marks counts as lower bounds when the observation is truncated or incomplete', () => {
    for (const o of [obs([session()], { truncated: true }), obs([session()], { omittedSessions: 2 }), obs([session({ agentsIncomplete: true })])]) {
      const r = formatStatusline(o)
      assert.equal(r.atLeast, true)
      assert.match(r.text, /^lens >=1 live/)
    }
  })
  it('never lets a session id or an agent name reach the line', () => {
    const r = formatStatusline(obs([session({ id: 'secret-id', agentCount: 1, agents: [{ name: 'my-secret-agent', state: 'active' }] })]))
    assert.ok(!r.text.includes('secret') && !r.text.includes('my-'))
    assert.ok(r.text.length < 80 && !/[\r\n]/.test(r.text))
  })
})

describe('GET /statusline route', () => {
  let server: http.Server
  let port = 0
  let current: Observations | null = obs([session({ agentCount: 1, agents: [{ name: 'a', state: 'active' }] })])
  before(async () => {
    const route = createStatusLineRoute({
      limiter: new KeyedRateLimiter(1000, 1000, 8),
      observe: () => (current ? { ok: true, result: current } : { ok: false, error: 'down' }),
    })
    server = http.createServer((req, res) => { if (isStatusLinePath(req.url)) return void route(req, res); res.writeHead(404); res.end() })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { server.close() })
  const get = (p: string, method = 'GET', headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers }, res => {
      let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject); req.end()
  })

  it('answers one line of plain text, not cached', async () => {
    const r = await get('/statusline')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /^text\/plain/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.body, 'lens 1 live 1 active 0 idle\n')
  })
  it('answers the counters as JSON with ?format=json', async () => {
    const r = await get('/statusline?format=json')
    assert.deepEqual(JSON.parse(r.body), { live: 1, active: 1, idle: 0, atLeast: false, text: 'lens 1 live 1 active 0 idle' })
  })
  it('rejects an unknown format and unknown parameters with 400', async () => {
    assert.equal((await get('/statusline?format=xml')).status, 400)
    assert.equal((await get('/statusline?x=1')).status, 400)
  })
  it('answers 503, not "0 live", when the observation is unavailable', async () => {
    const saved = current; current = null
    try { assert.equal((await get('/statusline')).status, 503) } finally { current = saved }
  })
  it('keeps the shared guards: foreign Host 403, POST 405', async () => {
    assert.equal((await get('/statusline', 'GET', { Host: 'evil.example' })).status, 403)
    assert.equal((await get('/statusline', 'POST')).status, 405)
  })
})
