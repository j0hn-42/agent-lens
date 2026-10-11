/**
 * Open PRs by branch (with their checks) and open issues that no agent holds, for the project of a session (#228).
 * Everything is proven by what gh printed: an unreadable entry is dropped or reported unknown, never guessed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GhExec } from '../src/issue-links'
import { summarizeChecks, parseSessionPrs, parseUnassignedIssues, fetchSessionWork } from '../src/session-work'

const REPO = 'https://github.com/o/r'
const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'x', status, conclusion })
const ctx = (state: string) => ({ __typename: 'StatusContext', context: 'ci', state })

describe('summarizeChecks', () => {
  it('an empty rollup is "none": the PR reports no check', () => {
    assert.deepEqual(summarizeChecks([]), { state: 'none', total: 0, failing: 0, pending: 0 })
  })
  it('all successful, neutral or skipped is passing', () => {
    assert.deepEqual(summarizeChecks([run('SUCCESS'), run('NEUTRAL'), run('SKIPPED'), ctx('SUCCESS')]), { state: 'passing', total: 4, failing: 0, pending: 0 })
  })
  it('any failure wins over pending', () => {
    const s = summarizeChecks([run('SUCCESS'), run('FAILURE'), run('', 'IN_PROGRESS'), ctx('ERROR'), run('TIMED_OUT')])
    assert.deepEqual(s, { state: 'failing', total: 5, failing: 3, pending: 1 })
  })
  it('a run that is not completed, or a pending status, is pending', () => {
    assert.deepEqual(summarizeChecks([run('SUCCESS'), run('', 'QUEUED'), ctx('PENDING'), ctx('EXPECTED')]), { state: 'pending', total: 4, failing: 0, pending: 3 })
  })
  it('an entry it cannot read is never counted as passing', () => {
    assert.equal(summarizeChecks([run('SUCCESS'), { weird: true }]).state, 'unknown')
    assert.equal(summarizeChecks([run('SOMETHING_NEW')]).state, 'unknown')
    assert.equal(summarizeChecks([ctx('MYSTERY')]).state, 'unknown')
    assert.equal(summarizeChecks([null, 'x']).state, 'unknown')
  })
  it('a missing or non-list rollup is unknown, not "none"', () => {
    for (const v of [undefined, null, {}, 'x', 3]) assert.deepEqual(summarizeChecks(v), { state: 'unknown', total: 0, failing: 0, pending: 0 })
  })
})

const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, url: `${REPO}/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: `feat/b${n}`, statusCheckRollup: [run('SUCCESS')], ...extra,
})

describe('parseSessionPrs', () => {
  it('keeps branch, draft flag and checks of PRs whose URL is exactly this repository\'s', () => {
    const out = parseSessionPrs(JSON.stringify([pr(1), pr(2, { isDraft: true, statusCheckRollup: [] }), pr(3, { url: 'https://evil.io/o/r/pull/3' }), pr(4, { number: 5 })]), REPO)
    assert.deepEqual(out.map(p => p.number), [1, 2])
    assert.equal(out[0].branch, 'feat/b1')
    assert.equal(out[0].checks.state, 'passing')
    assert.equal(out[1].draft, true)
    assert.equal(out[1].checks.state, 'none')
  })
  it('drops a PR without a usable branch name and strips control characters', () => {
    const out = parseSessionPrs(JSON.stringify([pr(1, { headRefName: '' }), pr(2, { headRefName: 42 }), pr(3, { headRefName: 'a\u001b[31mb' }), pr(4, { title: 'x\ny' })]), REPO)
    assert.deepEqual(out.map(p => p.number), [3, 4])
    assert.equal(out[0].branch, 'a [31mb')
    assert.equal(out[1].title, 'x y')
  })
  it('throws when gh did not print a list', () => {
    assert.throws(() => parseSessionPrs('{}', REPO))
    assert.throws(() => parseSessionPrs('not json', REPO))
  })
})

const issue = (n: number, labels: unknown) => ({ number: n, title: `Issue ${n}`, url: `${REPO}/issues/${n}`, labels })

describe('parseUnassignedIssues', () => {
  it('keeps only issues with no agent:<role> label, in any case', () => {
    const rows = [
      issue(1, []), issue(2, [{ name: 'bug' }]), issue(3, [{ name: 'agent:qa-engineer' }]),
      issue(4, [{ name: 'bug' }, { name: 'Agent:Backend' }]), issue(5, [{ name: 'agentic' }]),
    ]
    const { issues, scanned } = parseUnassignedIssues(JSON.stringify(rows), REPO)
    assert.deepEqual(issues.map(i => i.number), [1, 2, 5])
    assert.equal(scanned, 5)
  })
  it('an issue whose labels cannot be read is not claimed to be unassigned', () => {
    const { issues } = parseUnassignedIssues(JSON.stringify([issue(1, undefined), issue(2, 'bug'), issue(3, [{ nope: 1 }]), issue(4, [])]), REPO)
    assert.deepEqual(issues.map(i => i.number), [4])
  })
  it('drops a foreign or mismatched URL', () => {
    const { issues } = parseUnassignedIssues(JSON.stringify([{ ...issue(1, []), url: 'https://evil.io/o/r/issues/1' }, { ...issue(2, []), number: 3 }, issue(4, [])]), REPO)
    assert.deepEqual(issues.map(i => i.number), [4])
  })
})

describe('fetchSessionWork', () => {
  const exec = (prs: unknown, issues: unknown, calls: string[][] = []): GhExec => async (file, args) => {
    calls.push([file, ...args])
    return JSON.stringify(args[0] === 'pr' ? prs : issues)
  }
  it('asks gh for open PRs with their checks and open issues, in this repository only, without a shell', async () => {
    const calls: string[][] = []
    const w = await fetchSessionWork({ repoUrl: REPO, exec: exec([pr(1)], [issue(2, [])], calls) })
    assert.deepEqual(w.prs.map(p => p.number), [1])
    assert.deepEqual(w.issues.map(i => i.number), [2])
    const prCall = calls.find(c => c[1] === 'pr')!
    assert.deepEqual(prCall.slice(0, 7), ['gh', 'pr', 'list', '--repo', 'o/r', '--state', 'open'])
    assert.ok(prCall.join(' ').includes('headRefName') && prCall.join(' ').includes('statusCheckRollup'))
    const issueCall = calls.find(c => c[1] === 'issue')!
    assert.ok(issueCall.join(' ').includes('labels'))
    assert.ok(!issueCall.includes('--label'))
  })
  it('flags a partial answer: a full page means more may exist ("at least")', async () => {
    const many = Array.from({ length: 50 }, (_, i) => pr(i + 1))
    const issues = Array.from({ length: 100 }, (_, i) => issue(i + 1, []))
    const w = await fetchSessionWork({ repoUrl: REPO, exec: exec(many, issues) })
    assert.equal(w.prsTruncated, true)
    assert.equal(w.issuesTruncated, true)
    assert.equal(w.issues.length, 50)
    const small = await fetchSessionWork({ repoUrl: REPO, exec: exec([pr(1)], [issue(2, [])]) })
    assert.equal(small.prsTruncated, false)
    assert.equal(small.issuesTruncated, false)
  })
  it('rejects when gh fails: a failure is not an empty list', async () => {
    const failing: GhExec = async () => { throw new Error('gh missing') }
    await assert.rejects(fetchSessionWork({ repoUrl: REPO, exec: failing }))
  })
  it('does not run gh for a repository URL that is not a plain github.com one', async () => {
    const calls: string[][] = []
    const w = await fetchSessionWork({ repoUrl: 'https://evil.io/o/r', exec: exec([], [], calls) })
    assert.deepEqual(calls, [])
    assert.deepEqual(w.prs, [])
  })
})
