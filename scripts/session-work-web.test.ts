/** Web side of the PRs by branch and issues without an agent (#228): defensive parsing, honest wording. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  sessionWorkUrl, parseSessionWork, loadSessionWork, sortPrsByBranch, isSessionBranch,
} from '../web/lib/session-work'
import type { ChecksState } from '../web/lib/session-work'
import { checksText } from '../web/lib/panel-text'
import type { FetchLike } from '../web/lib/issue-links'

const U = 'https://github.com/o/r'
const checks = (state: ChecksState, total = 2, failing = 0, pending = 0) => ({ state, total, failing, pending })
const pr = (n: number, branch: string, extra: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, url: `${U}/pull/${n}`, branch, checks: checks('passing'), ...extra,
})
const body = (extra: Record<string, unknown> = {}) => ({
  scope: 'session', session: 's1', repo: U, prs: [pr(1, 'feat/a')], issues: [{ number: 9, title: 'I', url: `${U}/issues/9` }],
  prsTruncated: false, issuesTruncated: false, ...extra,
})

test('sessionWorkUrl asks the relay for the session, encoded', () => {
  assert.equal(sessionWorkUrl('http://127.0.0.1:3001', 'sess-1'), 'http://127.0.0.1:3001/issue-links?scope=session&session=sess-1')
  assert.equal(sessionWorkUrl('', 'a b/c'), '/issue-links?scope=session&session=a%20b%2Fc')
})

test('parseSessionWork keeps well-formed entries whose URL is exactly the PR / issue page they claim to be', () => {
  const w = parseSessionWork(body({
    prs: [pr(1, 'feat/a'), pr(2, 'x', { url: 'https://evil.io/o/r/pull/2' }), pr(3, 'x', { number: 4 }), pr(5, 'x', { draft: true }), pr(6, '')],
    issues: [{ number: 9, title: 'I', url: `${U}/issues/9` }, { number: 8, title: 'x', url: 'javascript:alert(1)' }, { number: 7, title: 'x', url: `${U}/pull/7` }],
  }))
  assert.ok(w)
  assert.deepEqual(w.prs.map(p => p.number), [1, 5])
  assert.equal(w.prs[1].draft, true)
  assert.deepEqual(w.issues.map(i => i.number), [9])
  assert.equal(w.repo, U)
})

test('parseSessionWork: an unknown checks state is "unknown", never passing; counts are bounded integers', () => {
  const w = parseSessionWork(body({ prs: [pr(1, 'a', { checks: { state: 'green', total: 1, failing: 0, pending: 0 } }), pr(2, 'b', { checks: { state: 'failing', total: -1, failing: 'x', pending: 0 } }), pr(3, 'c', { checks: undefined })] }))
  assert.ok(w)
  assert.deepEqual(w.prs.map(p => p.checks.state), ['unknown', 'unknown', 'unknown'])
})

test('parseSessionWork accepts repo null (no GitHub origin) and rejects what it cannot read', () => {
  const none = parseSessionWork(body({ repo: null, prs: [], issues: [] }))
  assert.ok(none)
  assert.equal(none.repo, null)
  for (const bad of [null, 'x', {}, body({ prs: 'x' }), body({ issues: undefined }), body({ repo: 'https://evil.io/o/r' }), body({ prsTruncated: 'yes' })]) {
    assert.equal(parseSessionWork(bad), undefined, JSON.stringify(bad))
  }
})

const res = (status: number, json: unknown, headers: Record<string, string> = {}) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => json,
})

test('loadSessionWork: ok on a readable answer, "unknown-project" on 404, "unavailable" on anything else', async () => {
  const ok = await loadSessionWork('', 's1', res(200, body()) as FetchLike)
  assert.equal(ok.status, 'ok')
  assert.equal((await loadSessionWork('', 's1', res(404, {}) as FetchLike)).status, 'unknown-project')
  const busy = await loadSessionWork('', 's1', res(502, {}, { 'retry-after': '10' }) as FetchLike)
  assert.deepEqual(busy, { status: 'unavailable', retryAfterMs: 10_000 })
  assert.equal((await loadSessionWork('', 's1', res(200, { nope: 1 }) as FetchLike)).status, 'unavailable')
  assert.equal((await loadSessionWork('', 's1', (async () => { throw new Error('net') }) as FetchLike)).status, 'unavailable')
})

test('loadSessionWork gives up after the timeout', async () => {
  const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  assert.equal((await loadSessionWork('', 's1', hang, undefined, 5)).status, 'unavailable')
})

test('checksLabel says in words what is proven, and what is not', () => {
  assert.equal(checksText('en', checks('passing', 5)), '5 of 5 passing')
  assert.equal(checksText('en', checks('failing', 5, 2, 1)), '2 failing, 1 pending of 5')
  assert.equal(checksText('en', checks('failing', 3, 1, 0)), '1 failing of 3')
  assert.equal(checksText('en', checks('pending', 4, 0, 3)), '3 pending of 4')
  assert.equal(checksText('en', checks('none', 0)), 'no checks reported')
  assert.equal(checksText('en', checks('unknown', 0)), 'checks unknown')
  assert.equal(checksText('en', checks('unknown', 3)), 'checks unknown (3 reported)')
})

test('sortPrsByBranch orders by branch then number, without mutating', () => {
  const prs = [pr(3, 'b'), pr(2, 'a'), pr(1, 'b')] as unknown as Parameters<typeof sortPrsByBranch>[0]
  assert.deepEqual(sortPrsByBranch(prs).map(p => p.number), [2, 1, 3])
  assert.deepEqual(prs.map(p => p.number), [3, 2, 1])
})

test('isSessionBranch only matches a recorded branch exactly', () => {
  assert.equal(isSessionBranch('feat/a', 'feat/a'), true)
  assert.equal(isSessionBranch('feat/a', 'feat/b'), false)
  assert.equal(isSessionBranch('feat/a', undefined), false)
  assert.equal(isSessionBranch('feat/a', ''), false)
})
