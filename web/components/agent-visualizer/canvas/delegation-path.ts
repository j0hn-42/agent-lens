/**
 * Delegation path (issue #56): clicking a node highlights the chain root -> sub-agent -> tool and
 * animates it hop by hop. The path comes from the edges that are really drawn (never inferred), the
 * animation is time-capped for deep chains, and reduced motion shows the whole path at once.
 * Pure helpers + one stroke function: unit-testable under node:test (relative runtime imports only).
 */
import type { Agent, Edge, ToolCallNode } from '../../../lib/agent-types'
import { SCENE } from '../../../lib/colors'
import { MIN_VISIBLE_OPACITY } from '../../../lib/canvas-constants'
import { bezierPoint, computeControlPoints } from './link-geometry'
import { isAgentVisible } from './team-style'
import { isUnverifiedEdge, UNVERIFIED_DASH } from './edge-style'

/** Whole animation never lasts longer than this, however deep the chain */
export const PATH_MAX_DURATION_MS = 500
/** Time one hop takes when the chain is short enough not to hit the cap */
export const PATH_HOP_MS = 150
/** Safety bound on the walk up the tree (a cycle or a corrupt graph must not hang the frame) */
export const PATH_MAX_HOPS = 64
const CURVE_STEPS = 16

/** Edges from the root down to `targetId`, in order; [] for the root, an unknown node or null. */
export function delegationPathEdges(targetId: string | null, edges: readonly Edge[]): Edge[] {
  if (!targetId) return []
  const byTarget = new Map<string, Edge>()
  for (const edge of edges) if (!byTarget.has(edge.to)) byTarget.set(edge.to, edge)
  const path: Edge[] = []
  const seen = new Set<string>([targetId])
  let current = targetId
  while (path.length < PATH_MAX_HOPS) {
    const edge = byTarget.get(current)
    if (!edge || seen.has(edge.from)) break
    path.push(edge)
    seen.add(edge.from)
    current = edge.from
  }
  return path.reverse()
}

export function pathDurationMs(hops: number): number {
  if (hops <= 0) return 0
  return Math.min(PATH_MAX_DURATION_MS, hops * PATH_HOP_MS)
}

/** Progress (0..1) of hop `index` out of `hops` after `elapsedMs`; hops run one after the other. */
export function hopProgress(index: number, hops: number, elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion || hops <= 0) return 1
  const slot = pathDurationMs(hops) / hops
  if (slot <= 0) return 1
  return Math.min(1, Math.max(0, (elapsedMs - index * slot) / slot))
}

export interface PathAnimation {
  /** Ms since the path to `targetId` started drawing; null when nothing is selected. Restarts on a new target. */
  elapsed(targetId: string | null, nowMs: number): number | null
}

export function createPathAnimation(): PathAnimation {
  let target: string | null = null
  let startedAt = 0
  return {
    elapsed(targetId, nowMs) {
      if (!targetId) { target = null; return null }
      if (targetId !== target) { target = targetId; startedAt = nowMs }
      return Math.max(0, nowMs - startedAt)
    },
  }
}

/** Strokes the first `progress` (0..1) of the edge curve from -> to. */
export function strokeDelegationPath(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number }, to: { x: number; y: number },
  progress: number,
) {
  if (progress <= 0) return
  const upTo = Math.min(1, progress)
  const cp = computeControlPoints(from.x, from.y, to.x, to.y)
  const steps = Math.max(2, Math.ceil(CURVE_STEPS * upTo))
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * upTo
    if (!cp) { ctx.lineTo(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t); continue }
    ctx.lineTo(
      bezierPoint(t, from.x, cp.cp1x, cp.cp2x, to.x),
      bezierPoint(t, from.y, cp.cp1y, cp.cp2y, to.y),
    )
  }
  ctx.stroke()
}

/** Draws the highlighted chain; hops whose ends are not visible are skipped. */
export function drawDelegationPath(
  ctx: CanvasRenderingContext2D,
  path: readonly Edge[],
  agents: ReadonlyMap<string, Agent>,
  toolCalls: ReadonlyMap<string, ToolCallNode>,
  elapsedMs: number,
  reducedMotion: boolean,
) {
  if (path.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = SCENE.holoBright
  ctx.shadowColor = SCENE.holoBase
  ctx.shadowBlur = 8
  ctx.lineWidth = 2.5
  for (let i = 0; i < path.length; i++) {
    const edge = path[i]
    const from = agents.get(edge.from)
    if (!from || !isAgentVisible(from)) continue
    const toAgent = agents.get(edge.to)
    const toTool = toolCalls.get(edge.to)
    const to = toAgent && isAgentVisible(toAgent) ? toAgent : toTool && toTool.opacity >= MIN_VISIBLE_OPACITY ? toTool : null
    if (!to) continue
    // A hop the events do not prove stays dashed and dim (#54): the highlight never turns a guess into a fact
    if (isUnverifiedEdge(edge)) {
      ctx.setLineDash(UNVERIFIED_DASH)
      ctx.shadowBlur = 0
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 1.8
    } else {
      ctx.setLineDash([])
      ctx.shadowBlur = 8
      ctx.globalAlpha = 1
      ctx.lineWidth = 2.5
    }
    strokeDelegationPath(ctx, from, to, hopProgress(i, path.length, elapsedMs, reducedMotion))
  }
  ctx.restore()
}
