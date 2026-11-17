/**
 * Burrow view: the squirrel's close-up at the glass of your screen, for the agent with the squirrel that waits for you
 * longest. Pure: no DOM, no engine clock. Ported from Agents' Burrow.
 * Where it may stand (glassPlace): on the bottom edge of the picture, or on the top edge of what covers the bottom (the
 * timeline, the control bar), in a gap of that edge between two room titles, never behind a panel, the burrow's own
 * controls or any other cover, never over a title mat or a post. It is canvas, under every HTML element: standing only
 * where nothing covers it, it hides no panel or control and no panel hides it.
 */
import type { BurrowMat } from './burrow-engine'

/** The picture's size in scene px (burrow-data's map) */
const W = 560
const H = 315
/** The close-up's cell is 112 px wide: half of it either side of its centre */
const HALF = 56
/** Height of the band it takes over its base (the tallest close-up, 74 px, and a little room) */
const BAND_H = 80
/** A gap narrower than this would cut the close-up's opaque part (all its poses together span 98 px of the cell) */
const MIN_GAP = 104
/** The opaque columns of all the close-up's poses together, from its centre: [-45, 53] (squirrel.glass x0..x1): its middle is 4 px right of the centre */
const OPAQUE_MID = 4
/** More of the bottom covered than this: it would rise into the lounge, there is no close-up */
const MAX_COVERED = 40
/** Margin kept around a title mat, and around a post's feet */
const MAT_MARGIN = 4
const POST_MARGIN = 12

/**
 * Where the close-up stands, in scene px: its centre on the bottom edge (cx), that edge (base), and the ends of the free
 * gap it stands in (left, right), which what it leaves on the glass keeps to
 */
export interface GlassPlace { cx: number; base: number; left: number; right: number }

/**
 * The place of the close-up for an agent at `agentX`, or null when no gap of the bottom edge is free. `coveredBottom`,
 * `coveredLeft`, `coveredRight`: scene px of the picture the panels, the top bar and the timeline cover at each edge
 * (the graph's overlay insets); `covers`: other rectangles over the picture (the burrow's controls column, the
 * collapsed Conversation pill), in scene px; `mats`: the woven room titles; `posts`: the feet of every post (front
 * door, telephone, place of errors). Among the free gaps of its band at least MIN_GAP wide, the one nearest the agent,
 * the opaque part of the close-up centred on it.
 */
export function glassPlace(o: {
  agentX: number
  mats: readonly BurrowMat[]
  posts: ReadonlyArray<{ x: number; y: number }>
  covers: ReadonlyArray<{ x0: number; x1: number; y0: number; y1: number }>
  coveredBottom: number
  coveredLeft: number
  coveredRight: number
}): GlassPlace | null {
  const covered = Math.max(0, o.coveredBottom || 0)
  if (covered > MAX_COVERED) return null
  const base = Math.round(H - covered)
  const top = base - BAND_H
  const blocked: Array<[number, number]> = []
  for (const c of o.covers) if (c.y0 < base && c.y1 > top) blocked.push([c.x0, c.x1])
  for (const m of o.mats) if (m.y - MAT_MARGIN < base && m.y + m.h + MAT_MARGIN > top) blocked.push([m.x - MAT_MARGIN, m.x + m.w + MAT_MARGIN])
  for (const p of o.posts) if (p.y >= top && p.y <= base) blocked.push([p.x - POST_MARGIN, p.x + POST_MARGIN])
  blocked.sort((a, b) => a[0] - b[0])
  // the free gaps of the edge, left to right
  const gaps: Array<[number, number]> = []
  let x = Math.max(0, o.coveredLeft || 0)
  const end = W - Math.max(0, o.coveredRight || 0)
  for (const [b0, b1] of blocked) {
    if (b0 > x) gaps.push([x, Math.min(b0, end)])
    x = Math.max(x, b1)
    if (x >= end) break
  }
  if (x < end) gaps.push([x, end])
  let best: [number, number] | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const g of gaps) {
    if (g[1] - g[0] < MIN_GAP) continue
    const d = o.agentX < g[0] ? g[0] - o.agentX : o.agentX > g[1] ? o.agentX - g[1] : 0
    if (d < bestD) { best = g; bestD = d }
  }
  return best ? { cx: Math.round((best[0] + best[1]) / 2 - OPAQUE_MID), base, left: best[0], right: best[1] } : null
}

/** The floor the close-up stands over, [x0, y0, x1, y1) in scene px: kept free while it may show (engine.setGlassBand) */
export function glassBand(place: GlassPlace): readonly [number, number, number, number] {
  return [place.cx - HALF, place.base - BAND_H, place.cx + HALF, place.base]
}
