/**
 * Hardened local server primitives (issue #68), tested over real HTTP on 127.0.0.1 ephemeral ports.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import {
  guardRequest, listenLoopback, resolveListenPort, KeyedCoalescer, SharedTicker, securityHeaders,
  hasValidSessionQuery,
} from './server-hardening'
import { CSP_API, CSP_STATIC_APP } from '../extension/src/constants'

const servers: http.Server[] = []
after(() => { for (const s of servers) s.close() })

async function start(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler)
  servers.push(server)
  const port = await listenLoopback(server, 0)
  return { port, server }
}

function request(port: number, method: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const routed = (kind: 'api' | 'static'): http.RequestListener => (req, res) => {
  if (guardRequest(req, res, { kind })) return
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
}

function assertStrictHeaders(h: http.IncomingHttpHeaders, csp: string) {
  assert.equal(h['content-security-policy'], csp)
  assert.equal(h['cache-control'], 'no-store')
  assert.equal(h['x-content-type-options'], 'nosniff')
  assert.equal(h['referrer-policy'], 'no-referrer')
}

describe('listening', () => {
  it('port 0 binds loopback only and returns the chosen port', async () => {
    const { port, server } = await start(routed('api'))
    assert.ok(port > 0 && port < 65536)
    const addr = server.address() as { address: string; port: number }
    assert.equal(addr.address, '127.0.0.1')
    assert.equal(addr.port, port)
  })

  it('keeps the default port unless AGENT_LENS_PORT=0', () => {
    assert.equal(resolveListenPort(3001, {}), 3001)
    assert.equal(resolveListenPort(3001, { AGENT_LENS_PORT: '0' }), 0)
    assert.equal(resolveListenPort(3001, { AGENT_LENS_PORT: ' 0 ' }), 0)
    assert.equal(resolveListenPort(3001, { AGENT_LENS_PORT: '4000' }), 3001)
    assert.equal(resolveListenPort(3001, { AGENT_LENS_PORT: 'abc' }), 3001)
  })

  it('rejects when the port is taken', async () => {
    const { port } = await start(routed('api'))
    const other = http.createServer()
    await assert.rejects(listenLoopback(other, port), /EADDRINUSE/)
  })
})

describe('headers on every response', () => {
  it('API routes: CSP default-src none, no-store, nosniff, no-referrer', async () => {
    const { port } = await start(routed('api'))
    const r = await request(port, 'GET', '/events')
    assert.equal(r.status, 200)
    assertStrictHeaders(r.headers, CSP_API)
    assert.match(CSP_API, /default-src 'none'/)
  })

  it('static app: strict same-origin policy', async () => {
    const { port } = await start(routed('static'))
    const r = await request(port, 'GET', '/')
    assertStrictHeaders(r.headers, CSP_STATIC_APP)
    assert.match(CSP_STATIC_APP, /script-src 'self'/)
    assert.doesNotMatch(CSP_STATIC_APP, /unsafe-eval|script-src[^;]*unsafe-inline/)
    assert.match(CSP_STATIC_APP, /frame-ancestors 'none'/)
  })

  it('error responses carry the headers too (405, 400)', async () => {
    const { port } = await start(routed('api'))
    assertStrictHeaders((await request(port, 'POST', '/')).headers, CSP_API)
    assertStrictHeaders((await request(port, 'GET', '/events?session=a%20b')).headers, CSP_API)
  })

  it('the two kinds differ', () => {
    assert.notEqual(securityHeaders('api')['Content-Security-Policy'], securityHeaders('static')['Content-Security-Policy'])
  })
})

describe('methods', () => {
  it('answers 405 with Allow to anything but GET/HEAD/OPTIONS', async () => {
    const { port } = await start(routed('api'))
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE']) {
      const r = await request(port, m, '/status')
      assert.equal(r.status, 405, m)
      assert.equal(r.headers.allow, 'GET, HEAD, OPTIONS')
    }
  })

  it('GET and HEAD pass, OPTIONS gets 204', async () => {
    const { port } = await start(routed('api'))
    assert.equal((await request(port, 'GET', '/x')).status, 200)
    assert.equal((await request(port, 'HEAD', '/x')).status, 200)
    const o = await request(port, 'OPTIONS', '/x')
    assert.equal(o.status, 204)
    assert.equal(o.headers.allow, 'GET, HEAD, OPTIONS')
  })

  it('HEAD /events never opens a stream', async () => {
    let reached = false
    const { port } = await start((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      reached = true
      res.end()
    })
    const r = await request(port, 'HEAD', '/events')
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-type'], 'text/event-stream')
    assert.equal(reached, false)
  })
})

describe('session id validation', () => {
  it('rejects malformed, repeated and oversized ids with 400 (session and sessionId)', async () => {
    const { port } = await start(routed('api'))
    for (const q of [
      'session=a%20b', 'session=..%2F..%2Fetc', `session=${'x'.repeat(200)}`, 'session=', 'session=a&session=b',
      'sessionId=a%20b', 'sessionId=', `sessionId=${'y'.repeat(200)}`, 'sessionId=%3Cscript%3E',
    ]) {
      const r = await request(port, 'GET', `/events?${q}`)
      assert.equal(r.status, 400, q)
    }
  })

  it('accepts well-formed ids and requests without one', async () => {
    const { port } = await start(routed('api'))
    assert.equal((await request(port, 'GET', '/events?session=abc-123_x.y:z')).status, 200)
    assert.equal((await request(port, 'GET', '/events?sessionId=abc')).status, 200)
    assert.equal((await request(port, 'GET', '/events')).status, 200)
    assert.equal(hasValidSessionQuery(undefined), true)
  })
})

describe('KeyedCoalescer', () => {
  it('50 parallel requests run ONE refresh and share its result', async () => {
    const c = new KeyedCoalescer<number>()
    let executions = 0
    let arrived = 0
    let allArrived!: () => void
    const everyone = new Promise<void>(r => { allArrived = r })
    const { port } = await start(async (req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (++arrived === 50) allArrived()
      // The refresh only completes once all 50 requests reached the server: they are all concurrent
      const v = await c.run('refresh', async () => { executions++; await Promise.race([everyone, new Promise(r => setTimeout(r, 5000))]); return 42 })
      res.writeHead(200); res.end(String(v))
    })
    const results = await Promise.all(Array.from({ length: 50 }, () => request(port, 'GET', '/refresh')))
    assert.ok(results.every(r => r.status === 200 && r.body === '42'))
    assert.equal(executions, 1)
    assert.equal(c.runs, 1)
    assert.equal(c.pending, 0, 'nothing left in flight')
  })

  it('different keys run independently; a new run starts after the previous settled', async () => {
    const c = new KeyedCoalescer<string>()
    const slow = (v: string) => async () => { await new Promise(r => setTimeout(r, 20)); return v }
    const [a, b] = await Promise.all([c.run('a', slow('A')), c.run('b', slow('B'))])
    assert.deepEqual([a, b], ['A', 'B'])
    assert.equal(c.runs, 2)
    await c.run('a', slow('A2'))
    assert.equal(c.runs, 3)
  })

  it('a failing refresh rejects every waiter and does not poison the next run', async () => {
    const c = new KeyedCoalescer<number>()
    const failing = () => c.run('k', async () => { await new Promise(r => setTimeout(r, 10)); throw new Error('nope') })
    const settled = await Promise.allSettled([failing(), c.run('k', () => 1)])
    assert.deepEqual(settled.map(s => s.status), ['rejected', 'rejected'])
    assert.equal(await c.run('k', () => 7), 7)
  })
})

describe('SharedTicker', () => {
  it('one interval for all clients, stopped when the last one disconnects', async () => {
    let ticks = 0
    const t = new SharedTicker(() => { ticks++ }, 10)
    assert.equal(t.active, false)
    const r1 = t.acquire()
    const r2 = t.acquire()
    assert.equal(t.active, true)
    assert.equal(t.clientCount, 2)
    await new Promise(r => setTimeout(r, 55))
    const whileTwo = ticks
    assert.ok(whileTwo >= 2, `ticked (${whileTwo})`)
    assert.ok(whileTwo <= 7, `a single interval, not one per client (${whileTwo})`)

    r1()
    r1() // idempotent
    assert.equal(t.clientCount, 1)
    assert.equal(t.active, true)

    r2()
    assert.equal(t.active, false)
    const stopped = ticks
    await new Promise(r => setTimeout(r, 50))
    assert.equal(ticks, stopped, 'no tick after the last client left')
  })

  it('restarts for a later client and survives a throwing tick', async () => {
    let ticks = 0
    const t = new SharedTicker(() => { ticks++; throw new Error('boom') }, 10)
    t.acquire()()
    assert.equal(t.active, false)
    const release = t.acquire()
    await new Promise(r => setTimeout(r, 45))
    assert.ok(ticks >= 2)
    release()
    assert.equal(t.active, false)
  })

  it('stop() clears the timer even with clients attached', () => {
    const t = new SharedTicker(() => {}, 10)
    t.acquire()
    t.stop()
    assert.equal(t.active, false)
  })
})
