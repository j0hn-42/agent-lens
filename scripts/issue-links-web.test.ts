/** Web side of the issue/PR links (#63): role of a node, defensive parsing, silent failure. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { agentRoleOf, parseIssueLinks, loadIssueLinks, issueLinksUrl, issueLinkLabel, parseRetryAfter, issueLinksRetryDelayMs, type FetchLike } from '../web/lib/issue-links'

const U = 'https://github.com/jobailla/agent-lens'

test('agentRoleOf: dispatch subagent type first, then team role, only valid labels', () => {
  assert.equal(agentRoleOf({ subagentType: 'Frontend-Engineer' }), 'frontend-engineer')
  assert.equal(agentRoleOf({ agentType: 'backend-engineer' }), 'backend-engineer')
  assert.equal(agentRoleOf({ subagentType: 'frontend-engineer', agentType: 'x' }), 'frontend-engineer')
  assert.equal(agentRoleOf({ subagentType: 'general purpose', agentType: 'qa' }), 'qa')
  assert.equal(agentRoleOf({ subagentType: '--repo' }), undefined)
  assert.equal(agentRoleOf({}), undefined)
})

test('issueLinksUrl encodes the role', () => {
  assert.equal(issueLinksUrl('http://127.0.0.1:3001', 'qa'), 'http://127.0.0.1:3001/issue-links?role=qa')
  assert.equal(issueLinksUrl('', 'qa'), '/issue-links?role=qa')
})

test('issueLinksUrl names the session of the node so the relay resolves its own repository (#109)', () => {
  assert.equal(issueLinksUrl('http://x', 'qa', 'sess-1'), 'http://x/issue-links?role=qa&session=sess-1')
  assert.equal(issueLinksUrl('http://x', 'qa', 'a b/c'), 'http://x/issue-links?role=qa&session=a%20b%2Fc')
  assert.equal(issueLinksUrl('http://x', 'qa', 'default'), 'http://x/issue-links?role=qa', 'the placeholder session is not a session')
  assert.equal(issueLinksUrl('http://x', 'qa', ''), 'http://x/issue-links?role=qa')
})

test('parseIssueLinks keeps only exact github issue/PR URLs matching kind and number', () => {
  const good = { kind: 'issue', number: 7, title: 't', url: `${U}/issues/7`, state: 'open' }
  const pr = { kind: 'pr', number: 8, title: 'p', url: `${U}/pull/8`, state: 'open', draft: true }
  const rows = [
    good, pr,
    { ...good, url: 'https://evil.io/a/b/issues/7' },
    { ...good, url: `${U}/issues/7/../x` },
    { ...good, url: 'javascript:alert(1)' },
    { ...good, number: 9 },
    { ...good, kind: 'pr' },
    { ...good, url: `${U}/issues/7?x=1` },
    null, 'x',
  ]
  const out = parseIssueLinks({ links: rows })
  assert.deepEqual(out.map(l => [l.kind, l.number, l.draft]), [['issue', 7, undefined], ['pr', 8, true]])
})

test('parseIssueLinks tolerates anything', () => {
  for (const v of [null, undefined, 3, 'x', {}, { links: 'no' }]) assert.deepEqual(parseIssueLinks(v), [])
})

test('loadIssueLinks: a failure is "unavailable", never an empty list', async () => {
  const boom: FetchLike = async () => { throw new Error('offline') }
  const notOk: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const badJson: FetchLike = async () => ({ ok: true, json: async () => { throw new SyntaxError('x') } })
  const noArray: FetchLike = async () => ({ ok: true, json: async () => ({ role: 'qa' }) })
  for (const f of [boom, notOk, badJson, noArray]) assert.equal((await loadIssueLinks('http://x', 'qa', f)).status, 'unavailable')
  const ok: FetchLike = async url => {
    assert.equal(url, 'http://x/issue-links?role=qa')
    return { ok: true, json: async () => ({ links: [{ kind: 'issue', number: 1, title: 't', url: `${U}/issues/1`, state: 'open' }] }) }
  }
  const res = await loadIssueLinks('http://x', 'qa', ok)
  assert.equal(res.status, 'ok')
  assert.equal(res.status === 'ok' && res.links.length, 1)
  const empty: FetchLike = async () => ({ ok: true, json: async () => ({ links: [] }) })
  assert.deepEqual(await loadIssueLinks('http://x', 'qa', empty), { status: 'ok', links: [] }, 'a true empty answer is a real answer')
})

test('loadIssueLinks: reads Retry-After from a 503, and a hanging request times out as unavailable', async () => {
  const busy: FetchLike = async () => ({ ok: false, status: 503, headers: { get: n => (n === 'Retry-After' ? '3' : null) }, json: async () => ({}) })
  assert.deepEqual(await loadIssueLinks('http://x', 'qa', busy), { status: 'unavailable', retryAfterMs: 3000 })
  const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
  assert.equal((await loadIssueLinks('http://x', 'qa', hang, undefined, undefined, 20)).status, 'unavailable')
  const ctrl = new AbortController()
  const pending = loadIssueLinks('http://x', 'qa', hang, ctrl.signal, undefined, 60_000)
  ctrl.abort()
  assert.equal((await pending).status, 'unavailable', 'the caller can cancel')
})

test('parseRetryAfter: seconds or HTTP date, nothing else', () => {
  assert.equal(parseRetryAfter('2'), 2000)
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter('soon'), undefined)
  assert.equal(parseRetryAfter('-5'), undefined)
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000), 6000)
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:01 GMT', 4000), 0)
})

test('issueLinksRetryDelayMs: exponential, capped, never below Retry-After, never a tight loop', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(n => issueLinksRetryDelayMs(n)), [1000, 2000, 4000, 8000, 30000])
  assert.equal(issueLinksRetryDelayMs(0, 7000), 7000)
  assert.equal(issueLinksRetryDelayMs(3, 1000), 8000)
  assert.equal(issueLinksRetryDelayMs(0, 0), 1000, 'Retry-After: 0 does not make a tight loop')
  assert.equal(issueLinksRetryDelayMs(0, 3_600_000), 30000, 'a huge Retry-After is capped')
})

test('issueLinkLabel', () => {
  assert.equal(issueLinkLabel({ kind: 'issue', number: 1, title: 'Fix', url: '', state: 'open' }), 'Issue #1 Fix')
  assert.equal(issueLinkLabel({ kind: 'pr', number: 2, title: '', url: '', state: 'open', draft: true }), 'PR #2 (draft)')
})
