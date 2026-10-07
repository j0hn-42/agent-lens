/**
 * Issue #68 wiring, through the REAL entry points: scripts/dev-relay.ts and app/src/app.ts are started
 * as child processes (HOME in a temp dir, AGENT_LENS_PORT=0, never the default port) and probed over
 * HTTP on 127.0.0.1. These tests fail when guardRequest, resolveListenPort or listenLoopback is removed
 * or reverted in either entry point.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { CSP_API, CSP_STATIC_APP, DEFAULT_RELAY_PORT, SERVER_ALLOWED_METHODS } from '../extension/src/constants'

const ROOT = path.resolve(__dirname, '..')
// The entry points are bundled with `vscode` aliased to the shim; from source the alias is preloaded
const VSCODE_ALIAS = path.join(ROOT, 'extension', 'test', 'helpers', 'alias-vscode.ts')
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 10_000
const PARALLEL_STATUS_REQUESTS = 50
const RESERVED_PORTS = [3000, 3001, DEFAULT_RELAY_PORT]

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-entry-'))
const workspace = path.join(fakeHome, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
const children: ChildProcess[] = []

interface Entry {
  name: string
  args: string[]
  /** Regex capturing the bound port in stdout */
  listening: RegExp
  /** Kind of response served for an unknown, non-API path */
  rootCsp: string
}

const ENTRIES: Entry[] = [
  { name: 'scripts/dev-relay.ts', args: ['scripts/dev-relay.ts', workspace], listening: /SSE relay on http:\/\/127\.0\.0\.1:(\d+)\/events/, rootCsp: CSP_API },
  { name: 'app/src/app.ts', args: ['app/src/app.ts', '--no-open'], listening: /Server running at http:\/\/127\.0\.0\.1:(\d+)/, rootCsp: CSP_STATIC_APP },
]

interface Running { child: ChildProcess; port: number; exited: Promise<number | null>; output: () => string }

function start(entry: Entry, extraArgs: string[] = [], env: Record<string, string> = { AGENT_LENS_PORT: '0' }): Promise<Running> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...env }
    delete childEnv.FORCE_COLOR
    if (!('AGENT_LENS_PORT' in env)) delete childEnv.AGENT_LENS_PORT
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', VSCODE_ALIAS, ...entry.args, ...extraArgs], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let out = ''
    const exited = new Promise<number | null>(r => child.once('exit', code => r(code)))
    const timer = setTimeout(() => reject(new Error(`${entry.name} did not start:\n${out}`)), STARTUP_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      out += chunk.toString()
      const m = entry.listening.exec(out)
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), exited, output: () => out }) }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', c => { out += c.toString() })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${entry.name} exited early (${code}):\n${out}`)) })
  })
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
function request(port: number, method: string, urlPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`${method} ${urlPath}: no answer`)))
    req.on('error', reject)
    req.end()
  })
}

function assertStrictHeaders(h: http.IncomingHttpHeaders, csp: string, label: string) {
  assert.equal(h['content-security-policy'], csp, `${label}: CSP`)
  assert.equal(h['cache-control'], 'no-store', `${label}: Cache-Control`)
  assert.equal(h['x-content-type-options'], 'nosniff', `${label}: nosniff`)
  assert.equal(h['referrer-policy'], 'no-referrer', `${label}: Referrer-Policy`)
}

