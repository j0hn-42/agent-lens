// Git strip (#386): the branch, the commits and the PR states of one agent, each read from the output of a shell
// call of that agent observed to succeed. Nothing is inferred: no output, nothing shown (no "main" by default).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import { GIT_STRIP_MAX_COMMITS, GIT_STRIP_MAX_PRS, recordGitCall, type GitCall, type GitState } from '../web/lib/git-state'

// ─── Pure module ─────────────────────────────────────────────────────────────

let n = 0
const call = (command: string, result: string, extra: Partial<GitCall> = {}): GitCall =>
  ({ command, result, callId: `c${++n}`, toolUseId: `u${n}`, time: n, ...extra })
const rec = (s: GitState | undefined, c: GitCall, outcome: Parameters<typeof recordGitCall>[2] = 'complete') => recordGitCall(s, c, outcome)

test('nothing observed: no state at all (no default branch)', () => {
  assert.equal(rec(undefined, call('ls -la', 'total 0')), undefined)
  assert.equal(rec(undefined, call('git log --oneline', 'abc1234 something')), undefined)
  assert.equal(rec(undefined, call('git push origin HEAD:feat/x', 'Everything up-to-date')), undefined)
})

test('the branch comes from an observed checkout / switch output', () => {
  assert.deepEqual(rec(undefined, call('git checkout -b feat/x', "Switched to a new branch 'feat/x'"))?.head?.ref, { kind: 'branch', name: 'feat/x' })
  assert.deepEqual(rec(undefined, call('git switch develop', "Switched to branch 'develop'\nYour branch is up to date with 'origin/develop'."))?.head?.ref, { kind: 'branch', name: 'develop' })
  assert.deepEqual(rec(undefined, call('git checkout main', "Already on 'main'"))?.head?.ref, { kind: 'branch', name: 'main' })
  assert.equal(rec(undefined, call('git checkout -b feat/x', "Switched to a new branch 'feat/x'"))?.head?.source, 'checkout')
})

test('a checkout command without the output proving it sets no branch', () => {
  // The intent is in the command, the proof is in the output: "Done" (no output reported) proves nothing
  assert.equal(rec(undefined, call('git checkout -b feat/x', 'Done')), undefined)
})

test('the branch comes from the header of git status, -sb included, and from git branch --show-current alone', () => {
  assert.deepEqual(rec(undefined, call('git status', 'On branch feat/y\nnothing to commit, working tree clean'))?.head?.ref, { kind: 'branch', name: 'feat/y' })
  assert.deepEqual(rec(undefined, call('git status -sb', '## feat/z...origin/feat/z [ahead 1]\n M a.ts'))?.head?.ref, { kind: 'branch', name: 'feat/z' })
  assert.deepEqual(rec(undefined, call('git status', 'HEAD detached at abc1234\nnothing to commit'))?.head?.ref, { kind: 'detached' })
  assert.deepEqual(rec(undefined, call('git branch --show-current', 'feat/w\n'))?.head?.ref, { kind: 'branch', name: 'feat/w' })
  // Combined with something else, the bare line cannot be tied to git branch
  assert.equal(rec(undefined, call('echo hi && git branch --show-current', 'hi\nfeat/w')), undefined)
})

test('an output line is read only when the command ran the git subcommand that prints it', () => {
  assert.equal(rec(undefined, call('cat notes.txt', 'On branch fake\n[fake abc1234] not a commit')), undefined)
  assert.equal(rec(undefined, call('git log -1', "Switched to branch 'fake'")), undefined)
})

test('a command aimed at another repository (-C, --git-dir, --work-tree) proves nothing for this agent', () => {
  assert.equal(rec(undefined, call('git -C ../other status', 'On branch other')), undefined)
  assert.equal(rec(undefined, call('git --git-dir=../o/.git status', 'On branch other')), undefined)
  assert.equal(rec(undefined, call('git --work-tree ../o commit -m x', '[other abc1234] x')), undefined)
})

