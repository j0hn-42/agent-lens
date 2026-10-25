/**
 * Scope of the relay at run time (#291): this workspace <-> every workspace, without a restart.
 *  - the flag / env var is only the INITIAL value;
 *  - widening adds the sessions of the other workspaces, narrowing removes them and releases their watchers;
 *  - POST /scope goes through the same guard chain as the other routes (loopback, cross-site, rate limit)
 *    and validates its input strictly;
 *  - GET /status reports the scope the scan really uses.
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeProjectDirName } from '../extension/src/project-dir'
import { ACTIVE_SESSION_AGE_S, RELAY_SCOPE_BODY_MAX_BYTES } from '../extension/src/constants'
import { isStatusPath, isScopePath } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-scope-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let ownDir = ''
let otherDir = ''
let uaCounter = 0

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

/** One request; each gets its own User-Agent so it has its own rate-limit bucket unless `ua` is given. */
function request(method: string, urlPath: string, opts: { body?: string; headers?: http.OutgoingHttpHeaders; ua?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { 'User-Agent': opts.ua ?? `scope-test-${++uaCounter}`, ...opts.headers }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

function postScope(value: unknown, extra: { headers?: http.OutgoingHttpHeaders; ua?: string } = {}): Promise<Reply> {
  return request('POST', '/scope', {
    body: typeof value === 'string' ? value : JSON.stringify(value),
    headers: { 'Content-Type': 'application/json', ...extra.headers },
    ua: extra.ua,
  })
}

const status = async () => JSON.parse((await request('GET', '/status')).body)

interface Sse { messages: any[]; close: () => void; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }

function openSse(): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{ pred: (m: any) => boolean; done: (m: any) => void }> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (!frame.startsWith('data: ')) continue
          let m: any
          try { m = JSON.parse(frame.slice(6)) } catch { continue }
          messages.push(m)
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m) }
        }
      })
      resolve({
        messages,
        close: () => req.destroy(),
        waitFor: (pred, ms = 3000) => {
          const seen = messages.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('timed out waiting for an SSE message')), ms)
            waiters.push({ pred, done: m => { clearTimeout(t); res2(m) } })
          })
        },
      })
    })
    req.on('error', reject)
  })
}

/** Session ids a FRESH client is told about (session-list), and the session ids of the events it is replayed. */
async function snapshot(): Promise<{ ids: string[]; replayed: Set<string> }> {
  const sse = await openSse()
  try {
    // The cursor follows the list and the whole replay; the client gets them once the attach ended, however long
    // it took (#651), so the snapshot waits for it instead of a fixed 250 ms (#440)
    await sse.waitFor(m => m.type === 'relay-cursor', 8000)
    const list = sse.messages.find(m => m.type === 'session-list')
    const replayed = new Set<string>()
    for (const m of sse.messages) {
      if (m.type === 'agent-event-batch') for (const e of m.events) if (e.sessionId) replayed.add(e.sessionId)
    }
    return { ids: ((list?.sessions ?? []) as Array<{ id: string }>).map(s => s.id).sort(), replayed }
  } finally { sse.close() }
}

