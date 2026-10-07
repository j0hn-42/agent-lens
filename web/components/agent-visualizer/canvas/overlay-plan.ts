/**
 * Per-frame plan of every text overlay of the canvas in SCREEN space: agent labels, stats boxes, cost
 * pills, message bubbles, edge bubbles and cluster labels are placed greedily so that texts of different
 * clusters never overlap. The selected / hovered / focused agent has priority; when overlays collide
 * the agent bubbles of the other clusters collapse to a small count chip, link bubbles and secondary
 * overlays are hidden, and agent labels shrink to one line. Pure: unit-testable under node:test.
 */
import type { Agent, TeamSummary } from '../../../lib/agent-types'
import {
  AGENT_DRAW, CONTEXT_BAR, BUBBLE_MAX_W, BUBBLE_GAP, BUBBLE_DRAW, STATS_OVERLAY, COST_DRAW, CLUSTER_DRAW, PLACEMENT,
} from '../../../lib/canvas-constants'
import { agentCostUsage } from '../../../lib/cost'
import { formatCostUsage } from '../../../lib/usage'
import { bubbleAlpha } from './bubble-utils'
import { computeOverlayLayout } from './overlay-layout'
import { hasContextPercentFor } from './overlay-metrics'
import {
  isAgentVisible, agentDrawOpacity, agentDrawRadius, layoutAgentLabel, isOrchestrator, ellipsize,
  orchestratorInfo,
} from './team-style'
import { estimateTextWidth, type EdgeBubble } from './edge-bubbles'
import { clampRectToSafe, type Rect as FitRect } from './camera-fit'
import { clusterLabelLines, clusterLabelAnchor, type Cluster } from './cluster-model'
import {
  placeRects, overlayPriority, PRIORITY, type PlacementRequest, type Placement, type Rect, type Obstacle, type OverlayPlan,
} from './label-placement'

/** The context bar is drawn under the label (live agents that have used tokens). */
export function contextBarShown(a: Pick<Agent, 'tokensUsed' | 'state' | 'opacity' | 'archived'>): boolean {
  if (a.archived || !(a.tokensUsed > 0)) return false
  return a.state !== 'complete' || a.opacity > 0.5
}

/** Height (world px) from the top of the label block to the bottom of the context bar and its token text. */
export function contextBlockHeight(radius: number, extraLines: number): number {
  const barBottom = radius + CONTEXT_BAR.yOffset + extraLines * AGENT_DRAW.stateLabelGap + CONTEXT_BAR.barHeight + CONTEXT_BAR.labelBoxExtra
  return barBottom - (radius + AGENT_DRAW.labelYOffset)
}

function insetRect(r: FitRect, by: number): FitRect {
  const d = Math.min(by, r.w / 4, r.h / 4)
  return { x: r.x + d, y: r.y + d, w: r.w - d * 2, h: r.h - d * 2 }
}

export interface Transform2D { x: number; y: number; scale: number }

/** An EdgeBubble, optionally one of several on its link. */
export type PlannableEdgeBubble = EdgeBubble & { key?: string; groupCount?: number; primary?: boolean }

/** Plan id of a bubble: its own key, or its link id for the single-bubble form. */
export function edgeBubblePlanId(b: PlannableEdgeBubble): string {
  return b.key ?? b.linkId
}

