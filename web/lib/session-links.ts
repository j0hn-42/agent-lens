/**
 * Links between sessions: a parent session and the child sessions it launched (Task or worktree).
 * A 'task' link is a declared fact (the source names the parent, and it is listed). A 'worktree' link is
 * an inference, worded as one: a session running in `<repo>/.claude/worktrees/<name>` of the one session
 * of that repo that was alive when it started (started before, last active at or after). Duplicates,
 * conflicts, cycles and unknown parents yield no link. Pure (no React), stateless and bounded: the links
 * are re-derived from the session list, so a pruned session drops its links.
 * Limit: an edge joins two session halos, so both sessions must have agents on the canvas; a session
 * listed without events (index-only) has no halo and its links are not drawn.
 */
import type { SessionInfo } from './bridge-types'

/** Only the most recently active sessions are considered, whatever the size of the list. */
export const MAX_LINK_SESSIONS = 500

export type SessionLinkKind = 'task' | 'worktree'

export interface SessionLink {
  parentId: string
  childId: string
  kind: SessionLinkKind
}

type LinkSession = Pick<SessionInfo, 'id' | 'startTime' | 'lastActivityTime' | 'cwd' | 'parentSessionId'>

const WORKTREE_MARKER = '/.claude/worktrees/'

function normalizePath(p: string | undefined): string | undefined {
  if (!p) return undefined
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return n || undefined
}

/** Repository root of a worktree cwd (`<root>/.claude/worktrees/<name>[/...]`), else undefined. */
function worktreeRoot(cwd: string | undefined): string | undefined {
  const n = normalizePath(cwd)
  if (!n) return undefined
  const i = n.indexOf(WORKTREE_MARKER)
  if (i <= 0) return undefined
  return n.length > i + WORKTREE_MARKER.length ? n.slice(0, i) : undefined
}

/** One entry per id; an id listed twice with different facts is ambiguous and excluded. */
function uniqueSessions(sessions: ReadonlyArray<LinkSession>): LinkSession[] {
  const byId = new Map<string, LinkSession | null>()
  const sig = (x: LinkSession) => `${normalizePath(x.cwd) ?? ''}\u0000${x.parentSessionId ?? ''}`
  for (const x of sessions) {
    if (!x || typeof x.id !== 'string' || !x.id) continue
    const prev = byId.get(x.id)
    if (prev === undefined) byId.set(x.id, x)
    else if (prev !== null && sig(prev) !== sig(x)) byId.set(x.id, null)
  }
  return [...byId.values()].filter((x): x is LinkSession => x !== null)
}

export function deriveSessionLinks(sessionsIn: ReadonlyArray<LinkSession>): SessionLink[] {
  const all = uniqueSessions(sessionsIn)
  const sessions = [...all]
    .sort((a, b) => b.lastActivityTime - a.lastActivityTime || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_LINK_SESSIONS)
  const known = new Set(sessions.map(x => x.id))
  // Candidates are counted over the whole list, not the bounded one: a root session cut by the bound
  // must still make the remaining candidate ambiguous
  const byRoot = new Map<string, LinkSession[]>()
  for (const x of all) {
    const cwd = normalizePath(x.cwd)
    if (!cwd) continue
    const list = byRoot.get(cwd)
    if (list) list.push(x)
    else byRoot.set(cwd, [x])
  }

  const parentOf = new Map<string, SessionLink>()
  for (const child of sessions) {
    const declared = child.parentSessionId
    const root = worktreeRoot(child.cwd)
    const candidates = root ? (byRoot.get(root) ?? []).filter(p => p.id !== child.id && p.startTime <= child.startTime) : []
    // The one candidate must also have been alive when the child started: a session that ended earlier proves nothing
    const inferred = candidates.length === 1 && known.has(candidates[0].id) && candidates[0].lastActivityTime >= child.startTime
      ? candidates[0].id : undefined

    if (declared !== undefined && declared !== '') {
      if (declared === child.id || !known.has(declared)) continue
      if (inferred !== undefined && inferred !== declared) continue // conflicting evidence
      parentOf.set(child.id, { parentId: declared, childId: child.id, kind: 'task' })
    } else if (inferred !== undefined) {
      parentOf.set(child.id, { parentId: inferred, childId: child.id, kind: 'worktree' })
    }
  }

  // A cycle has no parent to speak of: every link on it is dropped
  const inCycle = new Set<string>()
  for (const start of parentOf.keys()) {
    const path: string[] = []
    const seen = new Set<string>()
    let cur: string | undefined = start
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      path.push(cur)
      cur = parentOf.get(cur)?.parentId
    }
    if (cur !== undefined) for (const id of path.slice(path.indexOf(cur))) inCycle.add(id)
  }
  return [...parentOf.values()]
    .filter(l => !inCycle.has(l.childId))
    .sort((a, b) => (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0))
}

/** Sentence for assistive technology and tooltips: "<child> appears to run in a worktree of <parent>" (an inference, not a declared fact). */
export function describeSessionLink(link: SessionLink, sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label'>>): string {
  const label = (id: string) => sessions.find(x => x.id === id)?.label || id
  return link.kind === 'worktree'
    ? `${label(link.childId)} appears to run in a worktree of ${label(link.parentId)}`
    : `${label(link.childId)} was launched by ${label(link.parentId)}`
}
