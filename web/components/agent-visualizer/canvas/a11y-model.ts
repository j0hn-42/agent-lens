/**
 * Pure builders for the accessible DOM mirror of the canvas graph (WCAG 1.1.1, 1.3.1, 4.1.2).
 * No React and no canvas here, so everything is unit-testable under node:test.
 * Imports are relative (not "@/") on purpose: the root test runner has no path aliases.
 */
import type { Agent, ToolCallNode, Discovery, Particle, Edge, TeamSummary } from '../../../lib/agent-types'
import type { AgentLink } from '../../../hooks/simulation/types'
import { formatTokens, formatCost, formatModelName } from '../../../lib/utils'
import { agentCostUsage } from '../../../lib/cost'
import { formatCostUsage, formatTokenUsage, usageFromAgent } from '../../../lib/usage'
import { toolEndWarning, toolStateText } from '../../../lib/tool-lifecycle'
import { formatToolName } from '../../../lib/mcp-tool'
import { describeModel } from '../../../lib/model-provenance'
import { STATE_LABEL_LONG, A11Y_HISTORY_MAX, A11Y_TOOLS_PER_AGENT, A11Y_ANNOUNCE_MAX } from '../../../lib/canvas-constants'
import type { StateTransition } from './detect-state-changes'
import { resolveLinks, LINK_STATE_LABEL_TEXT } from './link-geometry'
import {
  cleanText, teammateActivity, hasSeveralSessions, TEAM_DEFAULT_COLOR, orchestratorRole, isOrchestrator,
} from './team-style'
import { computeClusters, clusterAnnouncement, clusterNoun, type SessionMeta } from './cluster-model'
import { clusterLinkNotes } from './session-link-model'
import type { SessionLink } from '../../../lib/session-links'
import { isUnverifiedEdge, unverifiedReasonText } from './edge-style'
import { branchBadge, type BranchInfo, type CollapseView } from './branch-collapse'

/** Max characters of tool arguments / error text kept in the DOM mirror */
const MAX_TEXT = 240

function clip(text: string | undefined, max = MAX_TEXT): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function stateText(state: string): string {
  return STATE_LABEL_LONG[state] ?? state
}

/** "1.5k / 200k tokens", "at least 1.5k estimated / 200k tokens" or "tokens not reported". */
function tokenSummary(a: Agent): string {
  const usage = usageFromAgent(a)
  return usage.status === 'unavailable'
    ? `tokens ${formatTokenUsage(usage)}`
    : `${formatTokenUsage(usage)} / ${formatTokens(a.tokensMax)} tokens`
}

// ─── Tool-call history (kept after a tool card fades from the canvas) ────────

export interface ToolHistoryEntry {
  id: string
  agentId: string
  name: string
  args: string
  state: ToolCallNode['state']
  error: string
  result: string
  tokenCost?: number | null
  /** Caveat when the end of the call was not observed; empty otherwise */
  warning: string
}

/**
 * Fold the current tool calls into a persistent history keyed by id.
 * Entries are never removed because their canvas card faded, only evicted
 * (oldest first) once `max` is exceeded. Returns the same Map instance.
 */
export function updateToolHistory(
  history: Map<string, ToolHistoryEntry>,
  toolCalls: Map<string, ToolCallNode>,
  max = A11Y_HISTORY_MAX,
): Map<string, ToolHistoryEntry> {
  for (const [id, tc] of toolCalls) {
    const entry: ToolHistoryEntry = {
      id,
      agentId: tc.agentId,
      name: tc.mcp ? `MCP tool ${formatToolName(tc.toolName)}` : tc.toolName,
      args: clip(tc.args),
      state: tc.state,
      error: tc.state === 'error' ? clip(tc.errorMessage || tc.result) : '',
      result: tc.state === 'complete' ? clip(tc.result, 120) : '',
      tokenCost: tc.tokenCost,
      warning: toolEndWarning(tc) ?? '',
    }
    history.set(id, entry) // Map.set keeps the original insertion order for existing ids
  }
  while (history.size > max) {
    const oldest = history.keys().next()
    if (oldest.done) break
    history.delete(oldest.value)
  }
  return history
}

