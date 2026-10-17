/**
 * Quota d'abonnement dans le relais (#467) : POST /quota -> message SSE `quota` chez les clients locaux, rejeu
 * du dernier état à la connexion (avant le rejeu d'événements), et jamais vers un hôte de tunnel.
 * La route est montée ici sur un serveur de test pour isoler la diffusion ; en production elle est servie par le
 * HookServer (extension/test/hook-server-quota.test.ts, scripts/statusline-e2e.test.ts).
 * Le relais est un singleton par processus : fichier de test dédié.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeProjectDirName } from '../extension/src/project-dir'
import { isQuotaPath } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-quota-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const TUNNEL = 'box.tail1234.ts.net'
const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'
const body = (used: number) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: used, resets_at: 1800000000 } } })

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let uaCounter = 0

function postQuota(text: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/quota', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'User-Agent': `quota-test-${++uaCounter}` },
    }, res => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }))
    })
    req.on('error', reject)
    req.end(text)
  })
}

interface Sse { messages: any[]; close: () => void; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }

function openSse(headers: http.OutgoingHttpHeaders = {}): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{ pred: (m: any) => boolean; done: (m: any) => void }> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, res => {
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

const settle = () => new Promise(r => setTimeout(r, 300))

describe('relay quota (#467)', () => {
  before(async () => {
    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    const dir = path.join(fakeHome, '.claude', 'projects', encodeProjectDirName(fs.realpathSync(ws)))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'own-session.jsonl'), line)
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', allowedHosts: [TUNNEL] })
    server = http.createServer((req, res) => {
      if (isQuotaPath(req.url)) return relay.handleQuota(req, res)
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('un client sans quota connu ne reçoit aucun message quota', async () => {
    const sse = await openSse()
    try {
      await settle()
      assert.equal(sse.messages.some(m => m.type === 'quota'), false)
    } finally { sse.close() }
  })

  it('un POST /quota valide produit un message SSE quota chez un client connecté', async () => {
    const sse = await openSse()
    const remote = await openSse({ Host: TUNNEL })
    try {
      const r = await postQuota(body(30))
      assert.equal(r.status, 200, r.body)
      assert.equal(r.body, '{}')
      const m = await sse.waitFor(x => x.type === 'quota')
      assert.deepEqual(Object.keys(m.quota).sort(), ['fiveHour', 'receivedAt', 'sevenDay'])
      assert.deepEqual(m.quota.fiveHour, { usedPercentage: 30, resetsAt: 1800000000 })
      assert.equal(m.quota.sevenDay, null)
      assert.equal(typeof m.quota.receivedAt, 'number')
      await settle()
      assert.equal(remote.messages.some(x => x.type === 'quota'), false, 'un hôte de tunnel ne reçoit jamais le quota')
    } finally { sse.close(); remote.close() }
  })

  it('un client qui se connecte ensuite reçoit le dernier quota, après la liste de sessions et avant le rejeu', async () => {
    assert.equal((await postQuota(body(55))).status, 200)
    const sse = await openSse()
    try {
      const m = await sse.waitFor(x => x.type === 'quota')
      assert.equal(m.quota.fiveHour.usedPercentage, 55, 'le dernier état, pas le premier')
      await settle()
      const types = sse.messages.map(x => x.type)
      assert.equal(types.filter(t => t === 'quota').length, 1)
      const quotaAt = types.indexOf('quota')
      assert.ok(types.indexOf('session-list') < quotaAt, 'après la liste de sessions')
      for (const later of ['event-loss', 'agent-event-batch']) {
        const at = types.indexOf(later)
        if (at >= 0) assert.ok(quotaAt < at, `avant ${later}`)
      }
    } finally { sse.close() }
  })

  it('un client arrivé par un hôte de tunnel ne reçoit jamais le quota, ni en direct ni au rejeu', async () => {
    const remote = await openSse({ Host: TUNNEL })
    try {
      assert.equal((await postQuota(body(60))).status, 200)
      await settle()
      assert.equal(remote.messages.some(x => x.type === 'quota'), false)
    } finally { remote.close() }
  })

  it('un corps refusé ne diffuse rien', async () => {
    const sse = await openSse()
    try {
      await sse.waitFor(x => x.type === 'quota')
      const before = sse.messages.filter(x => x.type === 'quota').length
      assert.equal((await postQuota('{"rate_limits":{"five_hour":{"used_percentage":500,"resets_at":1}}}')).status, 400)
      await settle()
      assert.equal(sse.messages.filter(x => x.type === 'quota').length, before)
    } finally { sse.close() }
  })
})
