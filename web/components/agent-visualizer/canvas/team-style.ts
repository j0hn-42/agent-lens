/**
 * Pure helpers for Agent Team rendering on the canvas: colour validation, visibility of
 * teammates / archived agents, label layout, team halos and the cohesion force.
 * No React and no canvas here, so everything is unit-testable under node:test.
 * Runtime imports are relative (the root test runner has no "@/" alias).
 * All strings coming from events are untrusted: they are cleaned and capped before use.
 */
import { NODE } from '../../../lib/agent-types'
import type { Agent, TeamSummary } from '../../../lib/agent-types'
import { MIN_VISIBLE_OPACITY, STATE_LABEL_SHORT, AGENT_DRAW } from '../../../lib/canvas-constants'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Accent used for teammates (and halos) whose team colour is missing or invalid */
export const TEAM_DEFAULT_COLOR = '#b794f6'
/** Draw opacity of archived (finished, kept) agents */
export const ARCHIVED_OPACITY = 0.55
/** Draw scale factor of archived agents (reduced node) */
export const ARCHIVED_SCALE = 0.85
/** Teammates never fade below this opacity (idle teammates must stay clearly visible) */
export const TEAMMATE_MIN_OPACITY = 0.7
/** Name width (world px) available to teammate labels, in node radii (regular agents use labelWidthMultiplier) */
export const TEAMMATE_LABEL_WIDTH_RADII = 7
/** Max lines of a teammate name */
export const TEAMMATE_NAME_LINES = 2
/** Padding between the outermost member and the halo edge (world px) */
export const HALO_PADDING = 48
/** Min members for a halo to be drawn */
export const HALO_MIN_MEMBERS = 2
/** Max characters of team names / session labels / free text kept for display */
export const MAX_TEAM_TEXT = 60

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** Strip control characters, collapse whitespace and cap the length (untrusted text). */
export function cleanText(value: unknown, max = MAX_TEAM_TEXT): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** '#rrggbb' only (never a CSS expression, named colour or alpha form); undefined otherwise. */
export function safeTeamColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : undefined
}

// ─── Agent classification ────────────────────────────────────────────────────

export type TeammateActivity = NonNullable<Agent['activity']>

export function isTeammate(agent: Pick<Agent, 'kind'>): boolean {
  return agent.kind === 'teammate'
}

/**
 * Is the agent drawn and clickable? Archived agents and teammates always are, whatever their
 * (possibly faded) opacity: the MIN_VISIBLE_OPACITY rule only applies to regular agents.
 */
export function isAgentVisible(agent: Pick<Agent, 'kind' | 'archived' | 'opacity'>): boolean {
  return !!agent.archived || agent.kind === 'teammate' || agent.opacity >= MIN_VISIBLE_OPACITY
}

/** Opacity the node is drawn with. */
export function agentDrawOpacity(agent: Pick<Agent, 'kind' | 'archived' | 'opacity'>): number {
  if (agent.archived) return ARCHIVED_OPACITY
  if (agent.kind === 'teammate') return Math.max(agent.opacity, TEAMMATE_MIN_OPACITY)
  return agent.opacity
}

/** Scale the node is drawn (and hit-tested) with. */
export function agentDrawScale(agent: Pick<Agent, 'archived' | 'scale'>): number {
  return (agent.scale || 1) * (agent.archived ? ARCHIVED_SCALE : 1)
}

/** Activity of a teammate (explicit field first, derived from the state otherwise); undefined for other agents. */
export function teammateActivity(agent: Pick<Agent, 'kind' | 'activity' | 'state'>): TeammateActivity | undefined {
  if (agent.kind !== 'teammate') return undefined
  if (agent.activity === 'working' || agent.activity === 'idle' || agent.activity === 'done') return agent.activity
  if (agent.state === 'complete') return 'done'
  if (agent.state === 'idle') return 'idle'
  return 'working'
}

/** Accent colour of a teammate: its validated team colour or the default. */
export function teammateAccent(agent: Pick<Agent, 'teamColor'>): string {
  return safeTeamColor(agent.teamColor) ?? TEAM_DEFAULT_COLOR
}

