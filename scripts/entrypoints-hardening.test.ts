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
const SIGNAL_SETTLE_MS = 300
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

    it('POST /scope is wired behind the guards in the real server (#291): JSON only, same site only, strict body', async () => {
      const post = (headers: http.OutgoingHttpHeaders, body: string) => new Promise<Reply>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: a.port, method: 'POST', path: '/scope', agent: false, headers: { 'User-Agent': `scope-${Math.random()}`, ...headers } }, res => {
          let out = ''
          res.setEncoding('utf8')
          res.on('data', c => { out += c })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }))
        })
        req.on('error', reject)
        req.end(body)
      })
      const json = { 'Content-Type': 'application/json' }
      const ok = await post(json, '{"scope":"workspace"}')
      assert.equal(ok.status, 200, ok.body)
      assertStrictHeaders(ok.headers, CSP_API, 'POST /scope')
      assert.deepEqual(JSON.parse(ok.body), { scope: 'workspace', allWorkspaces: false })
      assert.equal((await post(json, '{"scope":"nowhere"}')).status, 400)
      assert.equal((await post({}, '{"scope":"all"}')).status, 415)
      assert.equal((await post({ ...json, Origin: 'https://evil.example' }, '{"scope":"all"}')).status, 403)
      assert.equal((await post({ ...json, 'Sec-Fetch-Site': 'cross-site' }, '{"scope":"all"}')).status, 403)
      assert.equal((await post({ ...json, Host: 'evil.example' }, '{"scope":"all"}')).status, 403)
      assert.equal(JSON.parse((await request(a.port, 'GET', '/status')).body).allWorkspaces, false, 'refused requests changed nothing')
      assert.equal((await request(a.port, 'POST', '/status')).status, 405)
      assert.equal((await request(a.port, 'GET', '/scope')).status, 405)
    })

    it('answers 403 to a foreign Host or Origin, with no --allow-host given (#474, DNS rebinding)', async () => {
      const foreignHosts = ['evil.example', `evil.example:${a.port}`, 'localhost.evil.example', '127.0.0.1.nip.io', 'box.tail1234.ts.net']
      const paths = entry.rootCsp === CSP_STATIC_APP ? ['/events', '/status', '/'] : ['/events', '/status']
      for (const p of paths) {
        for (const host of foreignHosts) {
          const r = await request(a.port, 'GET', p, { Host: host })
          assert.equal(r.status, 403, `GET ${p} Host: ${host}`)
          assert.ok(r.headers['content-security-policy'], `GET ${p} Host: ${host}: headers set on the 403`)
        }
      }
      for (const origin of ['https://evil.example', 'null', `http://evil.example:${a.port}`]) {
        assert.equal((await request(a.port, 'GET', '/events', { Origin: origin })).status, 403, `Origin: ${origin}`)
      }
      assert.equal((await request(a.port, 'GET', '/events', { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'Sec-Fetch-Site: cross-site')
      // The loopback Host keeps working
      assert.equal((await request(a.port, 'GET', '/status', { Host: `localhost:${a.port}` })).status, 200)
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

    it('runs the cleanup (relay.dispose, which kills launched agents) on SIGHUP, SIGINT and SIGTERM alike (#229)', async () => {
      // Without a SIGHUP handler Node dies without cleanup (exit code null): a detached launched agent would be left running
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
        const r = await start(entry)
        // The port line is printed just before the handlers are installed: let that finish before signalling
        await new Promise(res => setTimeout(res, SIGNAL_SETTLE_MS))
        r.child.kill(signal)
        const code = await Promise.race([r.exited, new Promise<'timeout'>(res => setTimeout(() => res('timeout'), EXIT_TIMEOUT_MS))])
        assert.equal(code, 0, `${signal}: clean exit through cleanup():\n${r.output()}`)
      }
    })
  })
}

describe('app entry point: remote access is refused at startup (#241)', () => {
  /** Runs the app until it exits; resolves with its exit code and output (rejects if it starts listening). */
  function runToExit(args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, AGENT_LENS_PORT: '0' }
      delete childEnv.FORCE_COLOR
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', VSCODE_ALIAS, 'app/src/app.ts', '--no-open', ...args], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let out = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`did not exit:\n${out}`)) }, STARTUP_TIMEOUT_MS)
      const onData = (c: Buffer) => {
        out += c.toString()
        if (ENTRIES[1].listening.test(out)) { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(`started listening:\n${out}`)) }
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.once('exit', code => { clearTimeout(timer); resolve({ code, out }) })
    })
  }

  it('--allow-host stops the start while token authentication is not shipped', async () => {
    const r = await runToExit(['--allow-host', 'box.tail1234.ts.net'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /--allow-host/)
    assert.match(r.out, /token/i)
  })

  it('an invalid --allow-host and a non-loopback --host stop the start', async () => {
    assert.equal((await runToExit(['--allow-host', '*.ts.net'])).code, 2)
    const host = await runToExit(['--host', '0.0.0.0'])
    assert.equal(host.code, 2, host.out)
    assert.match(host.out, /loopback/i)
    // A security flag typed without its value must not be ignored
    assert.equal((await runToExit(['--host'])).code, 2)
    assert.equal((await runToExit(['--allow-host'])).code, 2)
  })

  it('a non-loopback --host without --remote stops the start and names --remote (#474)', async () => {
    for (const host of ['0.0.0.0', '192.168.1.10']) {
      const r = await runToExit(['--host', host])
      assert.equal(r.code, 2, r.out)
      assert.match(r.out, /--remote/)
    }
  })

  it('--remote stops the start: alone (never an implicit 0.0.0.0), and with a --host while token and TLS are missing (#474)', async () => {
    const alone = await runToExit(['--remote'])
    assert.equal(alone.code, 2, alone.out)
    assert.match(alone.out, /--host/)
    const withHost = await runToExit(['--remote', '--host', '0.0.0.0'])
    assert.equal(withHost.code, 2, withHost.out)
    assert.match(withHost.out, /token/i)
    // '--host --remote': the flag is not swallowed as the address
    assert.equal((await runToExit(['--host', '--remote'])).code, 2)
  })

  it('the --flag=value forms and a flag after --import are not ignored (#474)', async () => {
    for (const args of [['--host=0.0.0.0'], ['--remote=1'], ['--allow-host=box.tail1234.ts.net'], ['--import', '--host', '0.0.0.0']]) {
      const r = await runToExit(args)
      assert.equal(r.code, 2, `${args.join(' ')}:\n${r.out}`)
    }
  })
})

