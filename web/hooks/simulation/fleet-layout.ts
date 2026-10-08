/**
 * Fleet layout (#36): deterministic placement of agent clusters in the 'All' view.
 * A cluster is a team (when agents carry a team name or their session belongs to a team) or
 * otherwise a session. With one cluster the main agent sits at (0,0); with several, cluster
 * anchors lie on a ring (or a phyllotaxis spiral for many) whose size grows with the members.
 * Pure: no React, no d3, no DOM.
 */
import type { Agent, TeamSummary } from '../../lib/agent-types'
import { AGENT_SPAWN_DISTANCE, CLUSTER_LAYOUT } from '../../lib/canvas-constants'
import { findTeam, teamOfAgent, phaseOfAgent } from './team-key'
import { visibleAgents } from '../../lib/inactive-agents'

export interface ClusterInput {
  key: string
  size: number
  /** Repository the cluster provably belongs to (see {@link clustersOf}); absent when unknown */
  projectId?: string
  /** Display name of that repository; only ever present together with projectId */
  projectName?: string
}
/** sessionId -> repository, from the session list (only sessions whose project is known). */
export type SessionProjects = ReadonlyMap<string, { projectId: string; projectName: string }>
export interface ClusterAnchor { key: string; x: number; y: number; radius: number }

type ClusterAgent = Pick<Agent, 'id' | 'sessionId' | 'teamName' | 'isMain' | 'clusterKey'>

/** Radius of the disc a cluster of `members` agents occupies. */
export function clusterRadius(members: number): number {
  const n = Number.isFinite(members) ? Math.min(Math.max(Math.floor(members), 1), CLUSTER_LAYOUT.maxMembers) : 1
  return CLUSTER_LAYOUT.baseRadius + n * CLUSTER_LAYOUT.memberSpacing
}

/** Namespaces of the cluster keys: a team called like a session id must not merge with that session. */
export const TEAM_CLUSTER_PREFIX = 'team:'
export const SESSION_CLUSTER_PREFIX = 'session:'

/**
 * Session a team's agent is grouped under: the team's lead session when the agent's session is the
 * lead session or one of the members' sessions, its own session otherwise. Mirrors the canvas
 * cluster model so the simulation and the halos agree on what one cluster is.
 */
function groupSession(sessionId: string, teamName: string, teams?: ReadonlyMap<string, TeamSummary>): string {
  const t = findTeam(teams, teamName, sessionId)
  return t ? t.leadSessionId : sessionId
}

/**
 * Cluster of an agent (namespaced, same format as the canvas cluster model): `team:<leadSession>:<name>`
 * for its team, else for the team its session belongs to, else `session:<id>`. Two teams with the same
 * name under different lead sessions are two clusters.
 */
export function clusterKeyOf(agent: Pick<Agent, 'sessionId' | 'teamName'>, teams?: ReadonlyMap<string, TeamSummary>): string {
  if (agent.teamName) return `${TEAM_CLUSTER_PREFIX}${groupSession(agent.sessionId, agent.teamName, teams)}:${agent.teamName}`
  const t = teamOfAgent(teams, agent)
  if (t) return `${TEAM_CLUSTER_PREFIX}${t.leadSessionId}:${t.name}`
  return SESSION_CLUSTER_PREFIX + agent.sessionId
}

/** Cluster key stamped on the agent when known (restamped on team changes), else computed. */
function keyOf(agent: Pick<Agent, 'sessionId' | 'teamName' | 'clusterKey'>, teams?: ReadonlyMap<string, TeamSummary>): string {
  return agent.clusterKey ?? clusterKeyOf(agent, teams)
}

function overlaps(placed: ClusterAnchor[], x: number, y: number, radius: number): boolean {
  for (const p of placed) {
    if (Math.hypot(p.x - x, p.y - y) < p.radius + radius + CLUSTER_LAYOUT.gap - 1e-6) return true
  }
  return false
}