/**
 * Short text under the node name. Teammates show their activity ('working' / 'idle' / 'done'),
 * unless the state itself is more urgent (error, waiting for permission, paused).
 */
export function agentStatusText(agent: Pick<Agent, 'kind' | 'activity' | 'state'>): string {
  const activity = teammateActivity(agent)
  if (activity && agent.state !== 'error' && agent.state !== 'waiting_permission' && agent.state !== 'paused') return activity
  return STATE_LABEL_SHORT[agent.state] ?? agent.state
}

// ─── Label layout ────────────────────────────────────────────────────────────

export type MeasureText = (text: string) => number

/** Longest prefix length (>= 1) of `text` whose width fits `maxWidth`. */
function fitPrefix(text: string, maxWidth: number, measure: MeasureText): number {
  let lo = 1, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(text.slice(0, mid)) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** `text` cut to fit `maxWidth` with a trailing ellipsis. */
export function ellipsize(text: string, maxWidth: number, measure: MeasureText): string {
  if (measure(text) <= maxWidth) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(text.slice(0, mid).trimEnd() + '…') <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + '…' : '…'
}

/** Word-wrap `text` into at most `maxLines` lines; the last line ends with an ellipsis when text is left over. */
export function wrapLabel(
  text: string, maxWidth: number, measure: MeasureText, maxLines: number,
): { lines: string[]; truncated: boolean } {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return { lines: [''], truncated: false }
  const limit = Math.max(1, maxLines)
  const lines: string[] = []
  let rest = clean
  let truncated = false
  while (rest && lines.length < limit) {
    if (measure(rest) <= maxWidth) { lines.push(rest); rest = ''; break }
    if (lines.length === limit - 1) {
      lines.push(ellipsize(rest, maxWidth, measure))
      truncated = true
      rest = ''
      break
    }
    const n = fitPrefix(rest, maxWidth, measure)
    const space = rest.lastIndexOf(' ', n)
    const cut = space > 0 ? space : n
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return { lines, truncated }
}

export interface AgentLabelLayout {
  nameLines: string[]
  statusLine: string
  /** Third small line naming the session, when several sessions are on screen */
  sessionLine?: string
  /** The full name does not fit (the hover tooltip carries it) */
  truncated: boolean
  /** Number of lines added below the standard name + state lines */
  extraLines: number
}

/**
 * Lines drawn under a node. Teammates may use two name lines and a wider box; other agents keep
 * the single truncated line. `sessionLabel` is only shown when `showSession` is set.
 */
export function layoutAgentLabel(
  agent: Pick<Agent, 'kind' | 'name' | 'state' | 'activity' | 'sessionLabel'>,
  radius: number,
  measure: MeasureText,
  showSession = false,
): AgentLabelLayout {
  const teammate = agent.kind === 'teammate'
  const maxWidth = radius * (teammate ? TEAMMATE_LABEL_WIDTH_RADII : AGENT_DRAW.labelWidthMultiplier)
  const { lines, truncated } = wrapLabel(agent.name, maxWidth, measure, teammate ? TEAMMATE_NAME_LINES : 1)
  const session = showSession ? cleanText(agent.sessionLabel, 40) : ''
  const sessionLine = session ? ellipsize(session, maxWidth, measure) : undefined
  return {
    nameLines: lines,
    statusLine: agentStatusText(agent),
    sessionLine,
    truncated,
    extraLines: lines.length - 1 + (sessionLine ? 1 : 0),
  }
}

/** True when agents of more than one session are present (then labels name their session). */
export function hasSeveralSessions(agents: Iterable<Pick<Agent, 'sessionId'>>): boolean {
  let first: string | undefined
  let seen = false
  for (const a of agents) {
    if (!seen) { first = a.sessionId; seen = true } else if (a.sessionId !== first) return true
  }
  return false
}

// ─── Team halos ──────────────────────────────────────────────────────────────

export interface TeamHalo {
  name: string
  /** Validated '#rrggbb' */
  color: string
  cx: number
  cy: number
  r: number
  memberIds: string[]
}

function memberRadius(a: Agent): number {
  return (a.isMain ? NODE.radiusMain : NODE.radiusSub) * agentDrawScale(a)
}

/** Colour of a team: first valid member colour, then the team summary, then the default. */
export function teamColorFor(name: string, members: Array<Pick<Agent, 'teamColor'>>, teams?: Map<string, TeamSummary>): string {
  for (const m of members) {
    const c = safeTeamColor(m.teamColor)
    if (c) return c
  }
  const summary = teams?.get(name)
  if (summary) {
    for (const m of summary.members) {
      const c = safeTeamColor(m.color)
      if (c) return c
    }
  }
  return TEAM_DEFAULT_COLOR
}

/**
 * One halo per team with at least `minMembers` visible agents: a circle around the members'
 * centroid. Teams are sorted by name so the draw order is stable.
 */
export function computeTeamHalos(
  agents: Iterable<Agent>,
  teams?: Map<string, TeamSummary>,
  minMembers = HALO_MIN_MEMBERS,
): TeamHalo[] {
  const groups = new Map<string, Agent[]>()
  for (const a of agents) {
    const name = cleanText(a.teamName)
    if (!name || !isAgentVisible(a)) continue
    let list = groups.get(name)
    if (!list) { list = []; groups.set(name, list) }
    list.push(a)
  }
  const halos: TeamHalo[] = []
  for (const [name, members] of groups) {
    if (members.length < minMembers) continue
    let cx = 0, cy = 0
    for (const m of members) { cx += m.x; cy += m.y }
    cx /= members.length
    cy /= members.length
    let r = 0
    for (const m of members) r = Math.max(r, Math.hypot(m.x - cx, m.y - cy) + memberRadius(m))
    halos.push({
      name, color: teamColorFor(name, members, teams), cx, cy, r: r + HALO_PADDING,
      memberIds: members.map(m => m.id),
    })
  }
  return halos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Where the halo label is anchored (top centre, just outside the circle edge). */
export function haloLabelAnchor(h: Pick<TeamHalo, 'cx' | 'cy' | 'r'>): { x: number; y: number } {
  return { x: h.cx, y: h.cy - h.r - 6 }
}

// ─── Team cohesion force ─────────────────────────────────────────────────────

export interface CohesionNode { id: string; x?: number; y?: number; vx?: number; vy?: number }

/**
 * One step of a soft cohesion force: every member of a team (>= 2 nodes) is pulled towards its
 * team centroid with `strength * alpha`. Mutates vx / vy like any d3-force.
 */
export function teamCohesionStep(
  nodes: CohesionNode[], teamOf: (id: string) => string | undefined, strength: number, alpha: number,
): void {
  const sums = new Map<string, { x: number; y: number; n: number }>()
  for (const node of nodes) {
    const team = teamOf(node.id)
    if (!team || node.x === undefined || node.y === undefined) continue
    const s = sums.get(team) ?? { x: 0, y: 0, n: 0 }
    s.x += node.x; s.y += node.y; s.n++
    sums.set(team, s)
  }
  const k = strength * alpha
  for (const node of nodes) {
    const team = teamOf(node.id)
    const s = team ? sums.get(team) : undefined
    if (!s || s.n < 2 || node.x === undefined || node.y === undefined) continue
    node.vx = (node.vx ?? 0) + (s.x / s.n - node.x) * k
    node.vy = (node.vy ?? 0) + (s.y / s.n - node.y) * k
  }
}

/**
 * d3-force compatible force ("team cohesion"): `simulation.force('team', forceTeamCohesion(id => teamName))`.
 * It lives here (canvas side) because the simulation hook is owned elsewhere; see the work package notes.
 */
export function forceTeamCohesion(teamOf: (id: string) => string | undefined, strength = 0.08) {
  let nodes: CohesionNode[] = []
  const force = (alpha: number) => teamCohesionStep(nodes, teamOf, strength, alpha)
  force.initialize = (n: CohesionNode[]) => { nodes = n }
  force.strength = (s: number) => { strength = s; return force }
  return force
}
