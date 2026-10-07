/**
 * Pure geometry and state logic for communication links (AgentLink) drawn as edges:
 * resolving link ends to agent keys, the Bezier curve shared with the other edges,
 * the point-to-curve distance used by hit-testing, and the in-flight / recent / error state.
 * No React and no canvas here: unit-testable under node:test (relative runtime imports only).
 */
import { BEAM } from '../../../lib/agent-types'
import type { Agent } from '../../../lib/agent-types'
import type { AgentLink, ConversationMessage } from '../../../hooks/simulation/types'
import { HIT_DETECTION } from '../../../lib/canvas-constants'
import { isAgentVisible } from './team-style'

// ─── Bezier (shared with draw-edges / draw-particles) ────────────────────────

export function bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number) {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

/** Compute bezier control points for an edge between two positions */
export function computeControlPoints(fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX, dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return null
  const curvature = dist * BEAM.curvature
  const perpX = -dy / dist * curvature, perpY = dx / dist * curvature
  return {
    cp1x: fromX + dx * BEAM.cp1 + perpX, cp1y: fromY + dy * BEAM.cp1 + perpY,
    cp2x: fromX + dx * BEAM.cp2 + perpX, cp2y: fromY + dy * BEAM.cp2 + perpY,
    dist, dx, dy,
  }
}

export interface Curve {
  x0: number; y0: number
  cp1x: number; cp1y: number
  cp2x: number; cp2y: number
  x3: number; y3: number
}

/** Curve between two points, or null when they coincide. */
export function curveBetween(from: { x: number; y: number }, to: { x: number; y: number }): Curve | null {
  const cp = computeControlPoints(from.x, from.y, to.x, to.y)
  if (!cp) return null
  return { x0: from.x, y0: from.y, cp1x: cp.cp1x, cp1y: cp.cp1y, cp2x: cp.cp2x, cp2y: cp.cp2y, x3: to.x, y3: to.y }
}

export function curvePoint(c: Curve, t: number): { x: number; y: number } {
  return { x: bezierPoint(t, c.x0, c.cp1x, c.cp2x, c.x3), y: bezierPoint(t, c.y0, c.cp1y, c.cp2y, c.y3) }
}

/** Unit tangent of the curve at t (direction of travel from -> to). */
export function curveTangent(c: Curve, t: number): { x: number; y: number } {
  const a = curvePoint(c, Math.max(0, t - 0.01))
  const b = curvePoint(c, Math.min(1, t + 0.01))
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/** Shortest distance from (px, py) to the segment (ax, ay)-(bx, by). */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Distance (world units) from a point to the curve, using a polyline approximation. */
export function distanceToCurve(px: number, py: number, c: Curve, samples = 24): number {
  let best = Infinity
  let prev = curvePoint(c, 0)
  for (let i = 1; i <= samples; i++) {
    const p = curvePoint(c, i / samples)
    best = Math.min(best, distanceToSegment(px, py, prev.x, prev.y, p.x, p.y))
    prev = p
  }
  return best
}

// ─── Resolving links to agents ───────────────────────────────────────────────

/**
 * Resolve one end of a link to an agent key. `ref` may already be an agentKey, a local name
 * inside the link's session ("Explorer"), or a display name. Returns null when nothing matches.
 */
export function resolveAgentRef(ref: string, sessionId: string, agents: Map<string, Agent>): string | null {
  if (!ref) return null
  if (agents.has(ref)) return ref
  const scoped = `${sessionId}:${ref}`
  if (agents.has(scoped)) return scoped
  for (const [key, a] of agents) {
    if (a.sessionId === sessionId && (a.localId === ref || a.displayName === ref || a.name === ref)) return key
  }
  return null
}

export type LinkState = 'in_flight' | 'recent' | 'error' | 'idle'

/** A message newer than this (sim seconds) counts as in flight */
export const LINK_IN_FLIGHT_S = 2
/** A message newer than this (sim seconds) keeps the link highlighted */
export const LINK_RECENT_S = 10

/** State of a link at `simTime`: error, in flight (open dispatch or a fresh message), recent, idle. */
export function linkState(link: Pick<AgentLink, 'kind' | 'messages'>, simTime: number): LinkState {
  const msgs = link.messages
  const last = msgs[msgs.length - 1]
  if (!last) return 'idle'
  if (last.isError) return 'error'
  if (link.kind === 'spawn') {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'return') break
      if (msgs[i].type === 'dispatch') return 'in_flight'
    }
  }
  const age = simTime - last.timestamp
  if (age >= 0 && age <= LINK_IN_FLIGHT_S) return 'in_flight'
  if (age >= 0 && age <= LINK_RECENT_S) return 'recent'
  return 'idle'
}

