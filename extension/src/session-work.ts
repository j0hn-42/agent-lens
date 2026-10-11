/**
 * Work attached to the project of a session (#228): open PRs by branch with the state of their checks, and open
 * issues that no agent holds (no `agent:<role>` label). Read-only, same guarantees as issue-links.ts: gh runs
 * without a shell and with a timeout, every URL must be exactly this repository's issue or PR page, and a failure
 * rejects instead of being reported as an empty list (#205).
 */
import { defaultExec, normalizeRepoUrl, ISSUE_LINKS_MAX, type GhExec } from './issue-links'

export type ChecksState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown'

/** What the checks of a PR prove. `none` only when gh listed no check at all; anything unreadable is `unknown`. */
export interface ChecksSummary {
  state: ChecksState
  total: number
  failing: number
  pending: number
}

export interface SessionPr {
  number: number
  title: string
  url: string
  /** Head branch of the PR (`headRefName`) */
  branch: string
  draft?: boolean
  checks: ChecksSummary
}

export interface UnassignedIssue {
  number: number
  title: string
  url: string
}

export interface SessionWork {
  /** Canonical repository URL, or null when the project has no GitHub `origin` (a fact, not a failure) */
  repo: string | null
  prs: SessionPr[]
  issues: UnassignedIssue[]
  /** A full page came back: more PRs may exist ("at least") */
  prsTruncated: boolean
  /** A full page was scanned or the list was cut: more issues without an agent may exist */
  issuesTruncated: boolean
}

/** Open PRs asked to gh (a full page of this size means the list may be partial) */
export const SESSION_PRS_SCAN_MAX = 50
/** Open issues scanned to find those without an agent label */
export const SESSION_ISSUES_SCAN_MAX = 100
const TITLE_MAX = 200
const BRANCH_MAX = 200
const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])

const stripControl = (value: string): string => value.replace(/[\u0000-\u001F\u007F]/g, ' ')

/** Reduce gh's `statusCheckRollup` (check runs and commit statuses) to one honest state. */
export function summarizeChecks(rollup: unknown): ChecksSummary {
  if (!Array.isArray(rollup)) return { state: 'unknown', total: 0, failing: 0, pending: 0 }
  let failing = 0, pending = 0, unknown = 0
  for (const entry of rollup) {
    const e = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    if (typeof e.status === 'string') {
      // A check run: only a completed one has a conclusion
      if (e.status !== 'COMPLETED') pending++
      else if (typeof e.conclusion === 'string' && CHECK_FAILED.has(e.conclusion)) failing++
      else if (typeof e.conclusion !== 'string' || !CHECK_OK.has(e.conclusion)) unknown++
    } else if (typeof e.state === 'string') {
      // A commit status
      if (e.state === 'FAILURE' || e.state === 'ERROR') failing++
      else if (e.state === 'PENDING' || e.state === 'EXPECTED') pending++
      else if (e.state !== 'SUCCESS') unknown++
    } else {
      unknown++
    }
  }
  const total = rollup.length
  const state: ChecksState = total === 0 ? 'none' : failing > 0 ? 'failing' : pending > 0 ? 'pending' : unknown > 0 ? 'unknown' : 'passing'
  return { state, total, failing, pending }
}

function parseList(stdout: string): unknown[] {
  const rows: unknown = JSON.parse(stdout)
  if (!Array.isArray(rows)) throw new Error('gh did not print a JSON list')
  return rows
}

/** Validate the JSON of `gh pr list --json number,title,url,isDraft,headRefName,statusCheckRollup`; throws when it is not a list. */
export function parseSessionPrs(stdout: string, repoUrl: string): SessionPr[] {
  const out: SessionPr[] = []
  for (const row of parseList(stdout)) {
    if (out.length >= ISSUE_LINKS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const number = r.number
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue
    if (r.url !== `${repoUrl}/pull/${number}`) continue
    if (typeof r.headRefName !== 'string' || r.headRefName.length === 0) continue
    const pr: SessionPr = {
      number,
      title: typeof r.title === 'string' ? stripControl(r.title).slice(0, TITLE_MAX) : '',
      url: r.url,
      branch: stripControl(r.headRefName).slice(0, BRANCH_MAX),
      checks: summarizeChecks(r.statusCheckRollup),
    }
    if (r.isDraft === true) pr.draft = true
    out.push(pr)
  }
  return out
}

/**
 * Validate the JSON of `gh issue list --json number,title,url,labels` and keep the issues that carry no
 * `agent:<role>` label. An issue whose labels cannot be read is dropped: it is not proven to be without an agent.
 * `scanned` is the number of rows gh printed; `cut` says the kept list hit its bound.
 */
export function parseUnassignedIssues(stdout: string, repoUrl: string): { issues: UnassignedIssue[]; scanned: number; cut: boolean } {
  const rows = parseList(stdout)
  const issues: UnassignedIssue[] = []
  let cut = false
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const number = r.number
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue
    if (r.url !== `${repoUrl}/issues/${number}`) continue
    if (!Array.isArray(r.labels)) continue
    let readable = true
    let held = false
    for (const label of r.labels) {
      const name = label && typeof label === 'object' ? (label as Record<string, unknown>).name : undefined
      if (typeof name !== 'string') { readable = false; break }
      if (name.toLowerCase().startsWith('agent:')) held = true
    }
    if (!readable || held) continue
    if (issues.length >= ISSUE_LINKS_MAX) { cut = true; break }
    issues.push({ number, title: typeof r.title === 'string' ? stripControl(r.title).slice(0, TITLE_MAX) : '', url: r.url })
  }
  return { issues, scanned: rows.length, cut }
}

export interface FetchSessionWorkOptions {
  /** Canonical repository URL (see normalizeRepoUrl) */
  repoUrl: string
  exec?: GhExec
}

/**
 * Open PRs (with branch and checks) and open issues without an agent label of a repository. Rejects when a gh call
 * fails or prints something other than a list (#205); an invalid repository URL runs nothing and returns empty lists.
 */
export async function fetchSessionWork(opts: FetchSessionWorkOptions): Promise<Omit<SessionWork, 'repo'>> {
  const repoUrl = normalizeRepoUrl(opts.repoUrl)
  if (!repoUrl) return { prs: [], issues: [], prsTruncated: false, issuesTruncated: false }
  const exec = opts.exec ?? defaultExec
  const slug = repoUrl.slice('https://github.com/'.length)
  const [prOut, issueOut] = await Promise.all([
    exec('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', String(SESSION_PRS_SCAN_MAX),
      '--json', 'number,title,url,isDraft,headRefName,statusCheckRollup']),
    exec('gh', ['issue', 'list', '--repo', slug, '--state', 'open', '--limit', String(SESSION_ISSUES_SCAN_MAX),
      '--json', 'number,title,url,labels']),
  ])
  const prs = parseSessionPrs(prOut, repoUrl)
  const found = parseUnassignedIssues(issueOut, repoUrl)
  return {
    prs, issues: found.issues,
    prsTruncated: parseList(prOut).length >= SESSION_PRS_SCAN_MAX,
    issuesTruncated: found.cut || found.scanned >= SESSION_ISSUES_SCAN_MAX,
  }
}