export interface OverlayPlanInput {
  agents: Map<string, Agent>
  clusters: Cluster[]
  /** Edge bubbles; a bubble with a `key` (several per link) is planned under it, the others under their link id */
  edgeBubbles: PlannableEdgeBubble[]
  transform: Transform2D
  viewport: { w: number; h: number }
  /** Screen area free of overlaid UI (top bar, control bar, panels): cluster labels are clamped inside it */
  safeArea?: Rect
  lod: { labels: boolean; details: boolean }
  showStats: boolean
  showCost: boolean
  showSessionLabels: boolean
  selectedAgentId: string | null
  hoveredAgentId: string | null
  focusedAgentId: string | null
  selectedLinkId?: string | null
  hoveredLinkId?: string | null
  /** Keys of the edge bubbles that are hovered / focused: planned just below the selected agent's labels (see HELD_BUBBLE_BOOST) */
  heldBubbleKeys?: ReadonlySet<string>
  simTime: number
  /** Teams, to tell a team lead from a session's main agent in the label layout */
  teams?: ReadonlyMap<string, Pick<TeamSummary, 'leadSessionId' | 'name'>>
  /** Agent ids whose bubbles never expire (hovered / focused / paused) */
  isBubbleHeld: (agentId: string) => boolean
}

export interface OverlayHits {
  /** World rectangles */
  clusterLabels: Map<string, Rect>
  edgeBubbles: Map<string, Rect>
  /** World rectangle of every placed edge bubble by bubble key (plan id), whether collapsed or not */
  edgeBubbleRects: Map<string, Rect>
  /** Count chips that replace the bubbles of an agent */
  collapsedBubbles: Map<string, Rect>
}

export interface OverlayPlanResult {
  plan: Map<string, Placement>
  hits: OverlayHits
  /** Many agents on screen: secondary overlays are limited to the priority agents */
  crowded: boolean
}

/**
 * Priority added to a hovered / focused bubble. Kept strictly below the 1000 that a selected / hovered /
 * focused agent adds to its labels: a bubble the user points at never displaces the selected agent's label.
 */
export const HELD_BUBBLE_BOOST = 990
/** Priority added to a bubble on the selected / hovered link (below the held boost) */
const EMPHASISED_BUBBLE_BOOST = 900

/** Keys of the plan */
export const planKey = {
  label: (agentId: string) => `label:${agentId}`,
  stats: (agentId: string) => `stats:${agentId}`,
  cost: (agentId: string) => `cost:${agentId}`,
  bubbles: (agentId: string) => `bubbles:${agentId}`,
  edgeBubble: (linkId: string) => `ebub:${linkId}`,
  cluster: (key: string) => `cluster:${key}`,
}

const LABEL_FONT = AGENT_DRAW.labelFontSize
const LABEL_PAD = 2

function toScreen(t: Transform2D, x: number, y: number, w: number, h: number): Rect {
  return { x: x * t.scale + t.x, y: y * t.scale + t.y, w: w * t.scale, h: h * t.scale }
}

function toWorld(t: Transform2D, r: Rect): Rect {
  return { x: (r.x - t.x) / t.scale, y: (r.y - t.y) / t.scale, w: r.w / t.scale, h: r.h / t.scale }
}

function onScreen(r: Rect, vp: { w: number; h: number }, margin = 40): boolean {
  return r.x + r.w >= -margin && r.y + r.h >= -margin && r.x <= vp.w + margin && r.y <= vp.h + margin
}

/** Sentinel for the empty plan (nothing hidden, nothing moved) */
export const EMPTY_PLAN: OverlayPlanResult = {
  plan: new Map(),
  hits: { clusterLabels: new Map(), edgeBubbles: new Map(), edgeBubbleRects: new Map(), collapsedBubbles: new Map() },
  crowded: false,
}

