/**
 * Pure screen-space collision avoidance for the texts drawn on the canvas (labels, stats boxes,
 * cost pills, bubbles, cluster labels). Greedy placement: requests are served by decreasing priority
 * (the selected / hovered agent first); each tries its preferred position, then fallback offsets;
 * a request that still collides is hidden, collapsed to a small count chip, or (essential ones)
 * kept at its least-overlapping position. No React and no canvas: unit-testable under node:test.
 */
import { PLACEMENT } from '../../../lib/canvas-constants'

/** Axis-aligned rectangle (screen px unless said otherwise). */
export interface Rect { x: number; y: number; w: number; h: number }

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export interface PlacementRequest {
  id: string
  /** Higher wins a contested spot */
  priority: number
  /** Preferred rectangle (screen px) */
  rect: Rect
  /** Owner (an agent id): obstacles of the same owner are ignored (a label never collides with its own node) */
  owner?: string
  /** Extra offsets (screen px) tried after {0,0}. Defaults to DEFAULT_OFFSETS scaled by the rect size. */
  offsets?: Array<{ dx: number; dy: number }>
  /** Never hidden: kept at the least-overlapping candidate */
  essential?: boolean
  /** Smaller form (a count chip, a one-line label) tried, at the preferred position and the fallback offsets, when the full form does not fit */
  compact?: Rect
  /** Node obstacles do not block it (the selected / hovered agent's bubbles may cover a neighbour node, but never another text) */
  ignoreObstacles?: boolean
  /** Fallback offsets (never the preferred position) must keep the rectangle inside this area, e.g. the safe area clear of the control bar */
  shiftBounds?: Rect
  /** Only shown when there is room at the preferred position (no fallback offsets tried) */
  fixed?: boolean
}

export interface Obstacle { rect: Rect; owner?: string }

export interface Placement {
  id: string
  /** Offset to add to the preferred rect (screen px) */
  dx: number
  dy: number
  /** Final rectangle (screen px); the compact rect when collapsed; null when hidden */
  rect: Rect | null
  hidden: boolean
  collapsed: boolean
}

export interface PlaceOptions {
  /** Screen bounds: candidates falling outside are rejected (0-size = unbounded) */
  bounds?: Rect
  obstacles?: Obstacle[]
  gap?: number
}

/** Fallback offsets relative to a rect of size w x h: below, above, then sideways and diagonals. */
export function defaultOffsets(w: number, h: number): Array<{ dx: number; dy: number }> {
  return [
    { dx: 0, dy: h }, { dx: 0, dy: -h },
    { dx: w * 0.6, dy: 0 }, { dx: -w * 0.6, dy: 0 },
    { dx: w * 0.6, dy: h }, { dx: -w * 0.6, dy: h },
    { dx: w * 0.6, dy: -h }, { dx: -w * 0.6, dy: -h },
    { dx: 0, dy: h * 2 }, { dx: 0, dy: -h * 2 },
  ]
}

function inside(r: Rect, b: Rect | undefined): boolean {
  if (!b || b.w <= 0 || b.h <= 0) return true
  return r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h
}

/**
 * Place every request. Deterministic: ties on priority keep the request order. Returns one Placement
 * per request, in the REQUEST order (not the priority order).
 */