// ─── Communication history (dispatch / return labels vanish in under a second on the canvas) ──

export interface CommEntry {
  id: string
  /** e.g. "main dispatched task to Explorer: Find auth code" */
  text: string
}

/**
 * Record dispatch / return particles that carry a label so the exchange stays readable
 * after the particle is gone. Keyed by particle id; oldest evicted past `max`.
 */
export function updateCommHistory(
  history: Map<string, CommEntry>,
  particles: Particle[],
  edges: Edge[],
  agents: Map<string, Agent>,
  max = A11Y_HISTORY_MAX,
): Map<string, CommEntry> {
  if (particles.length > 0) {
    const edgeById = new Map(edges.map(e => [e.id, e]))
    for (const p of particles) {
      if ((p.type !== 'dispatch' && p.type !== 'return') || !p.label || history.has(p.id)) continue
      const edge = edgeById.get(p.edgeId)
      const from = edge ? agents.get(edge.from)?.name : undefined
      const to = edge ? agents.get(edge.to)?.name : undefined
      const who = p.type === 'dispatch'
        ? `${from ?? 'agent'} dispatched to ${to ?? 'sub-agent'}`
        : `${to ?? 'sub-agent'} returned to ${from ?? 'agent'}`
      history.set(p.id, { id: p.id, text: `${who}: ${clip(p.label, 160)}` })
    }
  }
  while (history.size > max) {
    const oldest = history.keys().next()
    if (oldest.done) break
    history.delete(oldest.value)
  }
  return history
}

// ─── DOM model ───────────────────────────────────────────────────────────────

export interface A11yToolItem extends ToolHistoryEntry {
  stateText: string
  /** Still present on the canvas (and therefore selectable through the simulation) */
  live: boolean
}

export interface A11yAgentItem {
  id: string
  name: string
  state: Agent['state']
  stateText: string
  model: string
  runtime: string
  /** "12k / 200k tokens" */
  tokens: string
  cost: string
  toolCalls: number
  isMain: boolean
  parentId: string | null
  /** "child of X" / "main agent" */
  relation: string
  childNames: string[]
  tools: A11yToolItem[]
  kind: NonNullable<Agent['kind']>
  /** Team name of a teammate (cleaned) */
  teamName?: string
  /** 'workflow' when the group is a Workflow run */
  teamKind?: 'team' | 'workflow'
  /** 'working' | 'idle' | 'done' for teammates */
  activityText?: string
  archived: boolean
  /** Session label, only when several sessions are on screen */
  sessionLabel?: string
  /** 'lead' (leads an Agent Team) or 'main' (main agent of a session): announced as the orchestrator */
  orchestrator?: 'lead' | 'main'
  /** Cluster (session / team) the agent belongs to, when that cluster is shown */
  clusterKey?: string
  /** Collapsible branch state (agents with sub-agents that are not the root of a tree) */
  branch?: { collapsed: boolean; pinned: boolean; text: string }
}

/** Mirror wording of a branch: the same facts as its canvas badge. */
function branchItem(info: BranchInfo | undefined): A11yAgentItem['branch'] {
  if (!info) return undefined
  if (!info.collapsed) {
    const n = info.children.length
    return { collapsed: false, pinned: info.pinned, text: `Expanded branch, ${n} sub-agent${n === 1 ? '' : 's'}` }
  }
  return { collapsed: true, pinned: info.pinned, text: `Collapsed branch, ${branchBadge(info).label}` }
}

/** A session or team cluster: a heading of the outline, with the agents it holds */
export interface A11yClusterItem {
  key: string
  kind: 'session' | 'team'
  /** Team clusters: 'workflow' for a Workflow run */
  teamKind?: 'team' | 'workflow'
  title: string
  /** "Session X, 3 agents, Claude, workspace w, working, cost $0.12" */
  text: string
  memberIds: string[]
  /** Validated '#rrggbb' */
  color: string
}

