/**
 * Git strip (#386): the branch, the commits and the PR states of one agent, read only from the output of its own
 * shell calls observed to succeed. Nothing is inferred:
 * - the branch is known only from an output that prints it: `git checkout` / `git switch` ("Switched to branch
 *   'x'", "Already on 'x'"), the header of `git status` ("On branch x", "## x...", "HEAD detached at"), a
 *   `git branch --show-current` run alone, or the `[x abc1234] message` line of `git commit`;
 * - a commit exists only when the output of `git commit` shows that line, for a call that completed without error;
 * - a PR state comes only from a gh output: the URL `gh pr create` prints (state "created"), the line of
 *   `gh pr merge` / `gh pr close`, or a `gh pr view --json` object carrying the number and the state. It is the
 *   state at the time of that call, never refreshed;
 * - an output line counts only when the command ran the git / gh subcommand that prints it, and a command aimed at
 *   another repository (`-C`, `--git-dir`, `--work-tree`) proves nothing.
 * With nothing observed the state stays undefined: no default branch.
 *
 * The same call (call node id or tool_use_id) is read once, so a replay never adds a commit nor moves the branch
 * back. Commits and PRs are bounded; the older ones are counted, never dropped silently.
 */
import { GITHUB_ISSUE_URL_RE } from './issue-links'
import { RESULT_CAPTURE_LIMIT, ghResultLink, shellCommands } from './action-summary'

export type GitRef = { kind: 'branch'; name: string } | { kind: 'detached' }

/** The output that proved the branch */
export type GitHeadSource = 'checkout' | 'status' | 'show-current' | 'commit'

export interface GitHead {
  ref: GitRef
  source: GitHeadSource
  /** Id of the tool call node the output comes from */
  callId: string
  /** Simulation time at which that call's success was observed */
  time: number
}

export interface GitCommit {
  sha: string
  /** Branch the commit line names; null on a detached HEAD */
  branch: string | null
  message: string
  /** The command was a `git commit --amend` */
  amend: boolean
  callId: string
  toolUseId?: string
  time: number
}

/** "created" is all `gh pr create` proves: whether the PR is a draft is not in its output */
export type GitPrState = 'created' | 'open' | 'draft' | 'merged' | 'closed'

export interface GitPr {
  number: number
  /** `owner/name` when the output gives it; a PR of an unknown repository is never merged with a known one */
  repo: string | null
  url?: string
  state: GitPrState
  callId: string
  time: number
}

export interface GitState {
  head?: GitHead
  /** Kept commits, oldest first */
  commits: GitCommit[]
  omittedCommits: number
  /** Kept PRs, the most recently observed last */
  prs: GitPr[]
  omittedPrs: number
  /** Call ids and tool_use_ids already read (bounded) */
  seen: string[]
}

export interface GitCall {
  command: string
  result: string
  callId: string
  toolUseId?: string
  time: number
}

export const GIT_STRIP_MAX_COMMITS = 20
export const GIT_STRIP_MAX_PRS = 5
const SEEN_MAX = 500

const FAILED_PREFIX = '[FAILED]'
const OTHER_REPO = /(?:^|[\s;&|(])git\s+(?:[^;&|\n]*\s)?(?:-C\s|--git-dir\b|--work-tree\b)/
const AMEND = /\bcommit\b[^;&|\n]*\s--amend\b/
const SHOW_CURRENT_ALONE = /^\s*git\s+branch\s+--show-current\s*$/
const REF_NAME = /^[\w][\w./-]*$/

const SWITCHED = /^(?:Switched to (?:a new |and reset )?branch|Already on) '([^']+)'$/
const DETACHED_SWITCH = /^(?:Note: switching to '[^']+'\.|You are in 'detached HEAD' state\.)/
const STATUS_BRANCH = /^On branch (\S+)$/
const STATUS_DETACHED = /^HEAD detached (?:at|from) \S+$/
const STATUS_SHORT = /^## (?:No commits yet on )?(\S+?)(?:\.\.\.\S+)?(?: \[[^\]]*\])?$/
const COMMIT_LINE = /^\[(.+?) (?:\(root-commit\) )?([0-9a-f]{7,40})\] (.*)$/
const PR_MERGED = /^(?:✓ )?(?:Merged|Squashed and merged|Rebased and merged) pull request (?:([\w.-]+\/[\w.-]+))?#(\d{1,9})\b/
const PR_CLOSED = /^(?:✓ )?Closed pull request (?:([\w.-]+\/[\w.-]+))?#(\d{1,9})\b/

type Seen = { head?: Omit<GitHead, 'callId' | 'time'>; commits: Omit<GitCommit, 'callId' | 'toolUseId' | 'time'>[]; prs: Omit<GitPr, 'callId' | 'time'>[] }

