/**
 * Pure camera-fit maths: world bounds from node discs, cluster halos (with their label boxes), tool
 * cards and discoveries; safe-area insets derived from the UI overlaid on the canvas; and a
 * fitToView() that clamps the zoom and centres the bounds EXACTLY in the safe area.
 * No React and no canvas: unit-testable under node:test (relative runtime imports only).
 */
import type { Agent, ToolCallNode, Discovery } from '../../../lib/agent-types'
import {
  CAMERA, BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_MAX_W, TOOL_CARD_W, TOOL_CARD_H,
  DISC_BOUNDS_HALF_W, DISC_BOUNDS_HALF_H, CLUSTER_DRAW, CONTEXT_BAR, AGENT_DRAW,
} from '../../../lib/canvas-constants'
import { agentDrawRadius, isAgentVisible } from './team-style'

export interface Transform { x: number; y: number; scale: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Viewport { width: number; height: number }
export interface WorldBounds { minX: number; maxX: number; minY: number; maxY: number }

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
/**
 * Smallest zoom of the camera: both fitToView() and the interactive zoom (wheel, buttons, keys) stop here,
 * so a fit is always reachable by hand too. Low enough for dozens of cluster halos; cluster labels stay
 * legible because they are drawn in screen space and per-agent text is hidden by the LOD at such scales.
 */
export const FIT_MIN_SCALE = CAMERA.minZoom
/** Largest zoom a fit may choose (a single node is not blown up beyond this) */
export const MAX_FIT_SCALE = 2
/** Minimum screen padding between the content and the edge of the safe area */
export const FIT_MIN_PADDING = 24
/** Gap kept between the fitted content and the overlaid UI */
const UI_GAP = 8

// ─── Bounds ─────────────────────────────────────────────────────────────────

export function emptyBounds(): WorldBounds {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
}

export function isEmptyBounds(b: WorldBounds): boolean {
  return !(Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY)) || b.maxX < b.minX || b.maxY < b.minY
}

export function extendRect(b: WorldBounds, x: number, y: number, w: number, h: number): void {
  if (![x, y, w, h].every(Number.isFinite)) return
  b.minX = Math.min(b.minX, x)
  b.maxX = Math.max(b.maxX, x + w)
  b.minY = Math.min(b.minY, y)
  b.maxY = Math.max(b.maxY, y + h)
}

export function extendCircle(b: WorldBounds, cx: number, cy: number, r: number): void {
  if (!(r >= 0)) return
  extendRect(b, cx - r, cy - r, r * 2, r * 2)
}

export interface FitBoundsInput {
  agents: Iterable<Agent>
  toolCalls?: Iterable<ToolCallNode>
  discoveries?: Iterable<Discovery>
  /** Cluster halos (world circles) */
  clusters?: ReadonlyArray<{ cx: number; cy: number; r: number }>
  /** Only these agents (and their tools / discoveries) count; halos are skipped */
  focusScope?: ReadonlySet<string> | null
  simTime: number
  includeToolCards?: boolean
}

/** Extra world px around a node disc (rings, glow) */
const AGENT_PADDING = 22

/**
 * World bounds of everything the camera should frame. Only visible agents count (a faded or hidden agent
 * left at an old position must not drag the framing away), and each node carries its label / context
 * bar block underneath and its stats overlay above.
 */