export interface A11yTeamItem {
  /** Unique key (two sessions can both have a team of the same name) */
  key: string
  name: string
  /** Validated '#rrggbb' */
  color: string
  memberIds: string[]
  memberNames: string[]
  /** 'workflow' for a Workflow run (members are its agents) */
  teamKind?: 'team' | 'workflow'
  /** "Team X: a (working), b (idle)" or "Workflow X: ..." */
  text: string
}

export interface A11yLinkItem {
  id: string
  fromName: string
  toName: string
  kind: AgentLink['kind']
  count: number
  stateText: string
  /** "main to Explorer, spawn, 3 messages, in flight" */
  text: string
}

export interface A11yDiscoveryItem {
  id: string
  type: Discovery['type']
  label: string
  content: string
  agentName: string
}

export interface A11yModel {
  /** aria-label for the canvas wrapper */
  summary: string
  agents: A11yAgentItem[]
  discoveries: A11yDiscoveryItem[]
  /** Teams with at least two members on screen */
  teams: A11yTeamItem[]
  /** Communication links (every one is a button in the DOM list) */
  links: A11yLinkItem[]
  /** Session / team clusters, in outline order; agents without a cluster are listed first */
  clusters: A11yClusterItem[]
}

/** Optional inputs of the team-aware DOM model */
export interface A11yExtras {
  links?: Map<string, AgentLink>
  /** Parent -> child edges: lets the mirror say which parent links are unverified */
  edges?: Edge[]
  /** Collapse state of the branches (see branch-collapse.ts) */
  collapse?: CollapseView
  teams?: Map<string, TeamSummary>
  simTime?: number
  /** Workspace / label / runtime of the sessions (cluster headings) */
  sessions?: ReadonlyMap<string, SessionMeta>
  /** Proven parent -> child session links, worded in the heading of the clusters they connect */
  sessionLinks?: ReadonlyArray<SessionLink>
  /** Every agent of the simulation (even those a collapsed branch hides): cluster costs count them all */
  costAgents?: Iterable<Agent>
}

/** "3 agents, 2 running, 1 waiting for permission" */
export function buildGraphLabel(agents: Iterable<Pick<Agent, 'state'>>, teamCount = 0): string {
  let total = 0, running = 0, waiting = 0, errored = 0
  for (const a of agents) {
    total++
    if (a.state === 'thinking' || a.state === 'tool_calling') running++
    else if (a.state === 'waiting_permission') waiting++
    else if (a.state === 'error') errored++
  }
  if (total === 0) return 'Agent graph: no agents yet'
  const parts = [`${total} ${total === 1 ? 'agent' : 'agents'}`, `${running} running`, `${waiting} waiting for permission`]
  if (errored > 0) parts.push(`${errored} in error`)
  if (teamCount > 0) parts.push(`${teamCount} ${teamCount === 1 ? 'team' : 'teams'}`)
  return `Agent graph: ${parts.join(', ')}`
}

