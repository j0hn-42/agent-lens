/** Web side of the issue/PR links (#63): role of a node, defensive parsing, silent failure. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { agentRoleOf, parseIssueLinks, loadIssueLinks, issueLinksUrl, issueLinkLabel, type FetchLike } from '../web/lib/issue-links'

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

test('loadIssueLinks degrades silently: failing fetch, non-ok, bad JSON', async () => {
  const boom: FetchLike = async () => { throw new Error('offline') }
  const notOk: FetchLike = async () => ({ ok: false, json: async () => ({}) })
  const badJson: FetchLike = async () => ({ ok: true, json: async () => { throw new SyntaxError('x') } })
  for (const f of [boom, notOk, badJson]) assert.deepEqual(await loadIssueLinks('http://x', 'qa', f), [])
  const ok: FetchLike = async url => {
    assert.equal(url, 'http://x/issue-links?role=qa')
    return { ok: true, json: async () => ({ links: [{ kind: 'issue', number: 1, title: 't', url: `${U}/issues/1`, state: 'open' }] }) }
  }
  assert.equal((await loadIssueLinks('http://x', 'qa', ok)).length, 1)
})

test('issueLinkLabel', () => {
  assert.equal(issueLinkLabel({ kind: 'issue', number: 1, title: 'Fix', url: '', state: 'open' }), 'Issue #1 Fix')
  assert.equal(issueLinkLabel({ kind: 'pr', number: 2, title: '', url: '', state: 'open', draft: true }), 'PR #2 (draft)')
})
