/**
 * Issue / PR links of an agent role (#63), as served by the relay's GET /issue-links.
 * Everything coming back is validated again: only plain github.com issue/PR URLs are ever rendered
 * as links. A failure (busy relay, network, timeout, bad JSON) is never turned into "no link": the load
 * reports "unavailable" instead, which is neither cached nor shown as an empty list (#149).
 */
import type { Agent } from './agent-types'

export interface IssueLink {
  kind: 'issue' | 'pr'
  number: number
  title: string
  url: string
  state: string
  draft?: boolean
}

/** Freshness of a role's links in the web cache (mirrors RELAY_ISSUE_LINKS_CACHE_TTL_MS; a test compares them) */
export const ISSUE_LINKS_CACHE_TTL_MS = 60_000
/** Links shown in the inspector before "+N more" */
export const ISSUE_LINKS_SHOWN = 5
/** Entries accepted from the relay (the relay already bounds to 50 per kind) */
export const ISSUE_LINKS_MAX = 100

const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(issues|pull)\/(\d{1,9})$/

/** Role behind the `agent:<role>` label of an agent: its dispatch subagent type, else its team role. */
export function agentRoleOf(agent: Pick<Agent, 'subagentType' | 'agentType'>): string | undefined {
  for (const candidate of [agent.subagentType, agent.agentType]) {
    const role = typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''
    if (ROLE_RE.test(role)) return role
  }
  return undefined
}

/** `sessionId` lets the relay answer with the repository of the node's own project (the placeholder session is no session). */
export function issueLinksUrl(origin: string, role: string, sessionId?: string): string {
  const session = sessionId && sessionId !== 'default' ? `&session=${encodeURIComponent(sessionId)}` : ''
  return `${origin}/issue-links?role=${encodeURIComponent(role)}${session}`
}

/** Keep only well-formed entries whose URL is exactly the issue/PR page they claim to be. */
export function parseIssueLinks(data: unknown): IssueLink[] {
  const rows = data && typeof data === 'object' ? (data as { links?: unknown }).links : undefined
  if (!Array.isArray(rows)) return []
  const out: IssueLink[] = []
  for (const row of rows) {
    if (out.length >= ISSUE_LINKS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.url !== 'string' || typeof r.number !== 'number') continue
    const m = URL_RE.exec(r.url)
    if (!m || Number(m[2]) !== r.number) continue
    const kind = m[1] === 'pull' ? 'pr' : 'issue'
    if (r.kind !== kind) continue
    out.push({
      kind, number: r.number, url: r.url,
      title: typeof r.title === 'string' ? r.title.slice(0, 200) : '',
      state: typeof r.state === 'string' ? r.state.slice(0, 16) : 'open',
      ...(kind === 'pr' && r.draft === true ? { draft: true } : {}),
    })
  }
  return out
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: 'no-store' }) => Promise<{
  ok: boolean
  status?: number
  headers?: { get(name: string): string | null }
  json: () => Promise<unknown>
}>

/** Outcome of one load: a real answer (possibly a true empty list) or a failure that proves nothing. */
export type IssueLinksResult =
  | { status: 'ok'; links: IssueLink[] }
  | { status: 'unavailable'; retryAfterMs?: number }

/** Time allowed to one request before it counts as a failure */
export const ISSUE_LINKS_TIMEOUT_MS = 8_000
/** Retries after a failure (the first attempt is not counted); then the section stays "unavailable" until the next visit */
export const ISSUE_LINKS_MAX_RETRIES = 4
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

/** Retry-After as milliseconds (delay in seconds or HTTP date); undefined when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000
  if (!/[A-Za-z]/.test(v)) return undefined
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/**
 * Wait before retry number `attempt` (0 = first retry): exponential from 1 s, capped at 30 s, never below what the
 * relay asked for with Retry-After (itself capped), and never a tight loop.
 */
export function issueLinksRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))
  const asked = retryAfterMs === undefined ? 0 : Math.min(RETRY_MAX_MS, Math.max(0, retryAfterMs))
  return Math.max(backoff, asked)
}

/** Links of a role. Only a successful, well-formed answer is "ok"; anything else is "unavailable". Never throws. */
export async function loadIssueLinks(
  origin: string, role: string, fetchImpl: FetchLike, signal?: AbortSignal, sessionId?: string, timeoutMs = ISSUE_LINKS_TIMEOUT_MS,
): Promise<IssueLinksResult> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(issueLinksUrl(origin, role, sessionId), { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return { status: 'unavailable', retryAfterMs: parseRetryAfter(res.headers?.get('Retry-After')) }
    const body = await res.json()
    // A 200 without a links array is not "no link", it is an answer we cannot read
    if (!body || typeof body !== 'object' || !Array.isArray((body as { links?: unknown }).links)) return { status: 'unavailable' }
    return { status: 'ok', links: parseIssueLinks(body) }
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function issueLinkLabel(link: IssueLink): string {
  const prefix = link.kind === 'pr' ? 'PR' : 'Issue'
  const draft = link.draft ? ' (draft)' : ''
  return `${prefix} #${link.number}${draft}${link.title ? ` ${link.title}` : ''}`
}