function ringAnchors(items: Array<{ key: string; radius: number }>): ClusterAnchor[] {
  const n = items.length
  const need = items.map((it, i) => it.radius + items[(i + 1) % n].radius + CLUSTER_LAYOUT.gap)
  const span = (R: number): number => need.reduce((s, d) => s + 2 * Math.asin(Math.min(1, d / (2 * R))), 0)
  let lo = Math.max(...need) / 2
  let hi = lo * (n + 2)
  if (span(lo) > 2 * Math.PI) {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (span(mid) > 2 * Math.PI) lo = mid; else hi = mid
    }
  } else hi = lo
  let R = hi
  const slack = Math.max(0, 2 * Math.PI - span(R)) / n
  const angles: number[] = []
  let a = -Math.PI / 2
  for (let i = 0; i < n; i++) {
    angles.push(a)
    a += 2 * Math.asin(Math.min(1, need[i] / (2 * R))) + slack
  }
  const build = (): ClusterAnchor[] => items.map((it, i) => ({ key: it.key, radius: it.radius, x: Math.cos(angles[i]) * R, y: Math.sin(angles[i]) * R }))
  for (let guard = 0; guard < 200; guard++) {
    const out = build()
    if (out.every((p, i) => !overlaps(out.slice(0, i), p.x, p.y, p.radius))) return out
    R *= 1.05
  }
  return build()
}

function spiralAnchors(items: Array<{ key: string; radius: number }>): ClusterAnchor[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const placed: ClusterAnchor[] = []
  let k = 0
  for (const it of items) {
    for (;; k++) {
      const d = CLUSTER_LAYOUT.baseRadius * Math.sqrt(k + 0.5)
      const x = Math.cos(k * golden) * d
      const y = Math.sin(k * golden) * d
      if (!overlaps(placed, x, y, it.radius)) { placed.push({ key: it.key, x, y, radius: it.radius }); k++; break }
    }
  }
  return placed
}

/**
 * Clusters of a same project made contiguous: a project sits where its first cluster arrived, its
 * other clusters follow it. Clusters without projectId are never grouped and keep their slot.
 */
function groupByProject(clusters: ClusterInput[]): ClusterInput[] {
  const byProject = new Map<string, ClusterInput[]>()
  for (const c of clusters) {
    if (!c.projectId) continue
    const list = byProject.get(c.projectId)
    if (list) list.push(c); else byProject.set(c.projectId, [c])
  }
  const out: ClusterInput[] = []
  for (const c of clusters) {
    if (!c.projectId) { out.push(c); continue }
    const list = byProject.get(c.projectId)
    if (!list) continue
    out.push(...list)
    byProject.delete(c.projectId)
  }
  return out
}

/**
 * Anchor of every cluster, in the order given (first appearance, a project's clusters together). One cluster is centred on
 * (0,0). Discs (anchor, radius) never overlap. Pure and deterministic.
 */
export function computeClusterAnchors(clusters: ReadonlyArray<ClusterInput>): Map<string, ClusterAnchor> {
  const seen = new Set<string>()
  const unique: ClusterInput[] = []
  for (const c of clusters) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    unique.push(c)
  }
  const items = groupByProject(unique).map(c => ({ key: c.key, radius: clusterRadius(c.size) }))
  const out = new Map<string, ClusterAnchor>()
  if (items.length === 0) return out
  const list = items.length === 1
    ? [{ key: items[0].key, x: 0, y: 0, radius: items[0].radius }]
    : items.length <= CLUSTER_LAYOUT.maxRingClusters ? ringAnchors(items) : spiralAnchors(items)
  for (const a of list) out.set(a.key, a)
  return out
}

