/**
 * Pure model of the sessions panel (cctop-like list): sessions grouped under their team, each with the
 * tree of its agents and sub-agents. Free of React/DOM so it can be unit-tested with node:test.
 */
import { ALL_SESSIONS_ID, type SessionInfo } from './bridge-types'
import { buildTabModel } from './chrome-utils'
import { isSessionObserved } from './session-model'

/** The slice of an Agent the panel needs. */
export interface AgentLike {
  id: string
  sessionId: string
  /** agentKey of the real parent (null for a root agent) */
  parentKey: string | null
  name: string
  state: string
  kind?: 'main' | 'subagent' | 'teammate'
  currentTool?: string
  tokensUsed: number
  spawnTime: number
  /** Wall-clock ms of the last live event (freshness, issue #48); absent = never observed */
  lastEventAt?: number
  freshnessSource?: 'live' | 'history'
}

export interface AgentNode<A extends AgentLike = AgentLike> {
  agent: A
  children: AgentNode<A>[]
}

/**
 * Agents of every session as forests, keyed by session id. A root is an agent without a parent, or
 * whose parent is not part of the same session (the parent may be hidden or already pruned).
 * Siblings are ordered by spawn time, then id, so the order is stable between renders.
 */
export function buildAgentForests<A extends AgentLike>(agents: Iterable<A>): Map<string, AgentNode<A>[]> {
  const nodes = new Map<string, AgentNode<A>>()
  for (const agent of agents) nodes.set(agent.id, { agent, children: [] })
  const forests = new Map<string, AgentNode<A>[]>()
  for (const node of nodes.values()) {
    const parent = node.agent.parentKey ? nodes.get(node.agent.parentKey) : undefined
    if (parent && parent !== node && parent.agent.sessionId === node.agent.sessionId && !isAncestor(node, parent, nodes)) {
      parent.children.push(node)
    } else {
      const roots = forests.get(node.agent.sessionId)
      if (roots) roots.push(node)
      else forests.set(node.agent.sessionId, [node])
    }
  }
  const order = (a: AgentNode<A>, b: AgentNode<A>) =>
    a.agent.spawnTime - b.agent.spawnTime || (a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0)
  for (const node of nodes.values()) node.children.sort(order)
  for (const roots of forests.values()) roots.sort(order)
  return forests
}

/** True when `candidate` is `node` or one of its descendants (guards against parent cycles). */
function isAncestor<A extends AgentLike>(node: AgentNode<A>, candidate: AgentNode<A>, all: Map<string, AgentNode<A>>): boolean {
  const seen = new Set<string>()
  let cur: AgentNode<A> | undefined = candidate
  while (cur && !seen.has(cur.agent.id)) {
    if (cur === node) return true
    seen.add(cur.agent.id)
    cur = cur.agent.parentKey ? all.get(cur.agent.parentKey) : undefined
  }
  return false
}

/** Number of agents in a forest (roots and all descendants). */
export function countAgents(roots: ReadonlyArray<AgentNode>): number {
  let n = 0
  for (const r of roots) n += 1 + countAgents(r.children)
  return n
}

export interface SessionRow {
  /** 'project' is a non-selectable group heading (issue #62) */
  kind: 'all' | 'team' | 'session' | 'project'
  /** Selection id: ALL_SESSIONS_ID, 'team:<name>', the session id, or 'project:<id>' for a heading */
  id: string
  teamName?: string
  /** Project of a 'project' heading and of the sessions grouped under it */
  projectId?: string
  projectName?: string
  session?: SessionInfo
  /** Agents of the session; on the 'All' row, the agents whose session is not listed */
  roots: AgentNode[]
  agentCount: number
}

/**
 * Rows of the panel in display order: 'All', then every team followed by its member sessions, then the
 * sessions without a team. Within each block active sessions come before completed ones (most recent first).
 */
