/**
 * Pure model of the fleet clusters: one cluster per session, and one per Agent Team. A cluster is
 * drawn as a halo around its agents with a label (name, runtime, workspace, status, cost) and is
 * mirrored in the DOM list as a heading. Cluster key = teamName ?? sessionId, made unique per
 * session so that two sessions that both have a team called "x" never share a halo.
 * No React and no canvas: unit-testable under node:test (relative runtime imports only).
 */
import type { Agent, TeamSummary } from '../../../lib/agent-types'
import { agentCost } from '../../../lib/cost'
import { formatCost } from '../../../lib/utils'
import { STATE_LABEL_LONG } from '../../../lib/canvas-constants'
import {
  cleanText, isAgentVisible, agentDrawRadius, safeTeamColor, TEAM_DEFAULT_COLOR, HALO_PADDING, isOrchestrator,
} from './team-style'

/** Optional per-session facts that are not on the agents (supplied by the app from its session list). */
export interface SessionMeta {
  label?: string
  workspace?: string
  runtime?: 'claude' | 'codex'
}

export type ClusterStatus = 'error' | 'waiting' | 'working' | 'idle' | 'complete'

export interface Cluster {
  /** 'session:<sessionId>' or 'team:<leadSessionId>:<teamName>' */
  key: string
  kind: 'session' | 'team'
  /** Team name, or the session label */
  title: string
  /** Validated '#rrggbb' */
  color: string
  cx: number
  cy: number
  r: number
  memberIds: string[]
  /** Orchestrator (main / lead agent), when present */
  orchestratorId?: string
  sessionIds: string[]
  /** Team name for team clusters */
  teamName?: string
  runtime: 'Claude' | 'Codex'
  workspace?: string
  status: ClusterStatus
  statusText: string
  cost: number
  costText: string
}

/** Session id of events that carry none (matches DEFAULT_SESSION_ID of the simulation) */
const DEFAULT_SESSION = 'default'

/** Distinct, validated halo colours for sessions (team clusters use the team colour). */
export const SESSION_PALETTE: readonly string[] = ['#66ccff', '#7ee0a8', '#ffcc66', '#ff9ec7', '#b79cff', '#9ad0ff', '#ffa978', '#8de3de']

/** Stable palette entry of a session id. */
export function sessionColor(sessionIdIn: string | undefined): string {
  const sessionId = sessionIdIn || DEFAULT_SESSION
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0
  return SESSION_PALETTE[h % SESSION_PALETTE.length]
}

/**
 * Session that a team's agent belongs to for clustering: the team's lead session when the agent's
 * session is the lead session or one of the members' sessions, the agent's own session otherwise.
 */
function groupSession(sessionIdIn: string | undefined, teamName: string, teams?: ReadonlyMap<string, TeamSummary>): string {
  const sessionId = sessionIdIn || DEFAULT_SESSION
  const t = teams?.get(teamName)
  if (!t) return sessionId
  if (sessionId === t.leadSessionId || t.members.some(m => m.sessionId === sessionId)) return t.leadSessionId
  return sessionId
}

/**
 * Cluster key of an agent: its team (unique per lead session) when it is a teammate or lives in the
 * session that hosts a team, its session otherwise. `hosted` maps a group session to the team it hosts.
 */
export function clusterKeyOf(
  agent: Pick<Agent, 'sessionId' | 'teamName'>,
  teams?: ReadonlyMap<string, TeamSummary>,
  hosted?: ReadonlyMap<string, string>,
): string {
  const team = cleanText(agent.teamName)
  if (team) return `team:${groupSession(agent.sessionId, team, teams)}:${team}`
  const hostedTeam = hosted?.get(agent.sessionId || DEFAULT_SESSION)
  if (hostedTeam) return `team:${groupSession(agent.sessionId, hostedTeam, teams)}:${hostedTeam}`
  return `session:${agent.sessionId || DEFAULT_SESSION}`
}

/** group session -> team hosted there (first team found among its teammates). */
function hostedTeams(agents: Agent[], teams?: ReadonlyMap<string, TeamSummary>): Map<string, string> {
  const hosted = new Map<string, string>()
  for (const a of agents) {
    const team = cleanText(a.teamName)
    if (!team) continue
    const group = groupSession(a.sessionId, team, teams)
    if (!hosted.has(group)) hosted.set(group, team)
  }
  return hosted
}

/** Aggregate state of a cluster: error, then waiting for permission, then working, then idle, then complete. */
export function clusterStatus(states: Iterable<Agent['state']>): ClusterStatus {
  let error = false, waiting = false, working = false, any = false, allComplete = true
  for (const s of states) {
    any = true
    if (s === 'error') error = true
    else if (s === 'waiting_permission') waiting = true
    else if (s === 'thinking' || s === 'tool_calling') working = true
    if (s !== 'complete') allComplete = false
  }
  if (error) return 'error'
  if (waiting) return 'waiting'
  if (working) return 'working'
  return any && allComplete ? 'complete' : 'idle'
}

const STATUS_TEXT: Record<ClusterStatus, string> = {
  error: 'error',
  waiting: 'waiting for permission',
  working: 'working',
  idle: 'idle',
  complete: STATE_LABEL_LONG.complete ?? 'complete',
}

