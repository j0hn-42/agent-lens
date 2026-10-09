/** Issue / PR links of an agent role through the agent:<role> labels (#63). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeRole, sanitizeSessionParam, issueLinksScope, normalizeRepoUrl, parseGhList, fetchIssueLinks, resolveRepoUrl, createRepoUrlCache, ISSUE_LINKS_MAX, type GhExec,
} from '../src/issue-links'

const REPO = 'https://github.com/jobailla/agent-lens'

describe('issue links scope (#109)', () => {
  it('accepts a session id and refuses anything else', () => {
    assert.equal(sanitizeSessionParam('7f3c-aa_1.b:2'), '7f3c-aa_1.b:2')
    for (const bad of ['', ' ', '../x', 'a b', 'a/b', '-x', 'x'.repeat(121), undefined, 3]) assert.equal(sanitizeSessionParam(bad as unknown), undefined, String(bad))
  })
  it('the cwd of the node session decides the repository', () => {
    assert.deepEqual(issueLinksScope({ session: 's', cwd: '/p/b', allWorkspaces: true }), { kind: 'cwd', cwd: '/p/b' })
    assert.deepEqual(issueLinksScope({ session: 's', cwd: '/p/b', allWorkspaces: false }), { kind: 'cwd', cwd: '/p/b' })
  })
  it('an unlocated session is the workspace when the relay is scoped, unknown when it serves every workspace', () => {
    assert.deepEqual(issueLinksScope({ session: 's', allWorkspaces: false }), { kind: 'workspace' })
    assert.deepEqual(issueLinksScope({ session: 's', allWorkspaces: true }), { kind: 'unknown' })
    assert.deepEqual(issueLinksScope({ allWorkspaces: true }), { kind: 'workspace' })
  })
})

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
  it('throws on invalid JSON or a non-array: gh did not answer a list (#205)', () => {
    assert.throws(() => parseGhList('not json', 'issue', REPO))
    assert.throws(() => parseGhList('{"a":1}', 'issue', REPO))
    assert.deepEqual(parseGhList('[]', 'issue', REPO), [])
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

  // #205: a failure must not read as "no issue agent:<role>"
  it('rejects when gh is missing, fails or prints something that is not a list', async () => {
    const enoent: GhExec = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }
    await assert.rejects(fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec: enoent }), /ENOENT/)
    await assert.rejects(fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec: async () => 'gh: rate limited' }))
  })

  it('rejects when only one of the two gh calls fails: half a list would hide the other half', async () => {
    const exec: GhExec = async (_f, args) => {
      if (args[0] === 'pr') throw new Error('boom')
      return JSON.stringify([{ number: 1, title: 'a', url: `${REPO}/issues/1`, state: 'OPEN' }])
    }
    await assert.rejects(fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec }), /boom/)
  })

  it('resolves [] when gh answers two empty lists', async () => {
    assert.deepEqual(await fetchIssueLinks('frontend-engineer', { repoUrl: REPO, exec: async () => '[]\n' }), [])
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
  it('is undefined when there is no repository, no origin, or a remote that is not GitHub', async () => {
    const gitError = (code: number, stderr: string): GhExec => async () => {
      throw Object.assign(new Error(`Command failed: git remote get-url origin\n${stderr}`), { code })
    }
    assert.equal(await resolveRepoUrl('/tmp/ws', gitError(128, 'fatal: not a git repository (or any of the parent directories): .git')), undefined)
    assert.equal(await resolveRepoUrl('/tmp/ws', gitError(2, "error: No such remote 'origin'")), undefined)
    assert.equal(await resolveRepoUrl('/tmp/ws', async () => 'https://gitlab.com/a/b'), undefined)
  })
  it('rejects when git itself fails (missing, killed by the timeout, another error): nothing is proven (#205)', async () => {
    await assert.rejects(resolveRepoUrl('/tmp/ws', async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }))
    await assert.rejects(resolveRepoUrl('/tmp/ws', async () => { throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) }))
    await assert.rejects(resolveRepoUrl('/tmp/ws', async () => {
      throw Object.assign(new Error("Command failed\nfatal: detected dubious ownership in repository at '/tmp/ws'"), { code: 128 })
    }))
  })
})

describe('createRepoUrlCache (#205)', () => {
  it('keeps a resolved repository: one lookup per directory', async () => {
    let runs = 0
    const cache = createRepoUrlCache(async () => { runs++; return REPO }, 8)
    assert.equal(await cache('/a'), REPO)
    assert.equal(await cache('/a'), REPO)
    assert.equal(runs, 1)
  })
  it('does not keep a failure nor an undefined: the next request looks again', async () => {
    let runs = 0
    const results: Array<() => Promise<string | undefined>> = [
      async () => { throw new Error('transient') },
      async () => undefined,
      async () => REPO,
    ]
    const cache = createRepoUrlCache(() => { runs++; return results[runs - 1]() }, 8)
    await assert.rejects(cache('/a'), /transient/)
    assert.equal(await cache('/a'), undefined)
    assert.equal(await cache('/a'), REPO)
    assert.equal(runs, 3)
  })
  it('shares one pending lookup between concurrent callers, and is bounded', async () => {
    let runs = 0
    const cache = createRepoUrlCache(async dir => { runs++; return `${REPO}${dir}` }, 2)
    await Promise.all([cache('/a'), cache('/a')])
    assert.equal(runs, 1)
    await cache('/b'); await cache('/c')
    await cache('/a')
    assert.equal(runs, 4, 'the oldest directory was evicted')
  })
})