/** Human text of a link state (DOM list, legend, panel) */
export const LINK_STATE_LABEL_TEXT: Readonly<Record<LinkState, string>> = {
  in_flight: 'in flight',
  recent: 'recent',
  error: 'error',
  idle: 'idle',
}

export interface ResolvedLink {
  id: string
  link: AgentLink
  fromKey: string
  toKey: string
  /** Messages carried (including the dropped ones) */
  count: number
  state: LinkState
  /** The last message travelled from `link.to` to `link.from` (a return / reply) */
  lastBackward: boolean
}

/** Links whose both ends exist as agents. Order follows the links map. */
export function resolveLinks(links: Map<string, AgentLink> | undefined, agents: Map<string, Agent>, simTime: number): ResolvedLink[] {
  const out: ResolvedLink[] = []
  if (!links) return out
  for (const [id, link] of links) {
    const fromKey = resolveAgentRef(link.from, link.sessionId, agents)
    const toKey = resolveAgentRef(link.to, link.sessionId, agents)
    if (!fromKey || !toKey || fromKey === toKey) continue
    const last: ConversationMessage | undefined = link.messages[link.messages.length - 1]
    const lastFrom = last?.from ? resolveAgentRef(last.from, link.sessionId, agents) : null
    out.push({
      id,
      link,
      fromKey,
      toKey,
      count: link.messages.length + (link.dropped || 0),
      state: linkState(link, simTime),
      lastBackward: !!lastFrom && lastFrom === toKey,
    })
  }
  return out
}

/** Curve of a resolved link, or null when an end is missing, hidden, or both coincide. */
export function linkCurve(r: ResolvedLink, agents: Map<string, Agent>): Curve | null {
  const from = agents.get(r.fromKey)
  const to = agents.get(r.toKey)
  if (!from || !to || !isAgentVisible(from) || !isAgentVisible(to)) return null
  return curveBetween(from, to)
}

/** Half-size (screen px) of the count badge hit area at the middle of the curve */
const BADGE_HIT_HALF_PX = 14

/**
 * Link under (x, y), canvas-world coordinates. The tolerance is in SCREEN pixels (default 8),
 * so a link stays clickable when zoomed out. The count badge at the middle also counts, but only while
 * it is drawn (`badgeVisible`, the level of detail that shows labels) and by its distance to the badge
 * centre: it never beats a nearer link whose curve passes inside the badge box.
 * Of several candidates the nearest wins; ties go to the one drawn last (on top).
 */
export function findLinkAt(
  x: number,
  y: number,
  links: ResolvedLink[],
  agents: Map<string, Agent>,
  scale = 1,
  tolerancePx = HIT_DETECTION.linkTolerancePx,
  badgeVisible = true,
): string | null {
  const safeScale = scale > 0 ? scale : 1
  const tol = tolerancePx / safeScale
  let bestId: string | null = null
  let best = Infinity
  for (const r of links) {
    const curve = linkCurve(r, agents)
    if (!curve) continue
    let d = distanceToCurve(x, y, curve)
    const mid = curvePoint(curve, 0.5)
    const badge = BADGE_HIT_HALF_PX / safeScale
    if (badgeVisible && Math.abs(x - mid.x) <= badge && Math.abs(y - mid.y) <= badge) {
      // Inside the drawn badge: as good as on the curve, ranked by the distance to the badge centre
      d = Math.min(d, Math.hypot(x - mid.x, y - mid.y) * 0.25)
    }
    if (d <= tol && d <= best) { best = d; bestId = r.id }
  }
  return bestId
}