export function buildA11yModel(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  discoveries: Discovery[],
  history: Map<string, ToolHistoryEntry>,
  extras: A11yExtras = {},
): A11yModel {
  const toolsByAgent = new Map<string, A11yToolItem[]>()
  for (const entry of history.values()) {
    let list = toolsByAgent.get(entry.agentId)
    if (!list) { list = []; toolsByAgent.set(entry.agentId, list) }
    list.push({ ...entry, stateText: toolStateText(entry), live: toolCalls.has(entry.id) })
  }
  const childNames = new Map<string, string[]>()
  for (const a of agents.values()) {
    if (a.parentId) {
      let list = childNames.get(a.parentId)
      if (!list) { list = []; childNames.set(a.parentId, list) }
      list.push(a.name)
    }
  }

  const showSession = hasSeveralSessions(agents.values())
  const clusterList = computeClusters(agents.values(), extras.teams, { sessions: extras.sessions, costAgents: extras.costAgents })
  const linkNotes = clusterLinkNotes(clusterList, extras.sessionLinks ?? [], extras.sessions)
  const clusterOf = new Map<string, string>()
  for (const c of clusterList) for (const id of c.memberIds) clusterOf.set(id, c.key)
  const unverifiedChildren = new Map<string, string>()
  for (const e of extras.edges ?? []) if (isUnverifiedEdge(e)) unverifiedChildren.set(e.to, unverifiedReasonText(e.unverifiedReason))
  const agentItems: A11yAgentItem[] = []
  for (const a of agents.values()) {
    const parent = a.parentId ? agents.get(a.parentId) : undefined
    const tools = toolsByAgent.get(a.id) ?? []
    agentItems.push({
      id: a.id,
      name: a.name,
      state: a.state,
      stateText: stateText(a.state),
      model: describeModel(a, formatModelName),
      runtime: a.runtime === 'codex' ? 'Codex' : 'Claude',
      tokens: tokenSummary(a),
      cost: formatCostUsage(agentCostUsage(a)),
      toolCalls: a.toolCalls,
      isMain: a.isMain,
      parentId: a.parentId,
      relation: parent ? `child of ${parent.name}${unverifiedChildren.has(a.id) ? ` (unverified link${unverifiedChildren.get(a.id) ? `: ${unverifiedChildren.get(a.id)}` : ''})` : ''}` : a.isMain ? 'main agent' : 'no parent',
      childNames: childNames.get(a.id) ?? [],
      tools: tools.length > A11Y_TOOLS_PER_AGENT ? tools.slice(tools.length - A11Y_TOOLS_PER_AGENT) : tools,
      kind: a.kind ?? (a.isMain ? 'main' : 'subagent'),
      teamName: cleanText(a.teamName) || undefined,
      teamKind: a.teamKind === 'workflow' ? 'workflow' : undefined,
      activityText: teammateActivity(a),
      archived: !!a.archived,
      sessionLabel: showSession ? cleanText(a.sessionLabel, 40) || undefined : undefined,
      orchestrator: orchestratorRole(a, extras.teams) ?? undefined,
      clusterKey: clusterOf.get(a.id),
      branch: branchItem(extras.collapse?.branches.get(a.id)),
    })
  }

  const teams = buildTeamItems(agents, extras.teams, extras.sessions)
  const links = buildLinkItems(agents, extras.links, extras.simTime ?? 0)

  return {
    summary: buildGraphLabel(agents.values(), teams.length),
    teams,
    links,
    clusters: clusterList.map(c => ({
      key: c.key, kind: c.kind, ...(c.teamKind ? { teamKind: c.teamKind } : {}), title: c.title, text: [clusterAnnouncement(c), ...(linkNotes.get(c.key) ?? [])].join(', '), memberIds: c.memberIds, color: c.color,
    })),
    agents: agentItems,
    discoveries: discoveries.map(d => ({
      id: d.id,
      type: d.type,
      label: clip(d.label, 80),
      content: clip(d.content, 160),
      agentName: agents.get(d.agentId)?.name ?? 'unknown agent',
    })),
  }
}

// ─── Teams and links ─────────────────────────────────────────────────────────

/** Teams with at least two visible members, with their members and activities. One entry per team and lead session. */
export function buildTeamItems(
  agents: Map<string, Agent>, teams?: Map<string, TeamSummary>, sessions?: ReadonlyMap<string, SessionMeta>,
): A11yTeamItem[] {
  return computeClusters(agents.values(), teams, { sessions })
    .map(c => ({
      c,
      // The team itself: its teammates and its lead (not the other agents of the hosting session)
      members: c.memberIds.map(id => agents.get(id)).filter((a): a is Agent => !!a && (!!cleanText(a.teamName) || isOrchestrator(a))),
    }))
    .filter(({ c, members }) => c.kind === 'team' && members.length >= 2)
    .map(({ c, members }) => {
      const parts = members.map(m => {
        const activity = teammateActivity(m)
        return `${cleanText(m.name, 60)}${activity ? ` (${activity})` : m.archived ? ' (archived)' : ''}`
      })
      return {
        key: c.key,
        name: c.title,
        color: c.color || TEAM_DEFAULT_COLOR,
        memberIds: members.map(m => m.id),
        memberNames: members.map(m => cleanText(m.name, 60)),
        teamKind: c.teamKind ?? 'team',
        text: `${clusterNoun(c)} ${c.title}: ${parts.join(', ')}`,
      }
    })
}