export function planOverlays(input: OverlayPlanInput): OverlayPlanResult {
  const t = input.transform
  if (!(t.scale > 0) || input.viewport.w <= 0 || input.viewport.h <= 0) return EMPTY_PLAN
  const s = t.scale
  const vp = input.viewport

  const clusterOf = new Map<string, string>()
  for (const c of input.clusters) for (const id of c.memberIds) clusterOf.set(id, c.key)
  const prioritized = new Set<string>()
  for (const id of [input.selectedAgentId, input.hoveredAgentId, input.focusedAgentId]) if (id) prioritized.add(id)
  const priorityClusters = new Set<string>()
  for (const id of prioritized) { const k = clusterOf.get(id); if (k) priorityClusters.add(k) }

  const requests: PlacementRequest[] = []
  const obstacles: Obstacle[] = []
  let visibleAgents = 0

  const visible: Agent[] = []
  for (const a of input.agents.values()) {
    if (!isAgentVisible(a)) continue
    const r = agentDrawRadius(a)
    const box = toScreen(t, a.x - r, a.y - r, r * 2, r * 2)
    if (!onScreen(box, vp, 200)) continue
    visible.push(a)
    visibleAgents++
    const pad = (AGENT_DRAW.outerRingOffset + 3) * s
    obstacles.push({ owner: a.id, rect: { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 } })
  }
  const crowded = visibleAgents > PLACEMENT.crowdedItems

  // ─── Cluster labels (essential: never hidden, kept at the least-overlapping spot) ───
  const clusterRects = new Map<string, Rect>()
  const labelArea = input.safeArea && input.safeArea.w > 0 && input.safeArea.h > 0
    ? insetRect(input.safeArea, 4)
    : { x: 4, y: 4, w: Math.max(0, vp.w - 8), h: Math.max(0, vp.h - 8) }
  for (const c of input.clusters) {
    const lines = clusterLabelLines(c)
    const w = Math.min(CLUSTER_DRAW.labelMaxWidth, Math.max(
      estimateTextWidth(lines.title, CLUSTER_DRAW.labelFontSize), estimateTextWidth(lines.detail, CLUSTER_DRAW.detailFontSize),
    ) + 16)
    const h = CLUSTER_DRAW.labelHeight
    const a = clusterLabelAnchor(c)
    const ax = a.x * s + t.x
    const ay = a.y * s + t.y
    if (!onScreen({ x: ax - c.r * s, y: ay, w: c.r * 2 * s, h: c.r * 2 * s }, vp, 0)) continue
    const rect = clampRectToSafe({ x: ax - w / 2, y: ay - h - 4, w, h }, labelArea)
    clusterRects.set(c.key, rect)
    requests.push({
      id: planKey.cluster(c.key),
      priority: overlayPriority(PRIORITY.clusterLabel, { selected: priorityClusters.has(c.key) }),
      rect,
      essential: true,
    })
  }

  for (const a of visible) {
    const id = a.id
    const r = agentDrawRadius(a)
    const flags = {
      selected: id === input.selectedAgentId,
      hovered: id === input.hoveredAgentId,
      focused: id === input.focusedAgentId,
      orchestrator: isOrchestrator(a),
      active: a.state === 'thinking' || a.state === 'tool_calling' || a.state === 'waiting_permission',
    }
    const isPriority = flags.selected || flags.hovered || flags.focused
    const secondaryAllowed = !crowded || isPriority

    // Agent label: full block, or one line "name · status" when the room is short
    if (input.lod.labels) {
      const measure = (text: string) => estimateTextWidth(text, LABEL_FONT)
      const layout = layoutAgentLabel(a, r, measure, input.showSessionLabels && secondaryAllowed, orchestratorInfo(a, input.teams))
      const lines = layout.nameLines.length + 1 + (layout.sessionLine ? 1 : 0) + (layout.groupLine ? 1 : 0)
      const widest = Math.max(
        ...layout.nameLines.map(measure), measure(layout.statusLine),
        layout.sessionLine ? measure(layout.sessionLine) : 0, layout.groupLine ? measure(layout.groupLine) : 0,
      )
      const wW = Math.max(36, widest) + LABEL_PAD * 2
      const top = a.y + r + AGENT_DRAW.labelYOffset
      // The context bar hangs under the label block and moves with it: reserve its height so a shifted
      // label never lands on the bar (or its token text)
      const barShown = contextBarShown(a)
      const labelH = lines * AGENT_DRAW.stateLabelGap
      const blockH = barShown ? Math.max(labelH, contextBlockHeight(r, layout.extraLines)) : labelH
      const full = toScreen(t, a.x - wW / 2, top, wW, blockH)
      const maxCompactW = r * AGENT_DRAW.labelWidthMultiplier * 1.5
      const compactText = ellipsize(`${a.name} · ${layout.statusLine}`, maxCompactW, measure)
      const cW = measure(compactText) + LABEL_PAD * 2
      const compact = toScreen(t, a.x - cW / 2, top, cW, barShown ? blockH : AGENT_DRAW.stateLabelGap)
      requests.push({
        id: planKey.label(id),
        priority: overlayPriority(PRIORITY.agentLabel, flags),
        rect: full,
        compact,
        owner: id,
        offsets: [{ dx: 0, dy: full.h }, { dx: 0, dy: -(full.h + 2 * r * s + 10) }],
      })
    }

    // Stats box and cost pill, stacked above the node (same layout as the draw code)
    const costUsage = agentCostUsage(a)
    const showStatsBox = input.lod.details && input.showStats && a.state !== 'complete'
    const showCostPill = input.lod.details && input.showCost && costUsage.value !== null && costUsage.value >= COST_DRAW.minDisplayCost
    if ((showStatsBox || showCostPill) && secondaryAllowed) {
      const layout = computeOverlayLayout({
        hasPercent: hasContextPercentFor(a), showStats: showStatsBox, showCost: showCostPill,
      })
      if (showStatsBox && layout.statsTop != null) {
        requests.push({
          id: planKey.stats(id),
          priority: overlayPriority(PRIORITY.stats, flags),
          rect: toScreen(t, a.x - STATS_OVERLAY.boxWidth / 2, a.y - r - layout.statsTop, STATS_OVERLAY.boxWidth, STATS_OVERLAY.boxHeight),
          owner: id,
        })
      }
      if (showCostPill && layout.costTop != null) {
        const pillW = estimateTextWidth(formatCostUsage(costUsage), 11) * 1.1 + COST_DRAW.pillPadding
        requests.push({
          id: planKey.cost(id),
          priority: overlayPriority(PRIORITY.cost, flags),
          rect: toScreen(t, a.x - pillW / 2, a.y - r - layout.costTop, pillW, COST_DRAW.pillHeight),
          owner: id,
        })
      }
    }

    // Agent message bubbles: one stack per agent, collapsed to a count chip when it collides
    if (a.messageBubbles.length > 0) {
      const held = input.isBubbleHeld(id)
      const opacity = agentDrawOpacity(a)
      let live = 0
      let w = 0
      let h = 0
      for (const b of a.messageBubbles) {
        if (bubbleAlpha(input.simTime - b.time, opacity, held) < 0.01) continue
        const style = b.role === 'thinking' ? BUBBLE_DRAW.thinking : BUBBLE_DRAW.normal
        const bw = b._cachedW ?? BUBBLE_MAX_W
        const bh = b._cachedH ?? style.headerH + 3 * style.lineH + style.padding
        live++
        w = Math.max(w, bw)
        h += bh + (live > 1 ? BUBBLE_GAP : 0)
      }
      if (live > 0) {
        const ax = a.x + r + AGENT_DRAW.bubbleAnchorOffset
        const ay = a.y + AGENT_DRAW.bubbleCursorY
        const full = toScreen(t, ax, ay, w, h)
        const clusterBoost = (clusterOf.get(id) && priorityClusters.has(clusterOf.get(id) as string)) ? 500 : 0
        requests.push({
          id: planKey.bubbles(id),
          priority: overlayPriority(PRIORITY.agentBubbles, flags) + clusterBoost,
          rect: full,
          compact: { x: full.x, y: full.y, w: PLACEMENT.chipW, h: PLACEMENT.chipH },
          owner: id,
          fixed: true,
          ignoreObstacles: isPriority,
        })
      }
    }
  }

  // ─── Edge bubbles ───
  // Below the labels of the selected / hovered / focused agent, above agent bubbles. Only the newest bubble
  // of a link may collapse to a count chip; the older ones are hidden when they do not fit.
  const bubbleLinkOf = new Map<string, string>()
  for (const b of input.lod.details ? input.edgeBubbles : []) {
    if (b.w <= 0) continue
    const id = edgeBubblePlanId(b)
    const emphasised = b.linkId === input.selectedLinkId || b.linkId === input.hoveredLinkId
    const boost = input.heldBubbleKeys?.has(id) ? HELD_BUBBLE_BOOST : emphasised ? EMPHASISED_BUBBLE_BOOST : 0
    const preferred = toScreen(t, b.anchor.x - b.w / 2, b.anchor.y - b.h - 10, b.w, b.h)
    if (!onScreen(preferred, vp, 0)) continue
    bubbleLinkOf.set(planKey.edgeBubble(id), b.linkId)
    const chip = (b.primary ?? true)
      ? { x: preferred.x, y: preferred.y + preferred.h - PLACEMENT.chipH, w: PLACEMENT.chipW, h: PLACEMENT.chipH }
      : undefined
    requests.push({
      id: planKey.edgeBubble(id),
      priority: PRIORITY.edgeBubble + boost,
      rect: preferred,
      compact: chip,
      offsets: [
        { dx: 0, dy: b.h * s + 20 }, { dx: (b.w * s) * 0.6, dy: 0 }, { dx: -(b.w * s) * 0.6, dy: 0 },
        { dx: (b.w * s) * 0.6, dy: b.h * s + 20 }, { dx: -(b.w * s) * 0.6, dy: b.h * s + 20 },
      ],
    })
  }

  const placements = placeRects(requests, { bounds: { x: 0, y: 0, w: vp.w, h: vp.h }, obstacles })
  const plan = new Map<string, Placement>()
  const hits: OverlayHits = { clusterLabels: new Map(), edgeBubbles: new Map(), edgeBubbleRects: new Map(), collapsedBubbles: new Map() }
  for (const p of placements) {
    plan.set(p.id, p)
    if (!p.rect || p.hidden) continue
    if (p.id.startsWith('cluster:')) hits.clusterLabels.set(p.id.slice('cluster:'.length), toWorld(t, p.rect))
    else if (p.id.startsWith('ebub:')) {
      const world = toWorld(t, p.rect)
      hits.edgeBubbleRects.set(p.id.slice('ebub:'.length), world)
      // Canvas hit-test keeps one rectangle per link; the newest bubble (placed last in request order) wins
      hits.edgeBubbles.set(bubbleLinkOf.get(p.id) ?? p.id.slice('ebub:'.length), world)
    }
    else if (p.id.startsWith('bubbles:') && p.collapsed) hits.collapsedBubbles.set(p.id.slice('bubbles:'.length), toWorld(t, p.rect))
  }
  return { plan, hits, crowded }
}

/** World offset of a placement (screen px divided by the zoom). */
export function worldOffset(p: Placement | undefined, scale: number): { dx: number; dy: number } {
  if (!p || !(scale > 0)) return { dx: 0, dy: 0 }
  return { dx: p.dx / scale, dy: p.dy / scale }
}

export interface ResolvedPlacement {
  /** Draw it at all */
  visible: boolean
  /** Draw the compact form (count chip, one-line label) */
  collapsed: boolean
  /** World offset to translate the drawing by */
  dx: number
  dy: number
}

/**
 * What a draw function does for the overlay `key`. Without a plan everything is drawn in place; with a
 * plan an overlay that is not in it (off screen, or skipped because the view is crowded) is not drawn.
 */
export function resolvePlacement(plan: OverlayPlan | undefined, key: string, scale: number): ResolvedPlacement {
  if (!plan) return { visible: true, collapsed: false, dx: 0, dy: 0 }
  const p = plan.get(key)
  if (!p || p.hidden) return { visible: false, collapsed: false, dx: 0, dy: 0 }
  const o = worldOffset(p, scale)
  return { visible: true, collapsed: p.collapsed, dx: o.dx, dy: o.dy }
}
