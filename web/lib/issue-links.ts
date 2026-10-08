/**
 * Issue / PR links of an agent role (#63), as served by the relay's GET /issue-links.
 * Everything coming back is validated again: only plain github.com issue/PR URLs are ever rendered
 * as links, and any failure (relay without gh, network, bad JSON) simply yields no link.
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

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: 'no-store' }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** Links of a role; [] on any failure. Never throws. */
export async function loadIssueLinks(origin: string, role: string, fetchImpl: FetchLike, signal?: AbortSignal, sessionId?: string): Promise<IssueLink[]> {
  try {
    const res = await fetchImpl(issueLinksUrl(origin, role, sessionId), { signal, cache: 'no-store' })
    if (!res.ok) return []
    return parseIssueLinks(await res.json())
  } catch {
    return []
  }
}

export function issueLinkLabel(link: IssueLink): string {
  const prefix = link.kind === 'pr' ? 'PR' : 'Issue'
  const draft = link.draft ? ' (draft)' : ''
  return `${prefix} #${link.number}${draft}${link.title ? ` ${link.title}` : ''}`
}