export interface ClusterOptions {
  /** Facts about sessions that the agents do not carry (workspace, label, runtime) */
  sessions?: ReadonlyMap<string, SessionMeta>
  /** Halos of a single-session view need at least this many members (default 2); several clusters always show */
  minMembers?: number
}

function sessionTitle(sessionIdIn: string | undefined, agents: Agent[], meta?: SessionMeta): string {
  const sessionId = sessionIdIn || DEFAULT_SESSION
  const label = cleanText(meta?.label, 40) || cleanText(agents.find(a => a.sessionLabel)?.sessionLabel, 40)
  return label || cleanText(sessionId, 24) || 'session'
}

/**
 * Clusters of the visible agents. A cluster is returned when it has `minMembers` agents, or whenever
 * several clusters are on screen (so three single-agent sessions still get three halos).
 * Sorted by key so the draw and DOM order are stable.
 */
export function computeClusters(
  agentsIn: Iterable<Agent>,
  teams?: ReadonlyMap<string, TeamSummary>,
  options: ClusterOptions = {},
): Cluster[] {
  const agents = Array.from(agentsIn).filter(isAgentVisible)
  const hosted = hostedTeams(agents, teams)
  const groups = new Map<string, Agent[]>()
  for (const a of agents) {
    const key = clusterKeyOf(a, teams, hosted)
    let list = groups.get(key)
    if (!list) { list = []; groups.set(key, list) }
    list.push(a)
  }
  const minMembers = options.minMembers ?? 2
  const showAll = groups.size >= 2
  const out: Cluster[] = []
  for (const [key, members] of groups) {
    if (!showAll && members.length < minMembers) continue
    const isTeam = key.startsWith('team:')
    const teamName = isTeam ? cleanText(members.find(m => cleanText(m.teamName))?.teamName) : undefined
    const main = members.find(isOrchestrator) ?? members.find(m => m.isMain)
    const sessionIds = Array.from(new Set(members.map(m => m.sessionId || DEFAULT_SESSION)))
    const meta = options.sessions?.get((main ?? members[0]).sessionId || DEFAULT_SESSION)

    let cx = 0, cy = 0
    for (const m of members) { cx += m.x; cy += m.y }
    cx /= members.length
    cy /= members.length
    let r = 0
    for (const m of members) r = Math.max(r, Math.hypot(m.x - cx, m.y - cy) + agentDrawRadius(m))

    let color: string
    if (isTeam) {
      color = members.map(m => safeTeamColor(m.teamColor)).find(Boolean)
        ?? teams?.get(teamName ?? '')?.members.map(m => safeTeamColor(m.color)).find(Boolean)
        ?? TEAM_DEFAULT_COLOR
    } else {
      color = sessionColor(members[0].sessionId)
    }

    const runtimeRaw = (main ?? members[0]).runtime ?? meta?.runtime
    const status = clusterStatus(members.map(m => m.state))
    let cost = 0
    for (const m of members) cost += agentCost(m.tokensUsed, m.model)

    out.push({
      key,
      kind: isTeam ? 'team' : 'session',
      title: isTeam ? cleanText(teamName, 40) : sessionTitle(members[0].sessionId, members, meta),
      color,
      cx, cy, r: r + HALO_PADDING,
      memberIds: members.map(m => m.id),
      orchestratorId: main?.id,
      sessionIds,
      teamName: isTeam ? cleanText(teamName, 40) : undefined,
      runtime: runtimeRaw === 'codex' ? 'Codex' : 'Claude',
      workspace: cleanText(meta?.workspace, 40) || undefined,
      status,
      statusText: STATUS_TEXT[status],
      cost,
      costText: formatCost(cost),
    })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Two lines of a cluster label: the title, then runtime, workspace, status and cost. */
export function clusterLabelLines(c: Pick<Cluster, 'kind' | 'title' | 'memberIds' | 'runtime' | 'workspace' | 'statusText' | 'costText'>): { title: string; detail: string } {
  const kind = c.kind === 'team' ? 'Team' : 'Session'
  const n = c.memberIds.length
  const detail = [c.runtime, c.workspace, c.statusText, c.costText].filter(Boolean).join(' · ')
  return { title: `${kind} ${c.title} (${n})`, detail }
}

/** Sentence read by assistive technology for a cluster heading. */
export function clusterAnnouncement(c: Pick<Cluster, 'kind' | 'title' | 'memberIds' | 'runtime' | 'workspace' | 'statusText' | 'costText'>): string {
  const kind = c.kind === 'team' ? 'Team' : 'Session'
  const n = c.memberIds.length
  const parts = [`${kind} ${c.title}`, `${n} ${n === 1 ? 'agent' : 'agents'}`, c.runtime]
  if (c.workspace) parts.push(`workspace ${c.workspace}`)
  parts.push(c.statusText, `cost ${c.costText}`)
  return parts.join(', ')
}

/** Anchor of the halo label: top centre, just above the circle. */
export function clusterLabelAnchor(c: Pick<Cluster, 'cx' | 'cy' | 'r'>): { x: number; y: number } {
  return { x: c.cx, y: c.cy - c.r }
}

/** Camera target (world centre and radius) that frames the cluster. */
export function clusterBounds(c: Pick<Cluster, 'cx' | 'cy' | 'r'>): { cx: number; cy: number; r: number } {
  return { cx: c.cx, cy: c.cy, r: c.r }
}