/** Clusters of the agents (first appearance order = Map insertion order) with their member counts. */
export function clustersOf(
  agents: Iterable<Pick<Agent, 'sessionId' | 'teamName' | 'clusterKey'>>,
  teams?: ReadonlyMap<string, TeamSummary>,
  projects?: SessionProjects,
): ClusterInput[] {
  const counts = new Map<string, number>()
  // Per cluster: the project every member agrees on, or null as soon as one member cannot prove it
  const owners = new Map<string, { projectId: string; projectName: string } | null>()
  for (const a of agents) {
    const key = keyOf(a, teams)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!projects) continue
    const p = projects.get(a.sessionId)
    const prev = owners.get(key)
    if (prev === null || !p) owners.set(key, null)
    else if (prev === undefined) owners.set(key, p)
    else if (prev.projectId !== p.projectId) owners.set(key, null)
  }
  return Array.from(counts, ([key, size]) => {
    const p = owners.get(key)
    return p ? { key, size, projectId: p.projectId, projectName: p.projectName } : { key, size }
  })
}

/** The lead of a cluster: its first main agent (by insertion order). */
export function leadOfCluster(
  agents: Iterable<ClusterAgent>,
  key: string,
  teams?: ReadonlyMap<string, TeamSummary>,
): ClusterAgent | undefined {
  for (const a of agents) if (a.isMain && keyOf(a, teams) === key) return a
  return undefined
}

/** Angle in the middle of the largest gap between `angles` (radians); `seed` picks the first one. */
export function freeAngle(angles: number[], seed: string): number {
  if (angles.length === 0) {
    const hash = seed.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)
    return (Math.abs(hash) % 360) * (Math.PI / 180)
  }
  const sorted = [...angles].sort((a, b) => a - b)
  let bestGap = 0
  let bestMid = 0
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2
    const gap = next - sorted[i]
    if (gap > bestGap) { bestGap = gap; bestMid = sorted[i] + gap / 2 }
  }
  return bestMid
}

export interface SpawnCandidate extends ClusterAgent {
  localId: string
  parentId: string | null
}

/**
 * Initial position of a new agent: around its parent in the free angular gap; without a parent
 * at its cluster anchor, or around the cluster lead when another main already holds the anchor
 * (e.g. tmux teammates' sessions sharing a team).
 */
export function spawnPosition(
  agents: ReadonlyMap<string, Agent>,
  candidate: SpawnCandidate,
  teams?: ReadonlyMap<string, TeamSummary>,
): { x: number; y: number } {
  const others = Array.from(agents.values()).filter(a => a.id !== candidate.id)
  const key = candidate.clusterKey ?? clusterKeyOf(candidate, teams)
  let around: Agent | undefined = candidate.parentId ? agents.get(candidate.parentId) : undefined
  const viaLead = !around
  if (!around) {
    const lead = leadOfCluster(others, key, teams)
    around = lead ? agents.get(lead.id) : undefined
  }
  if (around) {
    const angles: number[] = []
    for (const a of others) {
      const sibling = a.parentId === around.id
        || (viaLead && a.id !== around.id && !a.parentId && keyOf(a, teams) === key)
      if (sibling) angles.push(Math.atan2(a.y - around.y, a.x - around.x))
    }
    const angle = freeAngle(angles, candidate.localId)
    return { x: around.x + Math.cos(angle) * AGENT_SPAWN_DISTANCE, y: around.y + Math.sin(angle) * AGENT_SPAWN_DISTANCE }
  }
  const clusters = clustersOf(others, teams)
  const i = clusters.findIndex(c => c.key === key)
  if (i >= 0) clusters[i] = { key, size: clusters[i].size + 1 }; else clusters.push({ key, size: 1 })
  const anchor = computeClusterAnchors(clusters).get(key)
  return anchor ? { x: anchor.x, y: anchor.y } : { x: 0, y: 0 }
}

/** Re-stamp `clusterKey` on every agent; returns true when any changed (agents replaced in the map). */
export function restampClusterKeys(agents: Map<string, Agent>, teams?: ReadonlyMap<string, TeamSummary>): boolean {
  let changed = false
  for (const [id, a] of agents) {
    const key = clusterKeyOf(a, teams)
    if (a.clusterKey !== key) { agents.set(id, { ...a, clusterKey: key }); changed = true }
  }
  return changed
}