export function computeFitBounds(input: FitBoundsInput): WorldBounds {
  const b = emptyBounds()
  const scope = input.focusScope ?? null
  for (const agent of input.agents) {
    if (scope && !scope.has(agent.id)) continue
    if (!isAgentVisible(agent)) continue
    const r = agentDrawRadius(agent) + AGENT_PADDING
    extendCircle(b, agent.x, agent.y, r)
    // Label block and context bar under the node, stats / cost overlay above it
    const halfW = Math.max(40, agentDrawRadius(agent) * AGENT_DRAW.labelWidthMultiplier * 0.5)
    const below = agentDrawRadius(agent) + CONTEXT_BAR.yOffset + 3 * AGENT_DRAW.stateLabelGap + CONTEXT_BAR.barHeight + CONTEXT_BAR.labelBoxExtra
    extendRect(b, agent.x - halfW, agent.y, halfW * 2, below)
    extendRect(b, agent.x - 40, agent.y - agentDrawRadius(agent) - 60, 80, 60)
    const bubbles = agent.messageBubbles ?? []
    if (bubbles.length > 0) {
      let visible = 0
      for (const m of bubbles) if (input.simTime - m.time <= BUBBLE_HOLD + BUBBLE_FADE_OUT) visible++
      if (visible > 0) {
        extendRect(b, agent.x - r - BUBBLE_MAX_W * 0.2, agent.y - 20, r * 2 + 14 + BUBBLE_MAX_W * 0.6, visible * 46)
      }
    }
  }
  if (input.includeToolCards !== false) {
    for (const tool of input.toolCalls ?? []) {
      if (!(tool.opacity > 0.1)) continue
      if (scope && !scope.has(tool.agentId)) continue
      extendRect(b, tool.x - TOOL_CARD_W / 2, tool.y - TOOL_CARD_H / 2, TOOL_CARD_W, TOOL_CARD_H)
    }
    for (const disc of input.discoveries ?? []) {
      if (!(disc.opacity > 0.1)) continue
      if (scope && !scope.has(disc.agentId)) continue
      extendRect(b, disc.x - DISC_BOUNDS_HALF_W, disc.y - DISC_BOUNDS_HALF_H, DISC_BOUNDS_HALF_W * 2, DISC_BOUNDS_HALF_H * 2)
    }
  }
  if (!scope) for (const c of input.clusters ?? []) extendCircle(b, c.cx, c.cy, c.r)
  return b
}

// ─── Insets / safe area ─────────────────────────────────────────────────────