describe('relay scope at run time (#291)', () => {
  let base: { watchedSessions: number; wakeWatchers: number }

  before(async () => {
    const projects = path.join(fakeHome, '.claude', 'projects')
    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    ownDir = path.join(projects, encodeProjectDirName(fs.realpathSync(ws)))
    otherDir = path.join(projects, '-some-other-workspace')
    fs.mkdirSync(ownDir, { recursive: true })
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(ownDir, 'own-session.jsonl'), line)
    fs.writeFileSync(path.join(otherDir, 'other-session.jsonl'), line)
    // A finished session with a subagents folder: it gets a wake-up watcher (released when the scope narrows)
    const idle = path.join(otherDir, 'idle-session.jsonl')
    fs.writeFileSync(idle, line)
    fs.mkdirSync(path.join(otherDir, 'idle-session', 'subagents'), { recursive: true })
    const old = new Date(Date.now() - (ACTIVE_SESSION_AGE_S + 600) * 1000)
    fs.utimesSync(idle, old, old)

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (isStatusPath(req.url)) return relay.handleStatus(req, res)
      if (isScopePath(req.url)) return relay.handleScope(req, res)
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
    base = relay.debugState()
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('starts on this workspace only, and says so in /status', async () => {
    assert.equal((await status()).allWorkspaces, false)
    assert.deepEqual((await snapshot()).ids, ['own-session'])
  })

  it('POST /scope all widens the scan at once: the other workspace appears, connected clients are told', async () => {
    const sse = await openSse()
    try {
      const r = await postScope({ scope: 'all' })
      assert.equal(r.status, 200, r.body)
      assert.match(String(r.headers['content-type']), /application\/json/)
      assert.deepEqual(JSON.parse(r.body), { scope: 'all', allWorkspaces: true })
      assert.equal((await status()).allWorkspaces, true, 'the displayed state is the scanned state')
      const started = await sse.waitFor(m => m.type === 'session-started' && m.session?.id === 'other-session')
      assert.equal(started.session.id, 'other-session')
    } finally { sse.close() }
    assert.deepEqual((await snapshot()).ids, ['other-session', 'own-session'])
    const during = relay.debugState()
    assert.ok(during.watchedSessions > base.watchedSessions)
    assert.ok(during.wakeWatchers > base.wakeWatchers)
  })

  it('POST /scope workspace narrows it: sessions end, their replay is dropped, watchers are released', async () => {
    const sse = await openSse()
    try {
      const r = await postScope({ scope: 'workspace' })
      assert.equal(r.status, 200, r.body)
      assert.deepEqual(JSON.parse(r.body), { scope: 'workspace', allWorkspaces: false })
      const ended = await sse.waitFor(m => m.type === 'session-ended' && m.sessionId === 'other-session')
      assert.equal(ended.sessionId, 'other-session')
    } finally { sse.close() }
    assert.equal((await status()).allWorkspaces, false)
    const snap = await snapshot()
    assert.deepEqual(snap.ids, ['own-session'])
    assert.ok(!snap.replayed.has('other-session'), 'no buffered event of the left workspace is replayed')
    const after = relay.debugState()
    assert.equal(after.watchedSessions, base.watchedSessions)
    assert.equal(after.wakeWatchers, base.wakeWatchers)
  })

  it('workspace -> all -> workspace, repeated, leaks no watcher', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await postScope({ scope: 'all' })).status, 200)
      assert.equal(relay.debugState().watchedSessions > base.watchedSessions, true, `cycle ${i}: widened`)
      assert.equal((await postScope({ scope: 'workspace' })).status, 200)
      const s = relay.debugState()
      assert.equal(s.watchedSessions, base.watchedSessions, `cycle ${i}: sessions released`)
      assert.equal(s.wakeWatchers, base.wakeWatchers, `cycle ${i}: wake-up watchers released`)
    }
    assert.equal(relay.debugState().scanTimerActive, false, 'no timer left without a client')
  })

  it('setting the scope already in force changes nothing and announces nothing', async () => {
    assert.equal((await postScope({ scope: 'all' })).status, 200)
    const sse = await openSse()
    try {
      await new Promise(r => setTimeout(r, 200))
      const before = sse.messages.length
      assert.equal((await postScope({ scope: 'all' })).status, 200)
      await new Promise(r => setTimeout(r, 200))
      assert.equal(sse.messages.filter(m => m.type === 'session-started').length, 0, 'no session is announced twice')
      assert.equal(sse.messages.length, before)
    } finally { sse.close() }
    assert.equal((await postScope({ scope: 'workspace' })).status, 200)
  })

  describe('POST /scope guards', () => {
    it('refuses anything but a strict {"scope":"workspace"|"all"} with 400, and keeps the scope', async () => {
      const bad: unknown[] = [
        '', 'not json', '[]', 'null', '"all"', '{}', '{"scope":"ALL"}', '{"scope":"project"}', '{"scope":""}',
        '{"scope":["all"]}', '{"scope":true}', '{"scope":"all","extra":1}', '{"scope":"all","scope":"workspace"}x',
        '{"allWorkspaces":true}', '{"scope":"../../etc"}', '{"scope":"/home/user"}', '{"__proto__":{"scope":"all"}}',
      ]
      for (const b of bad) {
        const r = await postScope(b)
        assert.equal(r.status, 400, `body ${JSON.stringify(b)} -> ${r.status}`)
      }
      assert.equal((await status()).allWorkspaces, false, 'an invalid request never changes the scope')
    })

    it('requires Content-Type application/json (415) and caps the body (413)', async () => {
      const noType = await request('POST', '/scope', { body: '{"scope":"all"}' })
      assert.equal(noType.status, 415)
      const form = await request('POST', '/scope', { body: 'scope=all', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      assert.equal(form.status, 415)
      const plain = await request('POST', '/scope', { body: '{"scope":"all"}', headers: { 'Content-Type': 'text/plain' } })
      assert.equal(plain.status, 415, 'text/plain is a CORS-safelisted type: it must not be accepted')
      const big = await postScope(`{"scope":"all","pad":"${'x'.repeat(RELAY_SCOPE_BODY_MAX_BYTES + 10)}"}`)
      assert.equal(big.status, 413)
      assert.equal((await status()).allWorkspaces, false)
    })

    it('accepts application/json with a charset', async () => {
      const r = await postScope({ scope: 'workspace' }, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
      assert.equal(r.status, 200, r.body)
    })

    it('answers 405 (Allow: POST) to every other method', async () => {
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
        const r = await request(method, '/scope', { body: method === 'GET' || method === 'HEAD' ? undefined : '{"scope":"all"}', headers: { 'Content-Type': 'application/json' } })
        assert.equal(r.status, 405, method)
        assert.equal(r.headers.allow, 'POST')
      }
      assert.equal((await status()).allWorkspaces, false)
    })

    it('answers 403 to a foreign Host header (DNS rebinding)', async () => {
      const r = await postScope({ scope: 'all' }, { headers: { Host: 'evil.example' } })
      assert.equal(r.status, 403)
      assert.equal((await status()).allWorkspaces, false)
    })

    it('answers 403 to another site (Origin or Sec-Fetch-Site), and lets the relay own origin through', async () => {
      for (const headers of [
        { Origin: 'https://evil.example' },
        { Origin: 'null' },
        { Origin: 'http://localhost:9999' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ]) {
        const r = await postScope({ scope: 'all' }, { headers })
        assert.equal(r.status, 403, JSON.stringify(headers))
      }
      assert.equal((await status()).allWorkspaces, false, 'no cross-site request changed the scope')
      const same = await postScope({ scope: 'all' }, { headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } })
      assert.equal(same.status, 200, same.body)
      assert.equal((await postScope({ scope: 'workspace' })).status, 200)
    })

    it('carries the strict API headers on success and on refusal', async () => {
      for (const r of [await postScope({ scope: 'workspace' }), await postScope('nope'), await request('GET', '/scope')]) {
        assert.match(String(r.headers['content-security-policy']), /default-src 'none'/)
        assert.equal(r.headers['cache-control'], 'no-store')
        assert.equal(r.headers['x-content-type-options'], 'nosniff')
      }
    })

    it('rate-limits a flood with 429 (one client), without starving another client', async () => {
      const statuses: number[] = []
      for (let i = 0; i < 40; i++) statuses.push((await postScope({ scope: 'workspace' }, { ua: 'flooder' })).status)
      assert.ok(statuses.includes(429), `expected a 429: ${statuses.join(',')}`)
      assert.equal((await postScope({ scope: 'workspace' }, { ua: 'someone-else' })).status, 200)
    })
  })

  it('/status carries the discovery ceilings, none of them reached here', async () => {
    const s = await status()
    assert.deepEqual(s.skippedSessions, { watchLimit: 0, sizeLimit: 0, fileLimit: 0 })
    assert.deepEqual(s.discovery, { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 })
  })
})