describe('dev relay entry point: remote access flags stop the start (#474)', () => {
  /** Runs the dev relay until it exits (rejects if it starts listening): a flag must not become the workspace path. */
  function runDevRelayToExit(args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, AGENT_LENS_PORT: '0' }
      delete childEnv.FORCE_COLOR
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', VSCODE_ALIAS, 'scripts/dev-relay.ts', ...args], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let out = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`did not exit:\n${out}`)) }, STARTUP_TIMEOUT_MS)
      const onData = (c: Buffer) => {
        out += c.toString()
        if (ENTRIES[0].listening.test(out)) { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(`started listening:\n${out}`)) }
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.once('exit', code => { clearTimeout(timer); resolve({ code, out }) })
    })
  }

  it('--host, --remote and --allow-host are refused, never read as the workspace', async () => {
    for (const args of [
      ['--host', '0.0.0.0'], ['--remote'], ['--allow-host', 'box.tail1234.ts.net'], [workspace, '--remote', '--host', '0.0.0.0'],
      ['--host=0.0.0.0'], ['--remote=1'], ['--allow-host=box.tail1234.ts.net'], ['--import', '--host', '0.0.0.0'],
    ]) {
      const r = await runDevRelayToExit(args)
      assert.equal(r.code, 2, `${args.join(' ')}:\n${r.out}`)
      assert.match(r.out, /loopback/i, args.join(' '))
    }
  })

  it('an unknown option is refused, never read as the workspace', async () => {
    const r = await runDevRelayToExit(['--hots', '0.0.0.0'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /--hots/)
  })
})

describe('app entry point: no environment variable opens the listener (#474)', () => {
  it('AGENT_LENS_HOST / AGENT_LENS_REMOTE / HOST are ignored: the server still binds 127.0.0.1 only', async () => {
    const r = await start(ENTRIES[1], [], { AGENT_LENS_PORT: '0', AGENT_LENS_HOST: '0.0.0.0', AGENT_LENS_REMOTE: '1', HOST: '0.0.0.0' })
    try {
      assert.equal(await accepts('127.0.0.1', r.port), true)
      // Proof that holds without an external interface (unshare -rn): on Linux all of 127/8 reaches a socket bound to
      // 0.0.0.0, so 127.0.0.2 is refused only when the server is bound to 127.0.0.1 exactly
      if (process.platform === 'linux') assert.equal(await accepts('127.0.0.2', r.port), false, 'bound to more than 127.0.0.1')
      const external = externalAddress()
      if (external) assert.equal(await accepts(external, r.port), false, `reachable on ${external}`)
      assert.equal((await request(r.port, 'GET', '/status', { Host: 'evil.example' })).status, 403)
    } finally { r.child.kill('SIGKILL') }
  })
})

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
