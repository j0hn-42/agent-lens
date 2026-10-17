/**
 * POST /quota (#467) : la route seule, sur un vrai serveur HTTP loopback, avec un vrai store.
 * Chaque refus laisse le store inchangé.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { RELAY_QUOTA_BODY_MAX_BYTES } from '../../extension/src/constants'
import { createQuotaStore } from '../quota'
import { createQuotaRoute } from './quota'

const VALID = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1800000000 } } })
const JSON_HEADERS = { 'Content-Type': 'application/json' }

let server: http.Server
let port = 0
const store = createQuotaStore(() => 1000)
let accepted = 0

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(method: string, opts: { body?: string; headers?: http.OutgoingHttpHeaders; path?: string; hold?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/quota', method, agent: false, headers: opts.headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    // hold : le corps n'est jamais terminé (client lent)
    if (!opts.hold) req.end()
  })
}

const post = (body: string, headers: http.OutgoingHttpHeaders = JSON_HEADERS, path?: string) => request('POST', { body, headers, path })

describe('POST /quota (#467)', () => {
  before(async () => {
    const generous = createQuotaRoute({ limiter: new KeyedRateLimiter(1000, 1000, 10), accept: body => { accepted++; return store.accept(body) } })
    const strict = createQuotaRoute({ limiter: new KeyedRateLimiter(2, 0.0001, 10), accept: body => { accepted++; return store.accept(body) } })
    server = http.createServer((req, res) => { void (req.url?.startsWith('/strict') ? strict : generous)(req, res) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { server.close() })

  it('200 et corps {} avec un corps valide ; le store reçoit les fenêtres', async () => {
    const r = await post(VALID)
    assert.equal(r.status, 200, r.body)
    assert.equal(r.body, '{}')
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.deepEqual(store.current(), { fiveHour: { usedPercentage: 42, resetsAt: 1800000000 }, sevenDay: null, receivedAt: 1000 })
  })

  it('accepte application/json avec charset utf-8', async () => {
    assert.equal((await post(VALID, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200)
  })

  describe('chaque refus laisse le store inchangé', () => {
    const refused: Array<[string, () => Promise<Reply>, number]> = [
      ['415 sur text/plain', () => post(VALID, { 'Content-Type': 'text/plain' }), 415],
      ['415 sans Content-Type', () => post(VALID, {}), 415],
      ['413 au-dessus du plafond', () => post(JSON.stringify({ rate_limits: { pad: 'x'.repeat(RELAY_QUOTA_BODY_MAX_BYTES) } }), JSON_HEADERS), 413],
      ['400 JSON invalide', () => post('{nope', JSON_HEADERS), 400],
      ['400 pourcentage hors plage', () => post(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 101, resets_at: 1800000000 } } })), 400],
      ['400 racine avec une clé en plus', () => post(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } }, extra: 1 })), 400],
      ['405 en GET', () => request('GET'), 405],
      ['403 depuis un autre site (Origin)', () => post(VALID, { ...JSON_HEADERS, Origin: 'https://evil.example' }), 403],
      ['403 depuis un autre site (Sec-Fetch-Site)', () => post(VALID, { ...JSON_HEADERS, 'Sec-Fetch-Site': 'cross-site' }), 403],
      ['403 si le Host n\'est pas loopback', () => post(VALID, { ...JSON_HEADERS, Host: 'evil.example' }), 403],
    ]
    for (const [name, run, expected] of refused) {
      it(name, async () => {
        const snapshot = store.current()
        const calls = accepted
        assert.equal((await run()).status, expected)
        assert.equal(store.current(), snapshot)
        assert.equal(accepted, calls)
      })
    }

    it('408 sur un corps lent, sans écrire dans le store', async () => {
      const snapshot = store.current()
      const calls = accepted
      const r = await request('POST', { body: '{"rate_limits":', headers: JSON_HEADERS, hold: true })
      assert.equal(r.status, 408)
      assert.equal(store.current(), snapshot)
      assert.equal(accepted, calls)
    })

    it('429 au-delà de la rafale', async () => {
      const snapshot = store.current()
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) statuses.push((await post(VALID, JSON_HEADERS, '/strict')).status)
      assert.deepEqual(statuses, [200, 200, 429, 429])
      assert.notEqual(store.current(), snapshot, 'les deux premières requêtes ont été acceptées')
      const after = store.current()
      assert.equal((await post(VALID, JSON_HEADERS, '/strict')).status, 429)
      assert.equal(store.current(), after)
    })
  })
})