/** Re-stamp `phase` on every workflow agent from the team summaries; returns true when any changed. */
export function restampPhases(agents: Map<string, Agent>, teams?: ReadonlyMap<string, TeamSummary>): boolean {
  let changed = false
  for (const [id, a] of agents) {
    if (a.teamKind !== 'workflow' && a.phase === undefined) continue
    const phase = phaseOfAgent(a, teams)
    if (a.phase === phase) continue
    const { phase: _old, ...rest } = a
    agents.set(id, phase ? { ...rest, phase } : rest)
    changed = true
  }
  return changed
}

// ─── Force simulation helpers ───────────────────────────────────────────────

/**
 * Centre of every phase of a workflow cluster (#146): the phases, in the order given (first appearance),
 * sit evenly on a ring around the cluster anchor, so the members of one phase gather in one contiguous
 * sub-group. Pure and deterministic; the ring keeps inside the cluster disc.
 */
export function phaseAnchors(
  center: { x: number; y: number }, radius: number, phases: ReadonlyArray<string>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const unique = Array.from(new Set(phases))
  const ring = radius * CLUSTER_LAYOUT.phaseRingFactor
  unique.forEach((phase, i) => {
    const angle = -Math.PI / 2 + (i / unique.length) * 2 * Math.PI
    out.set(phase, { x: center.x + Math.cos(angle) * ring, y: center.y + Math.sin(angle) * ring })
  })
  return out
}

export interface ClusterNodeInfo {
  key: string
  anchor: { x: number; y: number }
  /** Members of a workflow phase are pulled to the centre of their phase rather than to the cluster anchor */
  pull?: { x: number; y: number }
  radius: number
  role: 'lead' | 'member' | 'archived'
}

/** Per-agent layout role and anchor, computed from the agents. */
export function layoutInfo(
  agents: ReadonlyMap<string, Agent>,
  teams?: ReadonlyMap<string, TeamSummary>,
  projects?: SessionProjects,
): { info: Map<string, ClusterNodeInfo>; anchors: Map<string, ClusterAnchor> } {
  const anchors = computeClusterAnchors(clustersOf(agents.values(), teams, projects))
  const leads = new Map<string, string>()
  for (const a of agents.values()) {
    const key = keyOf(a, teams)
    if (a.isMain && !leads.has(key)) leads.set(key, a.id)
  }
  // Phases of each workflow cluster, in order of first appearance (only phases an agent really announced)
  const phasesByCluster = new Map<string, string[]>()
  for (const a of agents.values()) {
    if (a.teamKind !== 'workflow' || !a.phase) continue
    const key = keyOf(a, teams)
    const list = phasesByCluster.get(key)
    if (!list) phasesByCluster.set(key, [a.phase]); else if (!list.includes(a.phase)) list.push(a.phase)
  }
  const phaseCentres = new Map<string, Map<string, { x: number; y: number }>>()
  for (const [key, phases] of phasesByCluster) {
    const anchor = anchors.get(key)
    if (anchor) phaseCentres.set(key, phaseAnchors(anchor, anchor.radius, phases))
  }
  const info = new Map<string, ClusterNodeInfo>()
  for (const a of agents.values()) {
    const key = keyOf(a, teams)
    const anchor = anchors.get(key)
    if (!anchor) continue
    const role = leads.get(key) === a.id ? 'lead' : a.archived ? 'archived' : 'member'
    const pull = role === 'member' && a.phase && a.teamKind === 'workflow' ? phaseCentres.get(key)?.get(a.phase) : undefined
    info.set(a.id, { key, anchor: { x: anchor.x, y: anchor.y }, radius: anchor.radius, role, ...(pull ? { pull } : {}) })
  }
  return { info, anchors }
}

interface PosNode { id: string; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }

const isPinned = (n: PosNode): boolean => n.fx != null || n.fy != null

/**
 * d3 force: leads are eased onto their anchor (their velocity is overridden, so the other forces
 * cannot push them away), members get a weak pull to it and archived agents drift to the outer
 * ring of their cluster disc. Keeping members inside the disc is done by constrainToClusters.
 * Register it last so it runs after the forces that would move the leads.
 */