export function placeRects(requests: PlacementRequest[], options: PlaceOptions = {}): Placement[] {
  const gap = options.gap ?? PLACEMENT.gap
  const obstacles = options.obstacles ?? []
  const placed: Array<{ rect: Rect; owner?: string }> = []
  const result = new Map<string, Placement>()

  const order = requests
    .map((req, index) => ({ req, index }))
    .sort((a, b) => (b.req.priority - a.req.priority) || (a.index - b.index))

  const collides = (rect: Rect, owner: string | undefined, ignoreObstacles = false): boolean => {
    for (const o of ignoreObstacles ? [] : obstacles) {
      if (owner !== undefined && o.owner === owner) continue
      if (rectsOverlap(rect, o.rect, 0)) return true
    }
    for (const p of placed) if (rectsOverlap(rect, p.rect, gap)) return true
    return false
  }
  const overlapScore = (rect: Rect, owner: string | undefined, ignoreObstacles = false): number => {
    let score = 0
    for (const o of ignoreObstacles ? [] : obstacles) {
      if (owner !== undefined && o.owner === owner) continue
      score += overlapArea(rect, o.rect)
    }
    for (const p of placed) score += overlapArea(rect, p.rect)
    return score
  }

  for (const { req } of order) {
    const base = req.rect
    const candidates = req.fixed ? [{ dx: 0, dy: 0 }] : [{ dx: 0, dy: 0 }, ...(req.offsets ?? defaultOffsets(base.w, base.h))]
    let chosen: { dx: number; dy: number } | null = null
    for (const c of candidates) {
      const r = { x: base.x + c.dx, y: base.y + c.dy, w: base.w, h: base.h }
      if (!inside(r, options.bounds)) continue
      if ((c.dx !== 0 || c.dy !== 0) && !inside(r, req.shiftBounds)) continue
      if (!collides(r, req.owner, req.ignoreObstacles)) { chosen = c; break }
    }

    if (chosen) {
      const rect = { x: base.x + chosen.dx, y: base.y + chosen.dy, w: base.w, h: base.h }
      placed.push({ rect, owner: req.owner })
      result.set(req.id, { id: req.id, dx: chosen.dx, dy: chosen.dy, rect, hidden: false, collapsed: false })
      continue
    }

    if (req.compact) {
      const small = req.compact
      const smallCandidates = req.fixed ? [{ dx: 0, dy: 0 }] : [{ dx: 0, dy: 0 }, ...(req.offsets ?? defaultOffsets(small.w, small.h))]
      let found: { dx: number; dy: number } | null = null
      for (const c of smallCandidates) {
        const r = { x: small.x + c.dx, y: small.y + c.dy, w: small.w, h: small.h }
        if (inside(r, options.bounds) && ((c.dx === 0 && c.dy === 0) || inside(r, req.shiftBounds)) && !collides(r, req.owner, req.ignoreObstacles)) { found = c; break }
      }
      if (found) {
        const rect = { x: small.x + found.dx, y: small.y + found.dy, w: small.w, h: small.h }
        placed.push({ rect, owner: req.owner })
        result.set(req.id, { id: req.id, dx: found.dx, dy: found.dy, rect, hidden: false, collapsed: true })
        continue
      }
    }

    if (req.essential) {
      let best = candidates[0]
      let bestScore = Infinity
      for (const c of candidates) {
        const r = { x: base.x + c.dx, y: base.y + c.dy, w: base.w, h: base.h }
        const score = overlapScore(r, req.owner, req.ignoreObstacles) + (inside(r, options.bounds) ? 0 : 1e6)
        if (score < bestScore) { best = c; bestScore = score }
      }
      const rect = { x: base.x + best.dx, y: base.y + best.dy, w: base.w, h: base.h }
      placed.push({ rect, owner: req.owner })
      result.set(req.id, { id: req.id, dx: best.dx, dy: best.dy, rect, hidden: false, collapsed: false })
      continue
    }

    result.set(req.id, { id: req.id, dx: 0, dy: 0, rect: null, hidden: true, collapsed: false })
  }

  return requests.map(r => result.get(r.id)!)
}

/** Priority of an overlay: the selected / hovered agent first, then the orchestrator, then active agents. */
export function overlayPriority(
  kindBase: number,
  flags: { selected?: boolean; hovered?: boolean; focused?: boolean; orchestrator?: boolean; active?: boolean },
): number {
  let p = kindBase
  if (flags.selected || flags.hovered || flags.focused) p += 1000
  if (flags.orchestrator) p += 100
  if (flags.active) p += 10
  return p
}

/** Kind bases: labels beat stats and cost pills, which beat link bubbles, which beat agent bubbles. */
export const PRIORITY = {
  clusterLabel: 900,
  agentLabel: 50,
  stats: 40,
  cost: 40,
  edgeBubble: 30,
  agentBubbles: 20,
} as const

/** Lookup of placements by id, with the "no plan" default of drawing everything in place. */
export type OverlayPlan = ReadonlyMap<string, Placement>

export function planFor(plan: OverlayPlan | undefined, id: string): Placement | undefined {
  return plan?.get(id)
}