test('a commit exists only when the output of git commit shows it; it also proves the branch', () => {
  const s = rec(undefined, call('git commit -m "feat: x (#386)"', '[feat/x 1a2b3c4] feat: x (#386)\n 2 files changed, 10 insertions(+)'))
  assert.deepEqual(s?.commits.map(c => [c.sha, c.branch, c.message, c.amend]), [['1a2b3c4', 'feat/x', 'feat: x (#386)', false]])
  assert.deepEqual(s?.head?.ref, { kind: 'branch', name: 'feat/x' })
  assert.equal(s?.head?.source, 'commit')
  const root = rec(undefined, call('git commit -m init', '[main (root-commit) 0000abc] init'))
  assert.deepEqual(root?.commits.map(c => [c.sha, c.branch]), [['0000abc', 'main']])
  const detached = rec(undefined, call('git commit -m d', '[detached HEAD 9f9f9f9] d'))
  assert.deepEqual(detached?.commits.map(c => c.branch), [null])
  assert.deepEqual(detached?.head?.ref, { kind: 'detached' })
  const amend = rec(s, call('git commit --amend --no-edit', '[feat/x 5e5e5e5] feat: x (#386)'))
  assert.deepEqual(amend?.commits.map(c => [c.sha, c.amend]), [['1a2b3c4', false], ['5e5e5e5', true]])
})

test('a failed, cancelled or still running git commit creates no commit', () => {
  const ok = '[feat/x 1a2b3c4] msg'
  assert.equal(rec(undefined, call('git commit -m msg', ok), 'error'), undefined)
  assert.equal(rec(undefined, call('git commit -m msg', ok), 'cancelled'), undefined)
  assert.equal(rec(undefined, call('git commit -m msg', ok), 'running'), undefined)
  assert.equal(rec(undefined, call('git commit -m msg', `[FAILED] ${ok}`)), undefined)
  assert.equal(rec(undefined, call('git commit -m msg', 'nothing to commit, working tree clean')), undefined)
})

test('the same call never counts twice (same call id or same tool_use_id), and a replayed older call does not move the branch back', () => {
  const c1 = call('git commit -m a', '[feat/x 1111111] a')
  const s1 = rec(undefined, c1)
  assert.equal(rec(s1, c1), s1)
  assert.equal(rec(s1, { ...c1, callId: 'replayed' }), s1)
  const sw = call('git checkout -b feat/old', "Switched to a new branch 'feat/old'")
  const s2 = rec(rec(s1, sw), call('git switch feat/new', "Switched to branch 'feat/new'"))
  assert.deepEqual(rec(s2, { ...sw, callId: 'again' })?.head?.ref, { kind: 'branch', name: 'feat/new' })
})

test('the same sha is listed once', () => {
  const s = rec(rec(undefined, call('git commit -m a', '[x 1111111] a')), call('git commit -m a', '[x 1111111] a'))
  assert.equal(s?.commits.length, 1)
})

test('commits are bounded: the most recent are kept, the older ones counted', () => {
  let s: GitState | undefined
  for (let i = 0; i < GIT_STRIP_MAX_COMMITS + 4; i++) s = rec(s, call('git commit -m m', `[x ${(0x1000000 + i).toString(16)}] m${i}`))
  assert.equal(s?.commits.length, GIT_STRIP_MAX_COMMITS)
  assert.equal(s?.omittedCommits, 4)
  assert.equal(s?.commits[0].message, 'm4')
})

test('a result that may have been cut is not read on its last line', () => {
  const long = `[feat/x 1a2b3c4] ${'m'.repeat(260)}`
  assert.equal(rec(undefined, call('git commit -m long', long.slice(0, 200))), undefined)
})

test('PR state from gh pr create (its URL), gh pr merge / close, gh pr view --json; never inferred', () => {
  const created = rec(undefined, call('gh pr create --draft --base develop', 'https://github.com/o/r/pull/12'))
  assert.deepEqual(created?.prs.map(p => [p.number, p.repo, p.state, p.url]), [[12, 'o/r', 'created', 'https://github.com/o/r/pull/12']])
  const merged = rec(created, call('gh pr merge 12 --squash', '✓ Squashed and merged pull request o/r#12 (feat: x)'))
  assert.deepEqual(merged?.prs.map(p => [p.number, p.repo, p.state, p.url]), [[12, 'o/r', 'merged', 'https://github.com/o/r/pull/12']])
  const closed = rec(undefined, call('gh pr close 7', '✓ Closed pull request o/r#7 (x)'))
  assert.deepEqual(closed?.prs.map(p => [p.number, p.state]), [[7, 'closed']])
  const viewed = rec(undefined, call('gh pr view 9 --json number,state,isDraft', '{"isDraft":true,"number":9,"state":"OPEN"}'))
  assert.deepEqual(viewed?.prs.map(p => [p.number, p.state]), [[9, 'draft']])
  const open = rec(undefined, call('gh pr view 9 --json number,state', '{"number":9,"state":"OPEN"}'))
  assert.deepEqual(open?.prs.map(p => [p.number, p.state]), [[9, 'open']])
  // An auto-merge is only queued: not merged
  assert.equal(rec(undefined, call('gh pr merge 12 --auto', '✓ Pull request o/r#12 will be automatically merged via squash when all requirements are met')), undefined)
  // A JSON without the PR number cannot say which PR
  assert.equal(rec(undefined, call('gh pr view --json state', '{"state":"MERGED"}')), undefined)
  // A URL printed by another command is not a PR this agent created
  assert.equal(rec(undefined, call('gh issue create -t x', 'https://github.com/o/r/issues/3')), undefined)
  assert.equal(rec(undefined, call('echo https://github.com/o/r/pull/12', 'https://github.com/o/r/pull/12')), undefined)
})