export function buildSessionRows(
  sessions: ReadonlyArray<SessionInfo>,
  teamNames: Iterable<string>,
  forests: ReadonlyMap<string, AgentNode[]>,
  /** Active sessions that are not observed (issue #52) are listed after the proven ones */
  isObserved?: (session: SessionInfo) => boolean,
): SessionRow[] {
  const byId = new Map(sessions.map(s => [s.id, s]))
  const rank = (s: SessionInfo) => (s.status !== 'active' ? 2 : isObserved && !isObserved(s) ? 1 : 0)
  const sortedSessions = [...sessions].sort((a, b) => rank(a) - rank(b) || b.lastActivityTime - a.lastActivityTime)
  const items = buildTabModel(sortedSessions, teamNames)
  // buildTabModel keeps the input order inside each block, which is the sorted order
  const rows: SessionRow[] = []
  // Agents whose session is not (yet) listed, e.g. the demo or events without a session id: kept visible under 'All'
  const orphans = [...forests].filter(([sessionId]) => !byId.has(sessionId)).flatMap(([, roots]) => roots)
  const sessionRow = (item: { id: string; teamName?: string }): SessionRow | null => {
    const session = byId.get(item.id)
    if (!session) return null
    const roots = forests.get(session.id) ?? []
    return {
      kind: 'session', id: session.id, teamName: item.teamName, session, roots, agentCount: countAgents(roots),
      ...(session.projectId ? { projectId: session.projectId, projectName: session.projectName } : {}),
    }
  }
  const teamless: SessionRow[] = []
  for (const item of items) {
    if (item.kind === 'session') {
      const row = sessionRow(item)
      if (row) (item.teamName ? rows : teamless).push(row)
    } else {
      const roots = item.kind === 'all' ? orphans : []
      rows.push({ kind: item.kind, id: item.id, teamName: item.teamName, roots, agentCount: countAgents(roots) })
    }
  }
  rows.push(...groupByProject(teamless))
  return rows
}

/** Heading of the sessions that belong to no known project; it carries no projectId */
const NO_PROJECT_ID = 'project:none'
const NO_PROJECT_NAME = 'No repository'

/**
 * Sessions without a team grouped by project (git common dir, so worktrees of one repo stay together),
 * each group under a heading row. A group follows the order of its best-ranked session; sessions outside
 * git (or whose project could not be determined) come last under their own heading, so they are never
 * read as belonging to the previous project. With fewer than two projects a heading adds nothing: the order is kept.
 */
function groupByProject(sessionRows: SessionRow[]): SessionRow[] {
  const groups = new Map<string, SessionRow[]>()
  const ungrouped: SessionRow[] = []
  for (const row of sessionRows) {
    if (!row.projectId) { ungrouped.push(row); continue }
    const g = groups.get(row.projectId)
    if (g) g.push(row)
    else groups.set(row.projectId, [row])
  }
  if (groups.size < 2) return sessionRows
  const out: SessionRow[] = []
  for (const [projectId, members] of groups) {
    out.push({ kind: 'project', id: `project:${projectId}`, projectId, projectName: members[0].projectName, roots: [], agentCount: 0 })
    out.push(...members)
  }
  if (ungrouped.length) {
    out.push({ kind: 'project', id: NO_PROJECT_ID, projectName: NO_PROJECT_NAME, roots: [], agentCount: 0 })
    out.push(...ungrouped)
  }
  return out
}

/** Visible label of the current selection, shown on the panel's button. */
export function selectionLabel(
  selectedId: string | null,
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label'>>,
): string {
  if (selectedId === null || selectedId === ALL_SESSIONS_ID) return 'All sessions'
  if (selectedId.startsWith('team:')) return `Team ${selectedId.slice('team:'.length)}`
  return sessions.find(s => s.id === selectedId)?.label ?? 'Session'
}

/** "just now", "5s ago", "3 min ago", "2 h ago", "4 d ago" */
export function formatRelativeTime(timestamp: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (!Number.isFinite(sec) || sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`
  return `${Math.floor(sec / 86400)} d ago`
}

/**
 * Sessions kept by the 'Active only' filter: the active ones that are actually observed (a session
 * listed from disk without any received event is not counted as active, issue #52), plus the selected
 * session so the current selection never vanishes from the list. By default observation comes from the
 * app-wide tracker; pass `isObserved` to include other evidence (e.g. a live hook flag).
 */
export function filterActiveSessions(
  sessions: ReadonlyArray<SessionInfo>,
  selectedId: string | null,
  /** Whether an active session has been heard from; defaults to the app-wide observation tracker */
  isObserved: (session: SessionInfo) => boolean = s => isSessionObserved(s),
): SessionInfo[] {
  return sessions.filter(s => (s.status === 'active' && isObserved(s)) || s.id === selectedId)
}

/** Teams kept by the 'Active only' filter: those with a remaining session or a member still working. */
export function filterActiveTeams(
  teamNames: Iterable<string>,
  remainingSessions: ReadonlyArray<Pick<SessionInfo, 'teamName'>>,
  teamWorking?: ReadonlyMap<string, number>,
): string[] {
  return [...teamNames].filter(n => remainingSessions.some(s => s.teamName === n) || (teamWorking?.get(n) ?? 0) > 0)
}
