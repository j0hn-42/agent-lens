/**
 * GET /issue-links?scope=session&session=<id> (#228): open PRs by branch with their checks and issues without an
 * agent, for the project of a session. Same guards, cache and gh budget as the role query; the route is tested alone.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { createIssueLinksRoute } from './routes/issue-links'
import { KeyedRateLimiter } from '../extension/src/hook-guards'
import type { SessionWork } from '../extension/src/session-work'

const work: SessionWork = {
  repo: 'https://github.com/o/r',
  prs: [{ number: 5, title: 'p', url: 'https://github.com/o/r/pull/5', branch: 'feat/x', checks: { state: 'passing', total: 2, failing: 0, pending: 0 } }],
  issues: [{ number: 9, title: 'i', url: 'https://github.com/o/r/issues/9' }],
  prsTruncated: false, issuesTruncated: false,
}

let server: http.Server
let port = 0
let mode: 'ok' | 'fail' | 'norepo' = 'ok'
const workCwds: Array<string | undefined> = []
const roleCalls: string[] = []

function get(urlPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    }).on('error', reject)
  })
}

describe('GET /issue-links?scope=session', () => {
  before(async () => {
    const route = createIssueLinksRoute({
      limiter: new KeyedRateLimiter(1000, 1000, 100),
      allWorkspaces: true,
      cwdOf: id => (id === 'known' ? '/proj' : id === 'norepo' ? '/bare' : undefined),
      probe: async role => { roleCalls.push(role); return [] },
      workProbe: async cwd => {
        workCwds.push(cwd)
        if (mode === 'fail') throw new Error('gh missing')
        if (mode === 'norepo') return { ...work, repo: null, prs: [], issues: [] }
        return work
      },
    })
    server = http.createServer((req, res) => { void route(req, res) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  after(() => { server.close() })

  it('answers the work of the project of a known session, scoped to its cwd, with strict headers', async () => {
    const r = await get('/issue-links?scope=session&session=known')
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse(r.body), { scope: 'session', session: 'known', ...work })
    assert.deepEqual(workCwds, ['/proj'])
    assert.deepEqual(roleCalls, [], 'no role query was run')
  })

  it('caches the work of a project: a repeated request does not run gh again', async () => {
    workCwds.length = 0
    await get('/issue-links?scope=session&session=known')
    assert.deepEqual(workCwds, [])
  })

  it('a session of an unknown project is 404: the relay\'s own repository would be another project\'s work', async () => {
    workCwds.length = 0
    const r = await get('/issue-links?scope=session&session=stranger')
    assert.equal(r.status, 404)
    assert.deepEqual(workCwds, [])
  })

  it('a project without GitHub repository is a true "no repository" (repo null), cached', async () => {
    mode = 'norepo'
    const r = await get('/issue-links?scope=session&session=norepo')
    mode = 'ok'
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.equal(body.repo, null)
    assert.deepEqual(body.prs, [])
    workCwds.length = 0
    await get('/issue-links?scope=session&session=norepo')
    assert.deepEqual(workCwds, [])
  })

  it('answers 502 with Retry-After when gh fails and does not cache the failure', async () => {
    // a second known cwd so the previous cache entry does not hide the probe
    const route = createIssueLinksRoute({
      limiter: new KeyedRateLimiter(1000, 1000, 100), allWorkspaces: false, cwdOf: () => '/other',
      probe: async () => [],
      workProbe: async () => { if (mode === 'fail') throw new Error('x'); return work },
    })
    const s = http.createServer((req, res) => { void route(req, res) })
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
    const p = (s.address() as { port: number }).port
    const call = () => new Promise<{ status: number; body: string; retry?: string }>(resolve => {
      http.get({ host: '127.0.0.1', port: p, path: '/issue-links?scope=session&session=any', agent: false }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, retry: String(res.headers['retry-after']) }))
      })
    })
    mode = 'fail'
    const failed = await call()
    mode = 'ok'
    assert.equal(failed.status, 502)
    assert.match(failed.retry ?? '', /^\d+$/)
    assert.ok(!failed.body.includes('"prs"'))
    assert.equal((await call()).status, 200, 'the failure was not cached')
    s.close()
  })

  it('rejects a missing or malformed session, a role mixed in, and an unknown scope with 400', async () => {
    for (const q of [
      '?scope=session', '?scope=session&session=a%20b', '?scope=session&session=a&session=b',
      '?scope=session&session=known&role=qa', '?scope=other&session=known',
    ]) assert.equal((await get(`/issue-links${q}`)).status, 400, q)
  })
})
