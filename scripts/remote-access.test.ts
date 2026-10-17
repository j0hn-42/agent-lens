/**
 * Remote access guards, step 1 of #241 (pure functions; one loopback server for the POST /pair gate of #475).
 *
 * v1 is "tunnel only": the relay keeps listening on 127.0.0.1 and an SSH / Tailscale tunnel forwards to it.
 * The tunnel's peer is loopback, so the only new thing a request can carry is a Host header naming the
 * tunnel. `--allow-host <name>` adds such a name to an explicit list; everything else stays refused.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import {
  parseAllowedHosts, classifyHost, isRemoteReadOnlyRoute, isRemoteCrossOrigin, remoteStartupError, remoteRateKey, REMOTE_AUTH_AVAILABLE,
  bindRemoteAuth, gateRemoteRequest, type RemoteAuth,
} from './remote-access'
import { listenLoopback } from './server-hardening'
import { RELAY_MAX_ALLOWED_HOSTS } from '../extension/src/constants'

describe('parseAllowedHosts', () => {
  it('accepts DNS names, with an optional port, lowercased and deduplicated', () => {
    const r = parseAllowedHosts(['Box.Tail1234.ts.net', 'box.tail1234.ts.net', 'mybox', 'lens.example.com:8443'])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.hosts, ['box.tail1234.ts.net', 'mybox', 'lens.example.com:8443'])
  })

  it('refuses wildcards, IP literals, loopback names, trailing dots, credentials, paths and bad ports', () => {
    for (const bad of ['', ' ', '*', '*.ts.net', '.ts.net', 'box.ts.net.', '0.0.0.0', '192.168.1.10', '[::1]', '[fe80::1]',
      'localhost', 'app.localhost', '127.0.0.1', 'user@box.ts.net', 'box.ts.net/x', 'http://box.ts.net', 'box.ts.net:0',
      'box.ts.net:65536', 'box.ts.net:', 'box.ts.net:80:80', '-box.ts.net', 'box-.ts.net', 'bo_x.ts.net', 'a'.repeat(64) + '.ts.net',
      'box ts.net', 'box.ts.net\n']) {
      const r = parseAllowedHosts([bad])
      assert.deepEqual(r.hosts, [], `accepted ${JSON.stringify(bad)}`)
      assert.equal(r.errors.length, 1, `no error for ${JSON.stringify(bad)}`)
    }
  })

  it('refuses the default ports 80 and 443: browsers leave them out of Host, so they would never match', () => {
    for (const bad of ['box.ts.net:443', 'box.ts.net:80']) assert.deepEqual(parseAllowedHosts([bad]).hosts, [], bad)
  })

  it(`caps the list at ${RELAY_MAX_ALLOWED_HOSTS} names`, () => {
    const many = Array.from({ length: RELAY_MAX_ALLOWED_HOSTS + 1 }, (_, i) => `box${i}.ts.net`)
    const r = parseAllowedHosts(many)
    assert.equal(r.hosts.length, RELAY_MAX_ALLOWED_HOSTS)
    assert.equal(r.errors.length, 1)
  })

  it('does not echo an overly long value in its error', () => {
    const r = parseAllowedHosts(['x'.repeat(500)])
    assert.ok(r.errors[0].length < 200, r.errors[0])
  })
})

describe('classifyHost (DNS rebinding: the Host must be loopback or EXACTLY an allowed name)', () => {
  const allowed = ['box.tail1234.ts.net', 'lens.example.com:8443']

  it('keeps loopback Host headers loopback', () => {
    for (const h of ['127.0.0.1:3001', 'localhost:3001', 'localhost', '[::1]:3001']) assert.equal(classifyHost(h, allowed), 'loopback', h)
  })

  it('accepts an allowed name exactly, case-insensitively, with the port it was given', () => {
    assert.equal(classifyHost('box.tail1234.ts.net', allowed), 'allowed')
    assert.equal(classifyHost('BOX.tail1234.TS.NET', allowed), 'allowed')
    assert.equal(classifyHost('lens.example.com:8443', allowed), 'allowed')
  })

  it('refuses every look-alike: suffix, prefix, other port, no port, trailing dot, userinfo, list, empty', () => {
    for (const h of [undefined, '', 'evil.example', 'box.tail1234.ts.net.evil.example', 'evil-box.tail1234.ts.net',
      'x.box.tail1234.ts.net', 'box.tail1234.ts.net.', 'box.tail1234.ts.net:443', 'box.tail1234.ts.net:8443',
      'lens.example.com', 'lens.example.com:443', 'user@box.tail1234.ts.net', 'box.tail1234.ts.net, evil.example',
      'box.tail1234.ts.net ', ' box.tail1234.ts.net/x', '0.0.0.0:3001', '192.168.1.10:3001']) {
      assert.equal(classifyHost(h, allowed), 'foreign', JSON.stringify(h))
    }
  })

  it('without an allow list, every non-loopback Host is foreign (today\'s behaviour)', () => {
    assert.equal(classifyHost('box.tail1234.ts.net', []), 'foreign')
  })
})

describe('isRemoteReadOnlyRoute (strict read-only surface for an allowed Host)', () => {
  it('lets GET/HEAD reach /events, /status and the static app', () => {
    for (const url of ['/events', '/events?session=77777777-7777-4777-8777-777777777777', '/status', '/', '/index.html', '/index.js', '/index.css', '/theme.js']) {
      assert.equal(isRemoteReadOnlyRoute('GET', url), true, url)
      assert.equal(isRemoteReadOnlyRoute('HEAD', url), true, url)
    }
  })

  it('refuses the sensitive routes, every other method and unknown paths', () => {
    for (const url of ['/context?session=x', '/issue-links?role=qa-engineer', '/observations', '/observations/schema', '/statusline', '/scope',
      '/events/x', '/a/b/index.js', '/..%2Findex.js', '/index.json', '/pair']) {
      assert.equal(isRemoteReadOnlyRoute('GET', url), false, url)
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', undefined]) {
      assert.equal(isRemoteReadOnlyRoute(method, '/events'), false, String(method))
    }
    assert.equal(isRemoteReadOnlyRoute('POST', '/scope'), false)
  })
})

describe('isRemoteCrossOrigin (an allowed Host only accepts its own https origin)', () => {
  const host = 'box.tail1234.ts.net'
  it('accepts no Origin (EventSource same-origin, curl) and https://<host>', () => {
    assert.equal(isRemoteCrossOrigin({}, host), false)
    assert.equal(isRemoteCrossOrigin({ 'sec-fetch-site': 'same-origin' }, host), false)
    assert.equal(isRemoteCrossOrigin({ origin: `https://${host}` }, host), false)
    assert.equal(isRemoteCrossOrigin({ origin: `https://${host}` }, 'BOX.tail1234.ts.net'), false)
  })
  it('refuses http://<host>, other sites, the dev origins, null and Sec-Fetch-Site cross-site', () => {
    for (const headers of [
      { origin: `http://${host}` }, { origin: 'https://evil.example' }, { origin: `https://${host}.evil.example` },
      { origin: 'http://localhost:3000' }, { origin: 'null' }, { origin: [`https://${host}`, 'https://evil.example'] },
      { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    ]) assert.equal(isRemoteCrossOrigin(headers, host), true, JSON.stringify(headers))
  })
  it('accepts Sec-Fetch-Site none (typed URL) and same-origin only', () => {
    assert.equal(isRemoteCrossOrigin({ 'sec-fetch-site': 'none' }, host), false)
    assert.equal(isRemoteCrossOrigin({ 'sec-fetch-site': 'same-site', origin: `https://${host}` }, host), true)
  })
})

describe('remoteRateKey (a tunnel peer is always 127.0.0.1: the client must not pick its own bucket)', () => {
  it('ignores User-Agent and Origin for an allowed Host', () => {
    const a = remoteRateKey('BOX.tail1234.ts.net')
    assert.equal(a, remoteRateKey('box.tail1234.ts.net'))
    assert.match(a, /^remote\|/)
  })
})

describe('remoteStartupError (fail closed at startup)', () => {
  it('nothing asked: no error', () => {
    assert.equal(remoteStartupError({ allowHosts: [] }), null)
    assert.equal(remoteStartupError({ allowHosts: [], host: '127.0.0.1' }), null)
  })

  it('--host outside loopback is refused: v1 never listens outside 127.0.0.1', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::', 'box.ts.net']) {
      assert.match(remoteStartupError({ allowHosts: [], host }) ?? '', /loopback/i, host)
    }
  })

  it('--host outside loopback without --remote names the missing --remote (#474)', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::', 'box.ts.net']) {
      assert.match(remoteStartupError({ allowHosts: [], host }) ?? '', /--remote/, host)
    }
  })

  it('--host outside loopback WITH --remote is still refused: no token, no TLS yet (#474)', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
      const err = remoteStartupError({ allowHosts: [], host, remote: true }) ?? ''
      assert.match(err, /token/i, host)
      assert.match(err, /TLS/, host)
    }
  })

  it('--remote never implies an address: alone, with an empty or a loopback --host, it stops the start (#474)', () => {
    assert.match(remoteStartupError({ allowHosts: [], remote: true }) ?? '', /--host/)
    assert.match(remoteStartupError({ allowHosts: [], host: '', remote: true }) ?? '', /--host/)
    assert.notEqual(remoteStartupError({ allowHosts: [], host: '127.0.0.1', remote: true }), null)
    assert.notEqual(remoteStartupError({ allowHosts: [], host: '' }), null)
  })

  it('an empty --host asks for an address, not for --remote (#474)', () => {
    const err = remoteStartupError({ allowHosts: [], host: '' }) ?? ''
    assert.match(err, /--host needs an address/)
    assert.doesNotMatch(err, /--remote/)
  })

  it('reads no environment variable, only the flags it is given (#474)', () => {
    const keys = ['AGENT_LENS_HOST', 'AGENT_LENS_REMOTE', 'HOST'] as const
    const saved = keys.map(k => process.env[k])
    try {
      for (const k of keys) process.env[k] = k === 'AGENT_LENS_REMOTE' ? '1' : '0.0.0.0'
      assert.equal(remoteStartupError({ allowHosts: [] }), null)
      assert.equal(remoteStartupError({ allowHosts: [], host: '127.0.0.1' }), null)
    } finally {
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
    }
  })

  it('an invalid --allow-host stops the start', () => {
    assert.match(remoteStartupError({ allowHosts: ['*.ts.net'] }) ?? '', /--allow-host/)
  })

  it('--allow-host needs --token-file; --token-file needs --allow-host and a path (#517)', () => {
    assert.match(remoteStartupError({ allowHosts: ['box.tail1234.ts.net'] }) ?? '', /--token-file/)
    assert.match(remoteStartupError({ allowHosts: [], tokenFile: '/tmp/t' }) ?? '', /--token-file[^]*--allow-host/)
    assert.match(remoteStartupError({ allowHosts: ['box.tail1234.ts.net'], tokenFile: '' }) ?? '', /--token-file needs a path/)
    assert.match(remoteStartupError({ allowHosts: ['box.tail1234.ts.net'], tokenFile: '  ' }) ?? '', /--token-file needs a path/)
    // A malformed name is still reported for what it is
    assert.match(remoteStartupError({ allowHosts: ['*.ts.net'], tokenFile: '/tmp/t' }) ?? '', /--allow-host: /)
  })

  it('a valid --allow-host is refused while token authentication is not shipped', () => {
    assert.equal(REMOTE_AUTH_AVAILABLE, false)
    assert.match(remoteStartupError({ allowHosts: ['box.tail1234.ts.net'] }) ?? '', /token/i)
  })
})

describe('gateRemoteRequest: POST /pair never kills the relay (#475)', () => {
  const TUNNEL = 'box.tail1234.ts.net'

  /** Anyone who reaches the tunnel can send POST /pair: a rejection of handlePair must never become an unhandled one. */
  async function pairWith(handlePair: RemoteAuth['handlePair'], requests = 1): Promise<{ status: number; body: string; unhandled: unknown[]; logs: string[] }> {
    const allowed = [TUNNEL]
    bindRemoteAuth(allowed, { handlePair, isPaired: () => false })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    // Every console channel: a line on any of them counts
    const logs: string[] = []
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
    for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    const server = http.createServer((req, res) => { if (!gateRemoteRequest(req, res, allowed, 'api')) res.writeHead(404).end() })
    const port = await listenLoopback(server, 0)
    try {
      let reply = { status: 0, body: '' }
      for (let i = 0; i < requests; i++) reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/pair', agent: false,
          headers: { Host: TUNNEL, Origin: `https://${TUNNEL}`, 'Content-Type': 'application/json' } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', c => { body += c })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.setTimeout(2000, () => req.destroy(new Error('no answer: the response was left open')))
        req.on('error', reject)
        req.end('{}')
      })
      // Let a dropped rejection surface before the listener goes away
      await new Promise(r => setTimeout(r, 50))
      return { ...reply, unhandled, logs }
    } finally {
      Object.assign(console, saved)
      process.off('unhandledRejection', onUnhandled)
      server.close()
    }
  }

  it('a handlePair that rejects before answering: the same 401 without detail, no unhandled rejection', async () => {
    const r = await pairWith(async () => { throw new Error('secret detail') })
    assert.deepEqual(r.unhandled, [], 'the rejection must be caught')
    assert.equal(r.status, 401)
    assert.equal(r.body, 'Unauthorized')
  })

  it('a handlePair that rejects after its headers: the response is ended, no unhandled rejection', async () => {
    const r = await pairWith(async (_req, res) => { res.writeHead(204); throw new Error('late') })
    assert.deepEqual(r.unhandled, [], 'the rejection must be caught')
    assert.equal(r.status, 204)
  })

  it('a handlePair that rejects leaves one fixed log line per interval, nothing of the request or the error', async () => {
    const SECRET = 'tok_0123456789abcdef secret detail from 203.0.113.7'
    const r = await pairWith(async () => { const e = new TypeError(SECRET); throw e }, 3)
    assert.deepEqual(r.unhandled, [], 'the rejection must be caught')
    assert.equal(r.status, 401)
    assert.equal(r.body, 'Unauthorized', 'the answer stays the uniform 401')
    assert.equal(r.logs.length, 1, `exactly one line for 3 failures in a row, got ${JSON.stringify(r.logs)}`)
    const line = r.logs[0]
    assert.match(line, /POST \/pair/, 'the line names the step')
    assert.match(line, /TypeError/, 'the line carries the error class')
    assert.ok(!line.includes('secret') && !line.includes('tok_') && !line.includes('203.0.113.7'), `no detail of the error: ${line}`)
    assert.ok(!line.includes(TUNNEL), `nothing of the request: ${line}`)
  })

  it('an error name that is not a plain identifier is not echoed into the log', async () => {
    const r = await pairWith(async () => { const e = new Error('x'); e.name = 'tok_\nforged line'; throw e })
    assert.equal(r.status, 401)
    assert.equal(r.logs.length, 1)
    assert.ok(!r.logs[0].includes('tok_') && !r.logs[0].includes('forged'), `the name is replaced: ${r.logs[0]}`)
  })
})