/** One entry per link whose ends exist as agents; names are resolved through the agents map. */
export function buildLinkItems(agents: Map<string, Agent>, links: Map<string, AgentLink> | undefined, simTime: number): A11yLinkItem[] {
  return resolveLinks(links, agents, simTime).map(r => {
    const fromName = cleanText(agents.get(r.fromKey)?.name, 60) || 'agent'
    const toName = cleanText(agents.get(r.toKey)?.name, 60) || 'agent'
    const stateText = LINK_STATE_LABEL_TEXT[r.state]
    const noun = r.count === 1 ? 'message' : 'messages'
    return {
      id: r.id,
      fromName,
      toName,
      kind: r.link.kind,
      count: r.count,
      stateText,
      text: `${fromName} to ${toName}, ${r.link.kind}, ${r.count} ${noun}, ${stateText}`,
    }
  })
}

// ─── Live-region announcements ───────────────────────────────────────────────

/** Human sentence for a semantic transition, or null when it is not worth announcing. */
export function describeTransition(t: StateTransition): string | null {
  switch (t.kind) {
    case 'agent_spawn': return `Agent ${t.name} started`
    case 'agent_complete': return `Agent ${t.name} completed`
    case 'agent_error': return `Agent ${t.name} failed`
    case 'agent_waiting_permission': return `Agent ${t.name} is waiting for permission`
    case 'tool_error': return `Tool ${t.name} failed`
    case 'agent_activity': return `${t.name} is ${t.activity}`
    case 'message_sent': return `${t.from} sent a message to ${t.to}`
    // Tool start/complete are too chatty for a polite live region; they live in the list.
    default: return null
  }
}

/** More announceable transitions than this in one pass (e.g. a session just loaded) collapse into one summary. */
export const ANNOUNCE_BULK_THRESHOLD = 4

/** Append announcements, keeping only the last `max` (older ones would be read late and out of context). */
export function pushAnnouncements(current: string[], transitions: StateTransition[], max = A11Y_ANNOUNCE_MAX): string[] {
  const texts: string[] = []
  for (const t of transitions) {
    const text = describeTransition(t)
    if (text) texts.push(text)
  }
  if (texts.length === 0) return current
  const added = texts.length > ANNOUNCE_BULK_THRESHOLD ? [`${texts.length} agent graph updates`] : texts
  const next = [...current, ...added]
  return next.length > max ? next.slice(next.length - max) : next
}

// ─── Append-only announcement queue (stable ids => stable React keys) ───────

export interface AnnouncementItem {
  /** Monotonic id, never reused: used as the React key so older messages are never remounted / re-read */
  id: number
  text: string
}

export interface AnnouncementQueue {
  items: AnnouncementItem[]
  nextId: number
}

export function createAnnouncementQueue(): AnnouncementQueue {
  return { items: [], nextId: 1 }
}

/**
 * Append announcements for `transitions`. Existing items keep their ids when the window slides,
 * duplicates inside one batch are dropped, and bulk batches collapse into one summary.
 * Returns the same queue object when nothing was added.
 */
export function enqueueAnnouncements(queue: AnnouncementQueue, transitions: StateTransition[], max = A11Y_ANNOUNCE_MAX): AnnouncementQueue {
  const texts: string[] = []
  for (const t of transitions) {
    const text = describeTransition(t)
    if (text && !texts.includes(text)) texts.push(text)
  }
  if (texts.length === 0) return queue
  const added = texts.length > ANNOUNCE_BULK_THRESHOLD ? [`${texts.length} agent graph updates`] : texts
  let nextId = queue.nextId
  const items = [...queue.items, ...added.map(text => ({ id: nextId++, text }))]
  return { items: items.length > max ? items.slice(items.length - max) : items, nextId }
}