test('a PR of an unknown repository is never merged with one of a known repository', () => {
  const created = rec(undefined, call('gh pr create', 'https://github.com/o/r/pull/12'))
  const merged = rec(created, call('gh pr merge 12', 'Merged pull request #12 (x)'))
  assert.deepEqual(merged?.prs.map(p => [p.number, p.repo, p.state]), [[12, 'o/r', 'created'], [12, null, 'merged']])
})

test('a failed gh call proves no PR state', () => {
  assert.equal(rec(undefined, call('gh pr merge 12', '✓ Merged pull request o/r#12 (x)'), 'error'), undefined)
})

test('PRs are bounded too, the older counted', () => {
  let s: GitState | undefined
  for (let i = 1; i <= GIT_STRIP_MAX_PRS + 2; i++) s = rec(s, call('gh pr create', `https://github.com/o/r/pull/${i}`))
  assert.equal(s?.prs.length, GIT_STRIP_MAX_PRS)
  assert.equal(s?.omittedPrs, 2)
  assert.equal(s?.prs[0].number, 3)
})

// ─── Through the event pipeline ──────────────────────────────────────────────

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'>
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    t += 5 // past the start dedup window
    state = processEvent({ time: t, type: e.type, payload: e.payload }, { ...state, currentTime: t }, ctx)
  }
  return state
}
const spawn = (name: string, isMain = true): Ev => ({ type: 'agent_spawn', payload: { name, isMain } })
const bash = (agent: string, command: string, result: string, id: string, extra: Record<string, unknown> = {}): Ev[] => [
  { type: 'tool_call_start', payload: { agent, tool: 'Bash', args: command, inputData: { command }, toolUseId: id } },
  { type: 'tool_call_end', payload: { agent, tool: 'Bash', result, toolUseId: id, ...extra } },
]
const gitOf = (s: SimulationState, name: string) => [...s.agents.values()].find(a => a.localId === name)?.git

test('pipeline: a successful checkout then commit set the branch and list the commit on that agent', () => {
  const s = run([spawn('main'),
    ...bash('main', 'git checkout -b feat/386-git-strip', "Switched to a new branch 'feat/386-git-strip'", 'u1'),
    ...bash('main', 'git commit -m "test (#386)"', '[feat/386-git-strip abc1234] test (#386)', 'u2'),
  ])
  const g = gitOf(s, 'main')
  assert.deepEqual(g?.head?.ref, { kind: 'branch', name: 'feat/386-git-strip' })
  assert.deepEqual(g?.commits.map(c => c.sha), ['abc1234'])
  assert.ok(g?.commits[0].callId && s.toolCalls.has(g.commits[0].callId), 'the commit points at its call')
})

test('pipeline: nothing observed leaves the agent without git state', () => {
  const s = run([spawn('main'), ...bash('main', 'ls', 'a\nb', 'u1')])
  assert.equal(gitOf(s, 'main'), undefined)
})

test('pipeline: a failed git commit adds no commit', () => {
  const s = run([spawn('main'), ...bash('main', 'git commit -m x', '[feat/x abc1234] x', 'u1', { isError: true })])
  assert.equal(gitOf(s, 'main'), undefined)
})

test('pipeline: a branch change in another agent does not change this one', () => {
  const s = run([spawn('main'), spawn('helper', false),
    ...bash('main', 'git switch feat/a', "Switched to branch 'feat/a'", 'u1'),
    ...bash('helper', 'git switch feat/b', "Switched to branch 'feat/b'", 'u2'),
  ])
  assert.deepEqual(gitOf(s, 'main')?.head?.ref, { kind: 'branch', name: 'feat/a' })
  assert.deepEqual(gitOf(s, 'helper')?.head?.ref, { kind: 'branch', name: 'feat/b' })
})

test('pipeline: a replayed tool_use and tool_result (same tool_use_id) list the commit once', () => {
  const c = bash('main', 'git commit -m x', '[feat/x abc1234] x', 'u1')
  const s = run([spawn('main'), ...c, ...c])
  assert.equal(gitOf(s, 'main')?.commits.length, 1)
})