export function createClusterForce(getInfo: (id: string) => ClusterNodeInfo | undefined) {
  let nodes: PosNode[] = []
  const force = (alpha: number): void => {
    for (const node of nodes) {
      const info = getInfo(node.id)
      if (!info || node.x === undefined || node.y === undefined || isPinned(node)) continue
      const dx = node.x - info.anchor.x
      const dy = node.y - info.anchor.y
      const d = Math.hypot(dx, dy)
      if (info.role === 'lead') {
        node.vx = 0
        node.vy = 0
        if (d < LEAD_SNAP) { node.x = info.anchor.x; node.y = info.anchor.y } else {
          node.x -= dx * CLUSTER_LAYOUT.holdStrength
          node.y -= dy * CLUSTER_LAYOUT.holdStrength
        }
        continue
      }
      let vx = node.vx ?? 0
      let vy = node.vy ?? 0
      if (info.role === 'archived' && d > 1e-6) {
        const pull = (d - info.radius * CLUSTER_LAYOUT.archivedRingFactor) * CLUSTER_LAYOUT.ringStrength * alpha
        vx -= (dx / d) * pull
        vy -= (dy / d) * pull
      } else if (info.pull) {
        // Eased directly (not through the velocity): the repulsion between agents would otherwise win over
        // a pull scaled by alpha and spread the phase over the whole disc. Collision still keeps the agents apart.
        node.x -= (node.x - info.pull.x) * CLUSTER_LAYOUT.phasePullStrength
        node.y -= (node.y - info.pull.y) * CLUSTER_LAYOUT.phasePullStrength
      } else {
        vx -= dx * CLUSTER_LAYOUT.pullStrength * alpha
        vy -= dy * CLUSTER_LAYOUT.pullStrength * alpha
      }
      node.vx = vx
      node.vy = vy
    }
  }
  force.initialize = (n: PosNode[]): void => { nodes = n }
  return force
}

/** A lead closer than this to its anchor is snapped onto it */
const LEAD_SNAP = 0.5
/** Share of the excess outside the disc removed per tick (exponential approach, no teleport) */
const CONTAIN_RATE = 0.35

/**
 * Post-integration constraint: every non-lead node ends up inside its cluster disc
 * (radius * containFactor). Returns true while something still had to move (lead away from its
 * anchor, or a member outside its disc), false once the layout is settled.
 */
export function constrainToClusters(
  nodes: Iterable<PosNode>,
  getInfo: (id: string) => ClusterNodeInfo | undefined,
): boolean {
  let moving = false
  for (const node of nodes) {
    const info = getInfo(node.id)
    if (!info || node.x === undefined || node.y === undefined || isPinned(node)) continue
    const dx = node.x - info.anchor.x
    const dy = node.y - info.anchor.y
    const d = Math.hypot(dx, dy)
    if (info.role === 'lead') {
      if (d >= LEAD_SNAP) moving = true
      continue
    }
    const limit = info.radius * CLUSTER_LAYOUT.containFactor
    const excess = d - limit
    if (excess <= 0 || d < 1e-9) continue
    moving = true
    const target = excess <= LEAD_SNAP ? limit : d - excess * CONTAIN_RATE
    node.x = info.anchor.x + (dx / d) * target
    node.y = info.anchor.y + (dy / d) * target
    // The force may not push it out again this tick
    if (node.vx !== undefined && node.vy !== undefined && node.vx * dx + node.vy * dy > 0) { node.vx = 0; node.vy = 0 }
  }
  return moving
}

// ─── Centring of a parent on its children (#151) ────────────────────────────

/**
 * Children each parent is centred on: the direct children that are drawn ('Hide inactive agents' taken into account,
 * archived agents are parked on the outer ring and never count), for the parents with at least
 * `minCentredChildren` of them. Sub-orchestrators are parents like any other. A parent whose children are grouped by
 * workflow phase (#146) is left out: the phase centres, on a ring around the anchor, already lay them out.
 * Insertion order, so the result is stable.
 */
