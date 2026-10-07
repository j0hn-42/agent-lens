/**
 * Fleet layout (#36): deterministic placement of agent clusters in the 'All' view.
 * A cluster is a team (when agents carry a team name or their session belongs to a team) or
 * otherwise a session. With one cluster the main agent sits at (0,0); with several, cluster
 * anchors lie on a ring (or a phyllotaxis spiral for many) whose size grows with the members.
 * Pure: no React, no d3, no DOM.
 */
import type { Agent, TeamSummary } from '../../lib/agent-types'
import { AGENT_SPAWN_DISTANCE, CLUSTER_LAYOUT } from '../../lib/canvas-constants'

export interface ClusterInput { key: string; size: number }
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

/** Cluster of an agent: its team name, else the team its session belongs to, else its session id (namespaced). */
export function clusterKeyOf(agent: Pick<Agent, 'sessionId' | 'teamName'>, teams?: ReadonlyMap<string, TeamSummary>): string {
  if (agent.teamName) return TEAM_CLUSTER_PREFIX + agent.teamName
  if (teams) {
    for (const t of teams.values()) {
      if (t.leadSessionId === agent.sessionId || t.members.some(m => m.sessionId === agent.sessionId)) return TEAM_CLUSTER_PREFIX + t.name
    }
  }
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
 * Anchor of every cluster, in the order given (first appearance). One cluster is centred on
 * (0,0). Discs (anchor, radius) never overlap. Pure and deterministic.
 */
export function computeClusterAnchors(clusters: ReadonlyArray<ClusterInput>): Map<string, ClusterAnchor> {
  const seen = new Set<string>()
  const items: Array<{ key: string; radius: number }> = []
  for (const c of clusters) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    items.push({ key: c.key, radius: clusterRadius(c.size) })
  }
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
): ClusterInput[] {
  const counts = new Map<string, number>()
  for (const a of agents) {
    const key = keyOf(a, teams)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts, ([key, size]) => ({ key, size }))
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

// ─── Force simulation helpers ───────────────────────────────────────────────

export interface ClusterNodeInfo {
  key: string
  anchor: { x: number; y: number }
  radius: number
  role: 'lead' | 'member' | 'archived'
}

/** Per-agent layout role and anchor, computed from the agents. */
export function layoutInfo(
  agents: ReadonlyMap<string, Agent>,
  teams?: ReadonlyMap<string, TeamSummary>,
): { info: Map<string, ClusterNodeInfo>; anchors: Map<string, ClusterAnchor> } {
  const anchors = computeClusterAnchors(clustersOf(agents.values(), teams))
  const leads = new Map<string, string>()
  for (const a of agents.values()) {
    const key = keyOf(a, teams)
    if (a.isMain && !leads.has(key)) leads.set(key, a.id)
  }
  const info = new Map<string, ClusterNodeInfo>()
  for (const a of agents.values()) {
    const key = keyOf(a, teams)
    const anchor = anchors.get(key)
    if (!anchor) continue
    const role = leads.get(key) === a.id ? 'lead' : a.archived ? 'archived' : 'member'
    info.set(a.id, { key, anchor: { x: anchor.x, y: anchor.y }, radius: anchor.radius, role })
  }
  return { info, anchors }
}

interface PosNode { id: string; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }

/**
 * d3 force: leads are held at their anchor, members get a weak pull to it and are kept inside
 * their cluster disc, archived agents drift to its outer ring, and cluster discs are pushed
 * apart when their centroids get closer than the sum of their radii.
 */
export function createClusterForce(getInfo: (id: string) => ClusterNodeInfo | undefined) {
  let nodes: PosNode[] = []
  const force = (alpha: number): void => {
    const sums = new Map<string, { x: number; y: number; n: number; r: number }>()
    for (const node of nodes) {
      const info = getInfo(node.id)
      if (!info || node.x === undefined || node.y === undefined) continue
      const dx = node.x - info.anchor.x
      const dy = node.y - info.anchor.y
      const d = Math.hypot(dx, dy)
      const s = sums.get(info.key) ?? { x: 0, y: 0, n: 0, r: info.radius }
      s.x += node.x; s.y += node.y; s.n++
      sums.set(info.key, s)
      if (node.fx != null || node.fy != null) continue
      let vx = node.vx ?? 0
      let vy = node.vy ?? 0
      if (info.role === 'lead') {
        if (d < 0.5) { node.x = info.anchor.x; node.y = info.anchor.y; vx = 0; vy = 0 } else {
          vx -= dx * CLUSTER_LAYOUT.holdStrength
          vy -= dy * CLUSTER_LAYOUT.holdStrength
        }
      } else {
        if (info.role === 'archived' && d > 1e-6) {
          const pull = (d - info.radius * CLUSTER_LAYOUT.archivedRingFactor) * CLUSTER_LAYOUT.ringStrength * alpha
          vx -= (dx / d) * pull
          vy -= (dy / d) * pull
        } else {
          vx -= dx * CLUSTER_LAYOUT.pullStrength * alpha
          vy -= dy * CLUSTER_LAYOUT.pullStrength * alpha
        }
        const limit = info.radius * CLUSTER_LAYOUT.containFactor
        if (d > limit && d > 1e-6) {
          const pull = (d - limit) * CLUSTER_LAYOUT.containStrength
          vx -= (dx / d) * pull
          vy -= (dy / d) * pull
        }
      }
      node.vx = vx
      node.vy = vy
    }
    // Cluster-vs-cluster separation on centroids
    const list = Array.from(sums, ([key, s]) => ({ key, cx: s.x / s.n, cy: s.y / s.n, r: s.r }))
    if (list.length < 2) return
    const push = new Map<string, { x: number; y: number }>()
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        let dx = b.cx - a.cx, dy = b.cy - a.cy
        let d = Math.hypot(dx, dy)
        const min = a.r + b.r
        if (d >= min) continue
        if (d < 1e-6) { dx = 1; dy = 0; d = 1 }
        const f = (min - d) * CLUSTER_LAYOUT.separationStrength * alpha / 2
        const pa = push.get(a.key) ?? { x: 0, y: 0 }
        const pb = push.get(b.key) ?? { x: 0, y: 0 }
        pa.x -= (dx / d) * f; pa.y -= (dy / d) * f
        pb.x += (dx / d) * f; pb.y += (dy / d) * f
        push.set(a.key, pa); push.set(b.key, pb)
      }
    }
    if (push.size === 0) return
    for (const node of nodes) {
      const info = getInfo(node.id)
      const p = info && push.get(info.key)
      if (p && info.role !== 'lead' && node.fx == null && node.fy == null) {
        node.vx = (node.vx ?? 0) + p.x
        node.vy = (node.vy ?? 0) + p.y
      }
    }
  }
  force.initialize = (n: PosNode[]): void => { nodes = n }
  return force
}
