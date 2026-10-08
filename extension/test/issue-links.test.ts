/** Issue / PR links of an agent role through the agent:<role> labels (#63). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeRole, normalizeRepoUrl, parseGhList, fetchIssueLinks, resolveRepoUrl, ISSUE_LINKS_MAX, type GhExec,
} from '../src/issue-links'

const REPO = 'https://github.com/jobailla/agent-lens'

describe('sanitizeRole', () => {
  it('accepts a role and lower-cases it', () => {
    assert.equal(sanitizeRole('frontend-engineer'), 'frontend-engineer')
    assert.equal(sanitizeRole('Backend_Engineer'), 'backend_engineer')
  })
  it('refuses anything that could become a gh argument or a label query', () => {
    for (const bad of ['', ' ', '--repo', '-x', 'a b', 'a,b', 'a;rm', 'x'.repeat(41), 'ro\nle', '../x', 'agent:frontend', undefined, 3]) {
      assert.equal(sanitizeRole(bad as unknown), undefined, String(bad))
    }
  })
})

describe('normalizeRepoUrl', () => {
  it('normalizes https and ssh GitHub remotes', () => {
    for (const r of [
      'https://github.com/jobailla/agent-lens', 'https://github.com/jobailla/agent-lens.git',
      'git@github.com:jobailla/agent-lens.git', 'ssh://git@github.com/jobailla/agent-lens.git', 'https://github.com/jobailla/agent-lens/\n',
    ]) assert.equal(normalizeRepoUrl(r), REPO, r)
  })
  it('refuses other hosts, credentials, extra path and look-alike hosts', () => {
    for (const r of [
      'https://gitlab.com/a/b', 'https://github.com.evil.io/a/b', 'https://user:pw@github.com/a/b', 'http://github.com/a/b',
      'https://github.com/a', 'https://github.com/a/b/c', 'https://github.com/a/b?x=1', 'file:///etc/passwd', '', 'git@evil.com:a/b.git',
    ]) assert.equal(normalizeRepoUrl(r), undefined, r)
  })
})

describe('parseGhList', () => {
  const issue = { number: 12, title: 'Fix it', url: `${REPO}/issues/12`, state: 'OPEN' }
  const pr = { number: 13, title: 'Do it', url: `${REPO}/pull/13`, state: 'OPEN', isDraft: true }

  it('keeps well-formed entries of the right repo and kind', () => {
    assert.deepEqual(parseGhList(JSON.stringify([issue]), 'issue', REPO), [{ kind: 'issue', number: 12, title: 'Fix it', url: issue.url, state: 'open' }])
    assert.deepEqual(parseGhList(JSON.stringify([pr]), 'pr', REPO), [{ kind: 'pr', number: 13, title: 'Do it', url: pr.url, state: 'open', draft: true }])
  })
  it('drops a URL of another repo, another kind, or another scheme', () => {
    const rows = [
      { ...issue, url: 'https://github.com/evil/agent-lens/issues/12' },
      { ...issue, url: `${REPO}/pull/12` },
      { ...issue, url: 'javascript:alert(1)' },
      { ...issue, url: `${REPO}/issues/12/../../x` },
      { ...issue, url: `${REPO}/issues/99` },
      { ...issue, number: -1 },
    ]
    assert.deepEqual(parseGhList(JSON.stringify(rows), 'issue', REPO), [])
  })
  it('is bounded to 50 entries and caps titles', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ number: i + 1, title: 'T'.repeat(500), url: `${REPO}/issues/${i + 1}`, state: 'OPEN' }))
    const out = parseGhList(JSON.stringify(rows), 'issue', REPO)
    assert.equal(out.length, ISSUE_LINKS_MAX)
    assert.ok(out[0].title.length <= 200)
  })
  it('returns [] for invalid JSON or a non-array', () => {
    assert.deepEqual(parseGhList('not json', 'issue', REPO), [])
    assert.deepEqual(parseGhList('{"a":1}', 'issue', REPO), [])
  })
})

describe('fetchIssueLinks', () => {
  it('asks gh for issues and PRs with the role label, bounded, in the validated repo (no shell)', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec: GhExec = async (file, args) => {
      calls.push({ file, args })
      return args[0] === 'issue'
        ? JSON.stringify([{ number: 1, title: 'a', url: `${REPO}/issues/1`, state: 'OPEN' }])
        : JSON.stringify([{ number: 2, title: 'b', url: `${REPO}/pull/2`, state: 'OPEN', isDraft: false }])
    }
    const links = await fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec })
    assert.deepEqual(links.map(l => [l.kind, l.number]), [['pr', 2], ['issue', 1]])
    assert.equal(calls.length, 2)
    for (const c of calls) {
      assert.equal(c.file, 'gh')
      assert.ok(c.args.includes('--repo') && c.args[c.args.indexOf('--repo') + 1] === 'jobailla/agent-lens')
      assert.ok(c.args.includes('--label') && c.args[c.args.indexOf('--label') + 1] === 'agent:frontend-engineer')
      assert.ok(c.args.includes('--limit') && c.args[c.args.indexOf('--limit') + 1] === String(ISSUE_LINKS_MAX))
    }
  })

  it('degrades silently: gh missing, failing or slow gives []', async () => {
    const enoent: GhExec = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }
    assert.deepEqual(await fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec: enoent }), [])
  })

  it('keeps the half that worked when only one gh call fails', async () => {
    const exec: GhExec = async (_f, args) => {
      if (args[0] === 'pr') throw new Error('boom')
      return JSON.stringify([{ number: 1, title: 'a', url: `${REPO}/issues/1`, state: 'OPEN' }])
    }
    assert.equal((await fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec })).length, 1)
  })

  it('never runs gh for an invalid role or repo URL', async () => {
    let ran = 0
    const exec: GhExec = async () => { ran++; return '[]' }
    assert.deepEqual(await fetchIssueLinks('--repo', { repoUrl: REPO, exec }), [])
    assert.deepEqual(await fetchIssueLinks('frontend-engineer', { repoUrl: 'https://evil.io/a/b', exec }), [])
    assert.equal(ran, 0)
  })
})

describe('resolveRepoUrl', () => {
  it('reads the origin remote through git and validates it', async () => {
    const exec: GhExec = async (file, args) => {
      assert.equal(file, 'git')
      assert.deepEqual(args, ['remote', 'get-url', 'origin'])
      return 'git@github.com:jobailla/agent-lens.git\n'
    }
    assert.equal(await resolveRepoUrl('/tmp/ws', exec), REPO)
  })
  it('is undefined when git fails or the remote is not GitHub', async () => {
    assert.equal(await resolveRepoUrl('/tmp/ws', async () => { throw new Error('not a repo') }), undefined)
    assert.equal(await resolveRepoUrl('/tmp/ws', async () => 'https://gitlab.com/a/b'), undefined)
  })
})
