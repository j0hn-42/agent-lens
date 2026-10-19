/**
 * Open PRs by branch (with the state of their checks) and open issues no agent holds, for the project of a
 * session (#228), as served by the relay's GET /issue-links?scope=session.
 * Everything coming back is validated again: only plain github.com PR / issue URLs of the stated repository are
 * rendered as links, and an unreadable checks summary is "unknown", never passing. A failure is never turned into
 * "no PR": the load reports "unavailable" (or "unknown-project") instead.
 */
import { parseRetryAfter, ISSUE_LINKS_TIMEOUT_MS, ISSUE_LINKS_MAX, type FetchLike } from './issue-links'

export type ChecksState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown'

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
  repo: string | null
  prs: SessionPr[]
  issues: UnassignedIssue[]
  prsTruncated: boolean
  issuesTruncated: boolean
}

const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const CHECKS_STATES: ReadonlySet<string> = new Set(['passing', 'failing', 'pending', 'none', 'unknown'])
const COUNT_MAX = 100_000

export function sessionWorkUrl(origin: string, sessionId: string): string {
  return `${origin}/issue-links?scope=session&session=${encodeURIComponent(sessionId)}`
}

const UNKNOWN_CHECKS: ChecksSummary = { state: 'unknown', total: 0, failing: 0, pending: 0 }
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= COUNT_MAX

function parseChecks(value: unknown): ChecksSummary {
  if (!value || typeof value !== 'object') return UNKNOWN_CHECKS
  const c = value as Record<string, unknown>
  if (typeof c.state !== 'string' || !CHECKS_STATES.has(c.state) || !isCount(c.total) || !isCount(c.failing) || !isCount(c.pending)) return UNKNOWN_CHECKS
  return { state: c.state as ChecksState, total: c.total, failing: c.failing, pending: c.pending }
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Validated work of a session, or undefined when the answer cannot be read. */
export function parseSessionWork(data: unknown): SessionWork | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.prs) || !Array.isArray(d.issues)) return undefined
  if (typeof d.prsTruncated !== 'boolean' || typeof d.issuesTruncated !== 'boolean') return undefined
  const repo = d.repo
  if (repo !== null && (typeof repo !== 'string' || !REPO_RE.test(repo))) return undefined
  const prs: SessionPr[] = []
  for (const row of d.prs) {
    if (prs.length >= ISSUE_LINKS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.number !== 'number' || r.url !== `${repo}/pull/${r.number}`) continue
    if (typeof r.branch !== 'string' || r.branch.length === 0) continue
    prs.push({
      number: r.number, title: text(r.title, 200), url: r.url, branch: r.branch.slice(0, 200), checks: parseChecks(r.checks),
      ...(r.draft === true ? { draft: true } : {}),
    })
  }
  const issues: UnassignedIssue[] = []
  for (const row of d.issues) {
    if (issues.length >= ISSUE_LINKS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.number !== 'number' || r.url !== `${repo}/issues/${r.number}`) continue
    issues.push({ number: r.number, title: text(r.title, 200), url: r.url })
  }
  return { repo, prs, issues, prsTruncated: d.prsTruncated, issuesTruncated: d.issuesTruncated }
}

/** 'unknown-project': the relay does not know the project of this session, so it can prove nothing about its work. */
export type SessionWorkResult =
  | { status: 'ok'; work: SessionWork }
  | { status: 'unknown-project' }
  | { status: 'unavailable'; retryAfterMs?: number }

/** Work of a session. Only a successful, well-formed answer is "ok". Never throws. */
export async function loadSessionWork(
  origin: string, sessionId: string, fetchImpl: FetchLike, signal?: AbortSignal, timeoutMs = ISSUE_LINKS_TIMEOUT_MS,
): Promise<SessionWorkResult> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(sessionWorkUrl(origin, sessionId), { signal: ctrl.signal, cache: 'no-store' })
    if (res.status === 404) return { status: 'unknown-project' }
    if (!res.ok) return { status: 'unavailable', retryAfterMs: parseRetryAfter(res.headers?.get('Retry-After')) }
    const work = parseSessionWork(await res.json())
    return work ? { status: 'ok', work } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function sortPrsByBranch(prs: ReadonlyArray<SessionPr>): SessionPr[] {
  return [...prs].sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : a.number - b.number))
}

/** A PR belongs to the session only when the session recorded its branch and it is exactly the PR's head branch. */
export function isSessionBranch(prBranch: string, sessionBranch: string | undefined): boolean {
  return !!sessionBranch && prBranch === sessionBranch
}
