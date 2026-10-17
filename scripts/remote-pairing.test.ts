/**
 * Remote pairing, step 2 of #241 (pure functions and the pairing object, no relay).
 *
 * A token of 256 bits is drawn at every start. The remote browser opens https://<tunnel>/#pair=<token> (a fragment:
 * never sent, never logged), the app posts it to POST /pair, and gets back an HttpOnly / Secure / SameSite=Strict
 * cookie. Every failure is the same 401 without detail.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { listenLoopback } from './server-hardening'
import {
  newPairingToken, tokensEqual, parsePairBody, readPairCookie, pairCookieHeader, writeTokenFile, pairingUrl, createRemotePairing,
  PAIR_COOKIE, REMOTE_PAIR_MAX_SESSIONS, REMOTE_PAIR_RATE_BURST,
} from './remote-pairing'

const TUNNEL = 'box.tail1234.ts.net'
const SECRET = /^[A-Za-z0-9_-]{43}$/

describe('newPairingToken (256 bits, drawn at every start)', () => {
  it('is 43 base64url characters (32 random bytes) and never repeats', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const t = newPairingToken()
      assert.match(t, SECRET)
      assert.equal(Buffer.from(t, 'base64url').length, 32)
      seen.add(t)
    }
    assert.equal(seen.size, 200)
  })
})

describe('tokensEqual (constant time)', () => {
  const t = newPairingToken()
  it('accepts the same token only', () => {
    assert.equal(tokensEqual(t, t), true)
    assert.equal(tokensEqual(t, `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`), false)
  })
  it('refuses another length, the empty string and a prefix without throwing', () => {
    for (const other of ['', t.slice(0, 42), `${t}x`, t.slice(0, 1), 'x'.repeat(10_000)]) assert.equal(tokensEqual(other, t), false, other.slice(0, 50))
  })
  it('never compares the secrets with === or a length shortcut: both sides are hashed, then crypto.timingSafeEqual', () => {
    const src = fs.readFileSync(path.join(__dirname, 'remote-pairing.ts'), 'utf8')
    const body = /export function tokensEqual[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    assert.ok(body, 'tokensEqual not found')
    assert.match(body, /timingSafeEqual\(/)
    assert.match(body, /createHash\('sha256'\)/)
    assert.doesNotMatch(body, /===|!==|==|!=|\.length|startsWith|localeCompare|\.compare\(/)
  })
})

describe('parsePairBody (strict JSON: {"token": <43 base64url>})', () => {
  const t = newPairingToken()
  it('returns the token', () => assert.equal(parsePairBody(JSON.stringify({ token: t })), t))
  it('refuses anything else', () => {
    for (const bad of ['', 'null', '[]', '"x"', t, `{"token":"${t}","x":1}`, '{"token":1}', '{"token":""}', `{"tok":"${t}"}`,
      `{"token":"${t}x"}`, `{"token":"${t.slice(1)}"}`, '{"token":"' + '='.repeat(43) + '"}', '{not json']) {
      assert.equal(parsePairBody(bad), null, bad)
    }
  })
})

describe('readPairCookie (exactly one well-formed pairing cookie)', () => {
  const sid = newPairingToken()
  it('reads the cookie among others', () => {
    assert.equal(readPairCookie(`${PAIR_COOKIE}=${sid}`), sid)
    assert.equal(readPairCookie(`theme=dark; ${PAIR_COOKIE}=${sid}; other=1`), sid)
  })
  it('refuses a missing, duplicated, malformed or quoted cookie', () => {
    for (const bad of [undefined, '', 'theme=dark', `${PAIR_COOKIE}=`, `${PAIR_COOKIE}=${sid}x`, `${PAIR_COOKIE}=${sid.slice(1)}`,
      `${PAIR_COOKIE}="${sid}"`, `${PAIR_COOKIE}=${sid}; ${PAIR_COOKIE}=${sid}`, `${PAIR_COOKIE}=${sid.slice(0, 40)}%2F%2F`,
      `${PAIR_COOKIE} = ${sid}`, `x${PAIR_COOKIE}=${sid}`, `${PAIR_COOKIE.toLowerCase()}=${sid}`, 'x'.repeat(5000)]) {
      assert.equal(readPairCookie(bad), null, String(bad).slice(0, 80))
    }
    assert.equal(readPairCookie([`${PAIR_COOKIE}=${sid}`, `${PAIR_COOKIE}=${sid}`]), null)
  })
})

describe('pairCookieHeader', () => {
  it('is __Host- prefixed, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain, bounded lifetime', () => {
    const sid = newPairingToken()
    const h = pairCookieHeader(sid, 3600)
    assert.ok(PAIR_COOKIE.startsWith('__Host-'))
    assert.ok(h.startsWith(`${PAIR_COOKIE}=${sid};`), h)
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) assert.ok(h.split('; ').includes(attr), `${attr} in ${h}`)
    assert.doesNotMatch(h, /Domain=/i)
  })
})

describe('pairingUrl', () => {
  it('carries the token in the fragment only (never sent to a server, never in an access log)', () => {
    const t = newPairingToken()
    const u = new URL(pairingUrl(TUNNEL, t))
    assert.equal(u.protocol, 'https:')
    assert.equal(u.host, TUNNEL)
    assert.equal(u.pathname, '/')
    assert.equal(u.search, '')
    assert.equal(u.hash, `#pair=${t}`)
  })
})

describe('writeTokenFile (--token-file, mode 0600)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'af-token-')); dirs.push(d); return d }

  it('writes the token in a file readable by its owner only, even over a wider existing file', { skip: process.platform === 'win32' }, () => {
    const d = tmp()
    const file = path.join(d, 'token')
    fs.writeFileSync(file, 'old', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    const t = newPairingToken()
    writeTokenFile(file, t)
    assert.equal(fs.readFileSync(file, 'utf8').trim(), t)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(d), ['token'], 'no temporary file left behind')
  })

  it('replaces a symlink instead of writing through it', { skip: process.platform === 'win32' }, () => {
    const d = tmp()
    const target = path.join(d, 'elsewhere')
    fs.writeFileSync(target, 'keep')
    const file = path.join(d, 'token')
    fs.symlinkSync(target, file)
    writeTokenFile(file, newPairingToken())
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
  })

  it('throws when the folder does not exist (the start must stop, never run with a token nobody can read)', () => {
    assert.throws(() => writeTokenFile(path.join(tmp(), 'missing', 'token'), newPairingToken()))
  })
})

describe('createRemotePairing (POST /pair, cookie check, caps)', () => {
  const token = newPairingToken()
  interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

  async function withServer(pairing: ReturnType<typeof createRemotePairing>, fn: (send: (opts: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string; path?: string }) => Promise<Reply>) => Promise<void>) {
    const server = http.createServer((req, res) => {
      if (req.url === '/pair') return void pairing.handlePair(req, res)
      res.writeHead(pairing.isPaired(req) ? 200 : 401).end()
    })
    const port = await listenLoopback(server, 0)
    const send = (o: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string; path?: string }) => new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/pair', agent: false,
        headers: { Host: TUNNEL, 'Content-Type': 'application/json', ...o.headers } }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end(o.body)
    })
    try { await fn(send) } finally { server.close() }
  }
  const cookieOf = (r: Reply) => String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]

  it('the right token gets a cookie that opens isPaired; the cookie is not the token', async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL] })
    await withServer(pairing, async send => {
      const r = await send({ body: JSON.stringify({ token }) })
      assert.equal(r.status, 204, r.body)
      assert.equal(r.headers['cache-control'], 'no-store')
      const cookie = cookieOf(r)
      assert.match(cookie, new RegExp(`^${PAIR_COOKIE}=[A-Za-z0-9_-]{43}$`))
      assert.ok(!cookie.includes(token), 'the cookie must not carry the token')
      assert.equal((await send({ method: 'GET', path: '/x', headers: { Cookie: cookie } })).status, 200)
      assert.equal(pairing.pairedCount(), 1)
    })
  })

  it('wrong token, missing token, malformed body, wrong Content-Type, oversized body: the same 401 without detail, no cookie', async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL], rate: { burst: 100, perSecond: 100 } })
    await withServer(pairing, async send => {
      const other = newPairingToken()
      const cases: Array<{ headers?: http.OutgoingHttpHeaders; body?: string }> = [
        { body: JSON.stringify({ token: other }) }, { body: '' }, { body: '{}' }, { body: '{"token":null}' }, { body: token },
        { body: JSON.stringify({ token }), headers: { 'Content-Type': 'text/plain' } }, { body: JSON.stringify({ token: token + 'x'.repeat(4000) }) },
      ]
      const bodies = new Set<string>()
      for (const c of cases) {
        const r = await send(c)
        assert.equal(r.status, 401, JSON.stringify(c).slice(0, 80))
        assert.equal(r.headers['set-cookie'], undefined)
        bodies.add(r.body)
      }
      assert.deepEqual([...bodies], ['Unauthorized'], 'one body for every failure: nothing tells what was wrong')
      assert.equal(pairing.pairedCount(), 0)
    })
  })

  it('a missing, forged or malformed cookie does not open isPaired', async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL] })
    await withServer(pairing, async send => {
      for (const cookie of [undefined, `${PAIR_COOKIE}=${newPairingToken()}`, `${PAIR_COOKIE}=${token}`, `${PAIR_COOKIE}=bad`, 'a=b']) {
        const headers = cookie ? { Cookie: cookie } : {}
        assert.equal((await send({ method: 'GET', path: '/x', headers })).status, 401, String(cookie))
      }
    })
  })

  it('refuses another method (405), another Host, a loopback Host or another origin (403)', async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL], rate: { burst: 100, perSecond: 100 } })
    await withServer(pairing, async send => {
      assert.equal((await send({ method: 'GET' })).status, 405)
      for (const headers of [{ Host: 'evil.example' }, { Host: '127.0.0.1' }, { Origin: 'https://evil.example' }, { Origin: `http://${TUNNEL}` }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const r = await send({ headers, body: JSON.stringify({ token }) })
        assert.equal(r.status, 403, JSON.stringify(headers))
        assert.equal(r.headers['set-cookie'], undefined)
      }
    })
  })

  it(`has its own rate limiter (burst ${REMOTE_PAIR_RATE_BURST}), keyed on the tunnel name, not on the User-Agent`, async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL] })
    await withServer(pairing, async send => {
      const statuses: number[] = []
      for (let i = 0; i < REMOTE_PAIR_RATE_BURST + 2; i++) statuses.push((await send({ body: '{}', headers: { 'User-Agent': `ua-${i}` } })).status)
      assert.deepEqual(statuses.slice(0, REMOTE_PAIR_RATE_BURST), Array(REMOTE_PAIR_RATE_BURST).fill(401))
      assert.equal(statuses[REMOTE_PAIR_RATE_BURST], 429)
      // Even the right token waits: a brute force cannot outpace the bucket
      assert.equal((await send({ body: JSON.stringify({ token }) })).status, 429)
    })
  })

  it(`caps the paired clients at ${REMOTE_PAIR_MAX_SESSIONS}: past it, 503 and no cookie`, async () => {
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL], rate: { burst: 100, perSecond: 100 } })
    await withServer(pairing, async send => {
      for (let i = 0; i < REMOTE_PAIR_MAX_SESSIONS; i++) assert.equal((await send({ body: JSON.stringify({ token }) })).status, 204)
      const extra = await send({ body: JSON.stringify({ token }) })
      assert.equal(extra.status, 503)
      assert.equal(extra.headers['set-cookie'], undefined)
      assert.equal(pairing.pairedCount(), REMOTE_PAIR_MAX_SESSIONS)
    })
  })

  it('a pairing expires after its lifetime, and frees its slot', async () => {
    let now = 1_000_000
    const pairing = createRemotePairing({ token, allowedHosts: [TUNNEL], ttlMs: 1000, maxSessions: 1, now: () => now })
    await withServer(pairing, async send => {
      const cookie = cookieOf(await send({ body: JSON.stringify({ token }) }))
      assert.equal((await send({ method: 'GET', path: '/x', headers: { Cookie: cookie } })).status, 200)
      now += 1001
      assert.equal((await send({ method: 'GET', path: '/x', headers: { Cookie: cookie } })).status, 401)
      assert.equal((await send({ body: JSON.stringify({ token }) })).status, 204, 'the expired slot is free again')
    })
  })

  it('refuses an injected token that is not 256 bits of base64url', () => {
    for (const bad of ['', 'short', 'x'.repeat(43) + '=', '+'.repeat(43)]) assert.throws(() => createRemotePairing({ token: bad, allowedHosts: [TUNNEL] }), bad)
  })
})
