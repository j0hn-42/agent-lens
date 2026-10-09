/**
 * guardedRoute : l'enchaînement de gardes (loopback/Host -> Origin -> méthode -> débit) testé seul,
 * sans lancer le relais, sur un vrai serveur HTTP loopback.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { guardedRoute, sendJson } from './guard'

let server: http.Server
let port = 0
let calls = 0

function request(method: string, headers: http.OutgoingHttpHeaders = {}, pathName = '/guarded'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, agent: false, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('guardedRoute', () => {
  before(async () => {
    const open = guardedRoute({ limiter: new KeyedRateLimiter(1000, 1000, 10) }, (req, res) => { calls++; sendJson(req, res, 200, { ok: true }) })
    const strict = guardedRoute({ limiter: new KeyedRateLimiter(2, 0.0001, 10), rejectCrossOrigin: true }, (req, res) => { calls++; sendJson(req, res, 200, { ok: true }) })
    server = http.createServer((req, res) => { void (req.url?.startsWith('/strict') ? strict : open)(req, res) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { server.close() })

  it('laisse passer GET et HEAD (HEAD sans corps) avec les en-têtes de sécurité', async () => {
    const get = await request('GET')
    assert.equal(get.status, 200)
    assert.equal(get.body, '{"ok":true}')
    assert.equal(get.headers['x-content-type-options'], 'nosniff')
    assert.ok(get.headers['content-security-policy'])
    const head = await request('HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
  })

  it('403 si le Host n\'est pas loopback, sans appeler le handler', async () => {
    const before = calls
    const r = await request('GET', { Host: 'evil.example:80' })
    assert.equal(r.status, 403)
    assert.equal(r.body, 'Forbidden')
    assert.equal(calls, before)
  })

  it('405 avec Allow pour une autre méthode', async () => {
    const r = await request('POST')
    assert.equal(r.status, 405)
    assert.equal(r.headers.allow, 'GET, HEAD')
    assert.equal(r.body, 'Method not allowed')
  })

  it('rejectCrossOrigin : 403 pour un autre site, avant le contrôle de méthode', async () => {
    const cross = await request('GET', { 'Sec-Fetch-Site': 'cross-site' }, '/strict')
    assert.equal(cross.status, 403)
    const crossPost = await request('POST', { Origin: 'https://evil.example' }, '/strict')
    assert.equal(crossPost.status, 403)
  })

  it('429 avec Retry-After quand le limiteur est vide', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await request('GET', {}, '/strict')).status)
    assert.deepEqual(statuses.slice(0, 2), [200, 200])
    assert.equal(statuses[3], 429)
    const limited = await request('GET', {}, '/strict')
    assert.equal(limited.headers['retry-after'], '1')
  })
})