/** What one successful call's output proves, in the order printed. */
function readCall(command: string, result: string): Seen {
  const out: Seen = { commits: [], prs: [] }
  const cmds = shellCommands(command)
  const git = new Set(cmds.filter(c => c.tool === 'git').map(c => c.sub))
  const gh = new Set(cmds.filter(c => c.tool === 'gh').map(c => c.sub))
  const gitHere = git.size > 0 && !OTHER_REPO.test(command)
  const lines = result.split('\n')
  // The last line may stop mid-way when the result reached the capture limit
  const whole = result.length >= RESULT_CAPTURE_LIMIT ? lines.slice(0, -1) : lines
  const switching = gitHere && (git.has('checkout') || git.has('checkout -b') || git.has('switch'))
  const status = gitHere && git.has('status')
  const commit = gitHere && git.has('commit')
  for (const raw of whole) {
    const line = raw.trimEnd()
    let m: RegExpExecArray | null
    if (switching && (m = SWITCHED.exec(line))) out.head = { ref: { kind: 'branch', name: m[1] }, source: 'checkout' }
    else if (switching && DETACHED_SWITCH.test(line)) out.head = { ref: { kind: 'detached' }, source: 'checkout' }
    else if (status && (m = STATUS_BRANCH.exec(line))) out.head = { ref: { kind: 'branch', name: m[1] }, source: 'status' }
    else if (status && STATUS_DETACHED.test(line)) out.head = { ref: { kind: 'detached' }, source: 'status' }
    else if (status && (m = STATUS_SHORT.exec(line))) {
      out.head = m[1] === 'HEAD' ? { ref: { kind: 'detached' }, source: 'status' } : { ref: { kind: 'branch', name: m[1] }, source: 'status' }
    } else if (commit && (m = COMMIT_LINE.exec(line))) {
      const detached = m[1] === 'detached HEAD'
      out.commits.push({ sha: m[2], branch: detached ? null : m[1], message: m[3], amend: AMEND.test(command) })
      out.head = { ref: detached ? { kind: 'detached' } : { kind: 'branch', name: m[1] }, source: 'commit' }
    } else if (gh.has('pr merge') && (m = PR_MERGED.exec(line))) out.prs.push({ number: Number(m[2]), repo: m[1] ?? null, state: 'merged' })
    else if (gh.has('pr close') && (m = PR_CLOSED.exec(line))) out.prs.push({ number: Number(m[2]), repo: m[1] ?? null, state: 'closed' })
  }
  if (gitHere && git.has('branch') && SHOW_CURRENT_ALONE.test(command)) {
    const names = whole.map(l => l.trim()).filter(Boolean)
    // "Done" is what an absent output becomes: it proves nothing
    if (names.length === 1 && names[0] !== 'Done' && REF_NAME.test(names[0])) out.head = { ref: { kind: 'branch', name: names[0] }, source: 'show-current' }
  }
  if (gh.has('pr create')) {
    const link = ghResultLink(command, result)
    if (link?.kind === 'pr') out.prs.push({ number: link.number, repo: repoOfUrl(link.url), url: link.url, state: 'created' })
  }
  if (gh.has('pr view') && result.length < RESULT_CAPTURE_LIMIT) {
    const pr = prFromJson(result)
    if (pr) out.prs.push(pr)
  }
  return out
}

function repoOfUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)
  return m ? m[1] : null
}

/** A `gh pr view --json` object that carries both the number and the state; null otherwise. */
function prFromJson(result: string): Omit<GitPr, 'callId' | 'time'> | null {
  let v: unknown
  try { v = JSON.parse(result.trim()) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) return null
  const url = typeof o.url === 'string' && GITHUB_ISSUE_URL_RE.test(o.url) ? o.url : undefined
  const base = { number: o.number, repo: url ? repoOfUrl(url) : null, ...(url ? { url } : {}) }
  if (o.state === 'MERGED') return { ...base, state: 'merged' }
  if (o.state === 'CLOSED') return { ...base, state: 'closed' }
  if (o.state === 'OPEN') return { ...base, state: o.isDraft === true ? 'draft' : 'open' }
  return null
}

/**
 * The state after one shell call ended with `outcome`. Unchanged (the same object) unless the call succeeded, was
 * not read before, and its output proves something.
 */
export function recordGitCall(
  state: GitState | undefined,
  call: GitCall,
  outcome: 'complete' | 'error' | 'cancelled' | 'expired' | 'running',
): GitState | undefined {
  if (outcome !== 'complete' || call.result.startsWith(FAILED_PREFIX)) return state
  if (state && (state.seen.includes(call.callId) || (call.toolUseId !== undefined && state.seen.includes(call.toolUseId)))) return state
  const seen = readCall(call.command, call.result)
  if (!seen.head && seen.commits.length === 0 && seen.prs.length === 0) return state

  let commits = state?.commits ?? []
  for (const c of seen.commits) {
    if (commits.some(k => k.sha === c.sha)) continue
    commits = [...commits, { ...c, callId: call.callId, ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}), time: call.time }]
  }
  const overC = Math.max(0, commits.length - GIT_STRIP_MAX_COMMITS)

  let prs = state?.prs ?? []
  for (const p of seen.prs) {
    const prev = prs.find(k => k.number === p.number && k.repo === p.repo)
    const url = p.url ?? prev?.url
    prs = [...prs.filter(k => k !== prev), { ...p, ...(url ? { url } : {}), callId: call.callId, time: call.time }]
  }
  const overP = Math.max(0, prs.length - GIT_STRIP_MAX_PRS)

  const keys = [call.callId, ...(call.toolUseId ? [call.toolUseId] : [])]
  return {
    head: seen.head ? { ...seen.head, callId: call.callId, time: call.time } : state?.head,
    commits: overC > 0 ? commits.slice(overC) : commits,
    omittedCommits: (state?.omittedCommits ?? 0) + overC,
    prs: overP > 0 ? prs.slice(overP) : prs,
    omittedPrs: (state?.omittedPrs ?? 0) + overP,
    seen: [...(state?.seen ?? []), ...keys].slice(-SEEN_MAX),
  }
}

/** Commits observed in all, kept or not. */
export function gitCommitTotal(state: GitState): number {
  return state.commits.length + state.omittedCommits
}