export function centredChildren(agents: Map<string, Agent>, hideInactive: boolean): Map<string, string[]> {
  const shown = visibleAgents(agents, hideInactive)
  const byParent = new Map<string, string[]>()
  const phased = new Set<string>()
  for (const a of shown.values()) {
    if (!a.parentId || a.archived || !shown.has(a.parentId)) continue
    if (a.teamKind === 'workflow' && a.phase) phased.add(a.parentId)
    const list = byParent.get(a.parentId)
    if (list) list.push(a.id); else byParent.set(a.parentId, [a.id])
  }
  for (const [parent, list] of byParent) if (list.length < CLUSTER_LAYOUT.minCentredChildren || phased.has(parent)) byParent.delete(parent)
  return byParent
}

/** Middle of the extent (bounding box) of `points`, or undefined when there is none. */
export function extentCentre(points: Iterable<{ x: number; y: number }>): { x: number; y: number } | undefined {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return minX === Infinity ? undefined : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** `roots` and every descendant of theirs (`family`: all the direct children of every parent), each once. */
function subtreeOf(roots: readonly string[], family: ReadonlyMap<string, readonly string[]>): Set<string> {
  const out = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const kid of family.get(id) ?? []) stack.push(kid)
  }
  return out
}

/** All the direct children of every parent (any number, hidden or not): the family a shift of the parent drags along. */
export function familyOf(agents: ReadonlyMap<string, Agent>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of agents.values()) {
    if (!a.parentId) continue
    const list = out.get(a.parentId)
    if (list) list.push(a.id); else out.set(a.parentId, [a.id])
  }
  return out
}

/** A parent this close to the middle of its children (px) counts as centred: the layout may settle */
export const CENTRE_EPSILON = 0.5

/**
 * d3 force (#151): puts every parent in the middle of the extent of its children, whether they are 2, 3 or n, an
 * even or an odd number. The lead of a cluster is held on its anchor, so its children move around it; any other
 * parent (a sub-orchestrator) moves to the middle of its own children. Both are eased (`centreStrength` per tick,
 * not scaled by alpha), so a child that appears, finishes or is hidden never makes the parent jump. Pinned nodes
 * stay where the user put them. `residual()` is the largest gap left by the last pass (0 once centred).
 * Register it after the cluster force, which holds the leads.
 */
export function createCentringForce(
  getChildren: () => ReadonlyMap<string, readonly string[]>,
  getFamily: () => ReadonlyMap<string, readonly string[]>,
  getInfo: (id: string) => ClusterNodeInfo | undefined,
) {
  let byId = new Map<string, PosNode>()
  let residual = 0
  const force = (): void => {
    residual = 0
    for (const [parentId, childIds] of getChildren()) {
      const parent = byId.get(parentId)
      if (!parent || parent.x === undefined || parent.y === undefined) continue
      const children = childIds.map(id => byId.get(id)).filter((c): c is PosNode => c !== undefined && c.x !== undefined && c.y !== undefined)
      const centre = extentCentre(children as Array<{ x: number; y: number }>)
      if (!centre) continue
      const gx = centre.x - parent.x
      const gy = centre.y - parent.y
      const gap = Math.hypot(gx, gy)
      if (gap < CENTRE_EPSILON) continue
      const k = CLUSTER_LAYOUT.centreStrength
      if (getInfo(parentId)?.role === 'lead' || isPinned(parent)) {
        // The parent stays: its children move around it (the gap is closed by shifting them all the same way),
        // each with its own descendants so that a sub-orchestrator keeps its place in the middle of its children
        const moved = subtreeOf(children.map(c => c.id), getFamily())
        let shifted = false
        for (const id of moved) {
          const c = byId.get(id)
          if (!c || c.x === undefined || c.y === undefined || isPinned(c)) continue
          c.x -= gx * k
          c.y -= gy * k
          shifted = true
        }
        if (shifted) residual = Math.max(residual, gap)
      } else {
        parent.x += gx * k
        parent.y += gy * k
        residual = Math.max(residual, gap)
      }
    }
  }
  force.initialize = (n: PosNode[]): void => { byId = new Map(n.map(x => [x.id, x])) }
  force.residual = (): number => residual
  return force
}