/** True when something accepts a TCP connection at host:port. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

function externalAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return undefined
}

after(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

for (const entry of ENTRIES) {
  describe(`real entry point ${entry.name}`, () => {
    let a: Running
    let b: Running
    before(async () => {
      // Two instances at once: only an ephemeral port lets both bind
      ;[a, b] = await Promise.all([start(entry), start(entry)])
    })
    after(async () => {
      for (const r of [a, b]) if (r && r.child.exitCode === null) r.child.kill('SIGKILL')
    })

    it('AGENT_LENS_PORT=0 gives each instance its own ephemeral port, never the default one', () => {
      assert.notEqual(a.port, b.port)
      for (const r of [a, b]) {
        assert.ok(r.port > 0 && r.port < 65536)
        assert.ok(!RESERVED_PORTS.includes(r.port), `reserved port used: ${r.port}`)
      }
    })

    it('listens on loopback only', async () => {
      assert.equal(await accepts('127.0.0.1', a.port), true)
      const external = externalAddress()
      if (external) assert.equal(await accepts(external, a.port), false, `reachable on ${external}`)
    })

    it('answers 405 with Allow to any method but GET/HEAD/OPTIONS, with strict headers', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        for (const p of ['/events', '/status', '/anything']) {
          const r = await request(a.port, method, p)
          assert.equal(r.status, 405, `${method} ${p}`)
          assert.equal(r.headers.allow, SERVER_ALLOWED_METHODS.join(', '))
          assert.ok(r.headers['content-security-policy'], `${method} ${p}: headers set on the 405`)
        }
      }
    })

    it('serves the security headers on /status, on errors and on the root', async () => {
      assertStrictHeaders((await request(a.port, 'GET', '/status')).headers, CSP_API, 'GET /status')
      assertStrictHeaders((await request(a.port, 'GET', '/events?session=../x')).headers, CSP_API, '400 on /events')
      assertStrictHeaders((await request(a.port, 'POST', '/status')).headers, CSP_API, '405')
      assertStrictHeaders((await request(a.port, 'GET', '/')).headers, entry.rootCsp, 'GET /')
    })

    it('rejects bad session ids with 400 and accepts a well-formed one', async () => {
      const good = '77777777-7777-4777-8777-777777777777'
      for (const bad of ['../x', 'a%2F..%2Fb', 'x'.repeat(300), '%00', 'a%20b']) {
        assert.equal((await request(a.port, 'GET', `/events?session=${bad}`)).status, 400, `session=${bad}`)
      }
      assert.equal((await request(a.port, 'GET', `/events?session=${good}&session=${good}`)).status, 400, 'repeated parameter')
      assert.equal((await request(a.port, 'GET', '/status?sessionId=../x')).status, 400, 'sessionId on /status')
      assert.equal((await request(a.port, 'GET', `/status?sessionId=${good}`)).status, 200)
    })

    it('OPTIONS is answered 204 and HEAD /events never opens a stream', async () => {
      const options = await request(a.port, 'OPTIONS', '/events')
      assert.equal(options.status, 204)
      assert.equal(options.headers.allow, SERVER_ALLOWED_METHODS.join(', '))
      const head = await request(a.port, 'HEAD', '/events')
      assert.equal(head.status, 200)
      assert.equal(head.body, '')
      assert.match(String(head.headers['content-type']), /text\/event-stream/)
    })

    it('serves 50 parallel GET /status consistently', async () => {
      const replies = await Promise.all(Array.from({ length: PARALLEL_STATUS_REQUESTS }, (_, i) =>
        request(a.port, 'GET', '/status', { 'User-Agent': `parallel-${i}` })))
      assert.ok(replies.every(r => r.status === 200), replies.map(r => r.status).join(','))
      const bodies = new Set(replies.map(r => r.body))
      assert.equal(bodies.size, 1, 'every request saw the same snapshot')
      assert.equal(JSON.parse(replies[0].body).workspace.length > 0, true)
    })

    it('frees the listener when the last SSE client leaves and the process is stopped', async () => {
      const req = await new Promise<http.ClientRequest>((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port: b.port, path: '/events', agent: false }, res => { res.resume(); resolve(r) })
        r.on('error', reject)
      })
      req.destroy()
      b.child.kill('SIGTERM')
      const code = await Promise.race([
        b.exited,
        new Promise<'timeout'>(r => setTimeout(() => r('timeout'), EXIT_TIMEOUT_MS)),
      ])
      assert.equal(code, 0, `clean exit on SIGTERM:\n${b.output()}`)
      assert.equal(await accepts('127.0.0.1', b.port), false, 'the port is released')
    })
  })
}

describe('app entry point: --port 0', () => {
  it('binds an ephemeral port without the environment variable', async () => {
    const app = ENTRIES[1]
    const r = await start(app, ['--port', '0'], {})
    try {
      assert.ok(r.port > 0 && !RESERVED_PORTS.includes(r.port), `port ${r.port}`)
      assert.equal((await request(r.port, 'DELETE', '/')).status, 405)
    } finally { r.child.kill('SIGKILL') }
  })
})