function nonNeg(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

export function sanitizeInsets(i: Partial<Insets> | undefined | null): Insets {
  return { top: nonNeg(i?.top), right: nonNeg(i?.right), bottom: nonNeg(i?.bottom), left: nonNeg(i?.left) }
}

/** Smallest safe-area edge kept whatever the insets are (tiny windows with open panels) */
function minSafeSize(viewportSize: number): number {
  return Math.max(1, Math.min(viewportSize * 0.4, 160))
}

/**
 * Safe rectangle of the viewport once the insets are removed. When the insets would leave less than a
 * usable area they are shrunk proportionally, so the rectangle is never empty and stays inside the viewport.
 */
export function safeRect(viewport: Viewport, insetsIn: Partial<Insets> | undefined | null): Rect {
  const vw = Math.max(0, nonNeg(viewport.width))
  const vh = Math.max(0, nonNeg(viewport.height))
  const ins = sanitizeInsets(insetsIn)
  const fit = (a: number, b: number, size: number): [number, number] => {
    const room = Math.max(0, size - minSafeSize(size))
    const sum = a + b
    if (sum <= room) return [a, b]
    const k = sum > 0 ? room / sum : 0
    return [a * k, b * k]
  }
  const [left, right] = fit(ins.left, ins.right, vw)
  const [top, bottom] = fit(ins.top, ins.bottom, vh)
  return { x: left, y: top, w: Math.max(0, vw - left - right), h: Math.max(0, vh - top - bottom) }
}

export interface FitOptions {
  minScale?: number
  maxScale?: number
  /** Screen padding inside the safe area (default FIT_MIN_PADDING) */
  padding?: number
}

/**
 * Transform that frames `bounds` in the safe area of the viewport: the largest scale that fits, clamped
 * to [minScale, maxScale], with the bounds centred exactly on the centre of the safe rectangle.
 * Returns null for empty / non-finite bounds or a zero-size viewport. Zero-size bounds (one point) give
 * the maximum scale centred on that point.
 */
export function fitToView(
  bounds: WorldBounds | null | undefined, viewport: Viewport, insets?: Partial<Insets> | null, options: FitOptions = {},
): Transform | null {
  if (!bounds || isEmptyBounds(bounds)) return null
  if (!(viewport.width > 0) || !(viewport.height > 0) || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null
  const minScale = options.minScale ?? FIT_MIN_SCALE
  const maxScale = Math.max(minScale, options.maxScale ?? MAX_FIT_SCALE)
  const safe = safeRect(viewport, insets)
  const pad = Math.min(nonNeg(options.padding ?? FIT_MIN_PADDING), Math.min(safe.w, safe.h) / 4)
  const availW = Math.max(1, safe.w - pad * 2)
  const availH = Math.max(1, safe.h - pad * 2)
  const bw = bounds.maxX - bounds.minX
  const bh = bounds.maxY - bounds.minY
  const raw = Math.min(bw > 0 ? availW / bw : Infinity, bh > 0 ? availH / bh : Infinity)
  const scale = Math.max(minScale, Math.min(maxScale, raw))
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return {
    x: safe.x + safe.w / 2 - cx * scale,
    y: safe.y + safe.h / 2 - cy * scale,
    scale,
  }
}

/** Bounds of a world circle (e.g. one cluster halo). */
export function circleBounds(cx: number, cy: number, r: number): WorldBounds {
  const b = emptyBounds()
  extendCircle(b, cx, cy, r)
  return b
}

/**
 * Insets to hand to fitToView: the measured overlay insets, the top bar, a gap, and (when halo labels
 * are drawn above their circles) the height of a label chip so it stays under the tab strip.
 */
export function fitInsets(measured: Partial<Insets> | undefined | null, hasClusterLabels: boolean): Insets {
  const m = sanitizeInsets(measured)
  return {
    top: m.top + UI_GAP + (hasClusterLabels ? CLUSTER_DRAW.labelHeight + 4 : 0),
    right: m.right + (m.right > 0 ? UI_GAP : 0),
    bottom: m.bottom + (m.bottom > 0 ? UI_GAP : 0),
    left: m.left + (m.left > 0 ? UI_GAP : 0),
  }
}

/** An overlay rectangle; `edge` is an explicit role (data-canvas-inset="top|right|bottom|left"). */
export interface OverlayRect extends Rect {
  /** Forces the edge the overlay reserves, whatever its size */
  edge?: 'top' | 'right' | 'bottom' | 'left'
  /**
   * Bars (control bar, top bar, toolbars) are counted by role, not by width ratio: any rectangle that
   * hugs the top / bottom edge reserves it, however narrow it is next to a very wide canvas.
   */
  bar?: boolean
}

/**
 * Classify the rectangles of the UI overlaid on the canvas (all in the same client coordinates as
 * `canvas`) into insets. Rectangles with an explicit `edge` always reserve that edge; `bar` rectangles
 * reserve the top / bottom edge they hug (no width ratio); other rectangles are classified by shape: a
 * wide strip hugging the top / bottom edge, a tall panel hugging the left / right edge. Small floating
 * cards are ignored.
 */
export function classifyOverlayInsets(overlays: ReadonlyArray<OverlayRect>, canvas: Rect, edgeTolerance = 48): Insets {
  const out: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  if (!(canvas.w > 0) || !(canvas.h > 0)) return out
  for (const o of overlays) {
    if (![o.x, o.y, o.w, o.h].every(Number.isFinite) || o.w <= 0 || o.h <= 0) continue
    const left = Math.max(o.x, canvas.x) - canvas.x
    const top = Math.max(o.y, canvas.y) - canvas.y
    const right = Math.min(o.x + o.w, canvas.x + canvas.w) - canvas.x
    const bottom = Math.min(o.y + o.h, canvas.y + canvas.h) - canvas.y
    const w = right - left
    const h = bottom - top
    if (w <= 0 || h <= 0) continue
    if (o.edge === 'top') { out.top = Math.max(out.top, bottom); continue }
    if (o.edge === 'bottom') { out.bottom = Math.max(out.bottom, canvas.h - top); continue }
    if (o.edge === 'left') { out.left = Math.max(out.left, right); continue }
    if (o.edge === 'right') { out.right = Math.max(out.right, canvas.w - left); continue }
    const wide = o.bar ? h < canvas.h * 0.5 : w >= canvas.w * 0.25
    const tall = h >= canvas.h * 0.3
    if (wide && top <= edgeTolerance) out.top = Math.max(out.top, bottom)
    else if (wide && bottom >= canvas.h - edgeTolerance) out.bottom = Math.max(out.bottom, canvas.h - top)
    else if (tall && w < canvas.w * 0.6 && left <= edgeTolerance) out.left = Math.max(out.left, right)
    else if (tall && w < canvas.w * 0.6 && right >= canvas.w - edgeTolerance) out.right = Math.max(out.right, canvas.w - left)
  }
  return out
}

/** Merge insets: the largest value per edge. */
export function maxInsets(a: Partial<Insets> | undefined, b: Partial<Insets> | undefined): Insets {
  const x = sanitizeInsets(a)
  const y = sanitizeInsets(b)
  return { top: Math.max(x.top, y.top), right: Math.max(x.right, y.right), bottom: Math.max(x.bottom, y.bottom), left: Math.max(x.left, y.left) }
}

/** Parse a CSS length in px ('68px', '68', 68); 0 for anything else. */
export function parsePx(value: unknown): number {
  if (typeof value === 'number') return nonNeg(value)
  if (typeof value !== 'string') return 0
  const n = Number.parseFloat(value)
  return nonNeg(n)
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** Move a screen rectangle inside the safe rectangle (never larger than it: pinned to its top-left then). */
export function clampRectToSafe(r: Rect, safe: Rect): Rect {
  const x = Math.min(Math.max(r.x, safe.x), Math.max(safe.x, safe.x + safe.w - r.w))
  const y = Math.min(Math.max(r.y, safe.y), Math.max(safe.y, safe.y + safe.h - r.h))
  return { x, y, w: r.w, h: r.h }
}

// ─── Auto-fit rules ─────────────────────────────────────────────────────────

/** Stable signature of what is on screen: the clusters and the sessions of the visible agents. */
export function clusterSetSignature(clusterKeys: Iterable<string>, sessionIds: Iterable<string | undefined>): string {
  const keys = Array.from(new Set(clusterKeys)).sort()
  const sessions = Array.from(new Set(Array.from(sessionIds, s => s ?? ''))).sort()
  return `${keys.join(',')}#${sessions.join(',')}`
}

function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Allocation-free fingerprint of the content SET (order-insensitive): the cluster keys and the session
 * ids of the agents. Cheap enough to run every frame; the full signature / session list is only built
 * when this number changes. Positions are deliberately not part of it.
 */
export function contentStamp(
  clusters: Iterable<{ key: string }>, agents: Iterable<{ sessionId?: string }>,
): number {
  let sum = 0, xor = 0, n = 0
  for (const c of clusters) { const h = hashString(2166136261, c.key); sum = (sum + h) >>> 0; xor ^= h; n++ }
  sum = (sum + 0x9e3779b9) >>> 0
  for (const a of agents) { const h = hashString(0x811c9dc5, a.sessionId ?? ''); sum = (sum + h) >>> 0; xor ^= Math.imul(h, 31); n++ }
  return (Math.imul(sum, 31) ^ xor ^ Math.imul(n, 0x85ebca6b)) >>> 0
}

export interface AutoFitState {
  /** null while there is no content */
  signature: string | null
  /** Distinct session ids on screen (the "tab" scope) */
  sessions?: ReadonlyArray<string>
  /** Identity of the selected tab/scope (session id, 'all', team). A change always counts as a scope change. */
  scopeKey?: string
  width: number
  height: number
}

/**
 * AUTO-FIT RULE (issue #2). While the user has not panned / zoomed, the camera follows the content
 * continuously. A manual pan / zoom is then RESPECTED: the camera does not snap away when the content
 * changes. Auto-fit resumes only on
 *   - the first content after an empty canvas ("first"),
 *   - a tab / scope change: a session left the view, or several sessions appeared at once ("scope"),
 *   - the explicit Fit button / keyboard fit (handled by the camera hook, not here).
 * Not resuming: one new session appearing live, a team cluster forming, agents spawning, a canvas resize.
 */
export type ContentChange = 'none' | 'first' | 'scope' | 'growth'

export function classifyContentChange(prev: AutoFitState, next: AutoFitState): ContentChange {
  if (next.signature === null) return 'none'
  if (prev.signature === null) return 'first'
  // An explicit tab/scope change refits even when the cluster set looks like plain growth
  // (e.g. a session tab to 'All' with two sessions).
  if (prev.scopeKey !== next.scopeKey && next.scopeKey !== undefined) return 'scope'
  if (prev.signature === next.signature) return 'none'
  const before = prev.sessions
  const after = next.sessions
  if (!before || !after) return 'scope'
  const nextSet = new Set(after)
  for (const s of before) if (!nextSet.has(s)) return 'scope'
  const prevSet = new Set(before)
  let added = 0
  for (const s of after) if (!prevSet.has(s)) added++
  return added >= 2 ? 'scope' : 'growth'
}

export function shouldResumeAutoFit(prev: AutoFitState, next: AutoFitState): boolean {
  const c = classifyContentChange(prev, next)
  return c === 'first' || c === 'scope'
}
