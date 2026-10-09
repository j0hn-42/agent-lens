import type { Agent } from '@/lib/agent-types'
import { SCENE } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'
import {
  type ResolvedLink, type LinkState, linkCurve, curvePoint, curveTangent,
} from './link-geometry'
import { EDGE_BUBBLE, PLACEMENT } from '@/lib/canvas-constants'
import { planKey, worldOffset, edgeBubblePlanId, type PlannableEdgeBubble } from './overlay-plan'

/** Badge font size (px): never below the 11px floor */
const BADGE_FONT = 11

interface LinkStyle {
  color: string
  width: number
  /** Non-colour cue: dash pattern (in flight = long dashes, error = dots) */
  dash: number[]
  alpha: number
}

const LINK_STYLES: Record<LinkState, LinkStyle> = {
  in_flight: { color: SCENE.dispatch, width: 3, dash: [9, 5], alpha: 0.95 },
  recent: { color: SCENE.return, width: 2.5, dash: [], alpha: 0.85 },
  error: { color: SCENE.error, width: 2.5, dash: [2, 4], alpha: 0.95 },
  idle: { color: SCENE.holoBase, width: 1.75, dash: [], alpha: 0.5 },
}

/** Line width grows slowly with the message count (never more than +2 px). */
export function linkWidth(base: number, count: number): number {
  return base + Math.min(2, Math.log2(Math.max(1, count)) / 2)
}

/** Text of the count badge: "!" prefix on error so the state is not carried by colour alone. */
export function linkBadgeText(count: number, state: LinkState): string {
  const n = count > 99 ? '99+' : String(count)
  return state === 'error' ? `! ${n}` : n
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, dirX: number, dirY: number, size: number, color: string) {
  const nx = -dirY, ny = dirX
  ctx.beginPath()
  ctx.moveTo(x + dirX * size, y + dirY * size)
  ctx.lineTo(x - dirX * size * 0.6 + nx * size * 0.7, y - dirY * size * 0.6 + ny * size * 0.7)
  ctx.lineTo(x - dirX * size * 0.6 - nx * size * 0.7, y - dirY * size * 0.6 - ny * size * 0.7)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

/**
 * Communication edges (teammate / spawn links): colour, width and dash by state, a chevron showing the
 * direction of the last message, and a message-count badge. Drawn under the agent nodes.
 */
export function drawLinks(
  ctx: CanvasRenderingContext2D,
  links: ResolvedLink[],
  agents: Map<string, Agent>,
  selectedLinkId: string | null | undefined,
  hoveredLinkId: string | null | undefined,
  time: number,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  const lod = lodForZoom(opts.zoom)
  for (const r of links) {
    const curve = linkCurve(r, agents)
    if (!curve) continue
    const style = LINK_STYLES[r.state]
    const selected = r.id === selectedLinkId
    const hovered = r.id === hoveredLinkId
    const width = linkWidth(style.width, r.count) + (selected || hovered ? 1 : 0)

    ctx.save()
    ctx.lineCap = 'round'
    const path = () => {
      ctx.beginPath()
      ctx.moveTo(curve.x0, curve.y0)
      ctx.bezierCurveTo(curve.cp1x, curve.cp1y, curve.cp2x, curve.cp2y, curve.x3, curve.y3)
    }

    // Selection halo: a wide soft stroke under the line (not colour-only: it is also thicker)
    if (selected) {
      path()
      ctx.strokeStyle = SCENE.textPrimary + alphaHex(0.35)
      ctx.lineWidth = width + 6
      ctx.stroke()
    }

    path()
    ctx.strokeStyle = style.color
    ctx.globalAlpha = style.alpha
    ctx.lineWidth = width
    ctx.setLineDash(style.dash)
    // Dashes crawl towards the receiver while a message is in flight (decoration, motion-safe)
    if (r.state === 'in_flight' && !opts.reducedMotion) ctx.lineDashOffset = -time * 30 * (r.lastBackward ? -1 : 1)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineDashOffset = 0
    ctx.globalAlpha = 1

    // Direction of the last message
    const dirSign = r.lastBackward ? -1 : 1
    const at = curvePoint(curve, r.lastBackward ? 0.38 : 0.62)
    const tan = curveTangent(curve, r.lastBackward ? 0.38 : 0.62)
    drawChevron(ctx, at.x, at.y, tan.x * dirSign, tan.y * dirSign, 5 + width * 0.5, style.color)

    // Count badge at the middle
    if (lod.labels && r.count > 0) {
      const mid = curvePoint(curve, 0.5)
      const text = linkBadgeText(r.count, r.state)
      ctx.font = `${BADGE_FONT}px monospace`
      const w = Math.max(18, ctx.measureText(text).width + 10)
      const h = 16
      ctx.beginPath()
      ctx.roundRect(mid.x - w / 2, mid.y - h / 2, w, h, 8)
      ctx.fillStyle = SCENE.cardBgDark
      ctx.fill()
      ctx.strokeStyle = style.color
      ctx.lineWidth = selected || hovered ? 2 : 1
      ctx.stroke()
      ctx.fillStyle = SCENE.textPrimary
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, mid.x, mid.y + 0.5)
    }
    ctx.restore()
  }
}

/**
 * Message bubbles anchored on communication edges (issue #41): a third of the way from the sender (near
 * the parent for a dispatch, near the child for a return), three lines at most. The bubble sits where
 * the overlay plan put it (collision-free); a short stem joins it to its anchor. Clicking it opens the
 * link panel (hit rectangles come from the overlay plan).
 */
export function drawEdgeBubbles(
  ctx: CanvasRenderingContext2D,
  bubbles: PlannableEdgeBubble[],
  selectedLinkId: string | null | undefined,
  hoveredLinkId: string | null | undefined,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  if (!lodForZoom(opts.zoom).details) return
  const scale = opts.zoom > 0 ? opts.zoom : 1
  for (const b of bubbles) {
    const place = opts.plan?.get(planKey.edgeBubble(edgeBubblePlanId(b)))
    if (!place || place.hidden) continue
    // Where the planner put it: the preferred spot (above the anchor) moved by the placement offset
    const off = worldOffset(place, scale)
    const baseX = b.anchor.x - b.w / 2
    const baseY = b.anchor.y - b.h - 10
    const collapsed = place.collapsed
    const rect = collapsed
      ? { x: baseX + off.dx, y: baseY + b.h - PLACEMENT.chipH / scale + off.dy, w: PLACEMENT.chipW / scale, h: PLACEMENT.chipH / scale }
      : { x: baseX + off.dx, y: baseY + off.dy, w: b.w, h: b.h }
    const color = b.isError ? SCENE.error : b.type === 'return' ? SCENE.return : b.type === 'dispatch' ? SCENE.dispatch : SCENE.holoBase
    const emphasised = b.linkId === selectedLinkId || b.linkId === hoveredLinkId

    ctx.save()
    // Stem to the anchor on the edge
    const sx = Math.min(Math.max(b.anchor.x, rect.x + 6), rect.x + rect.w - 6)
    const sy = b.anchor.y < rect.y ? rect.y : rect.y + rect.h
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(b.anchor.x, b.anchor.y)
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1 / scale + 0.5
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(b.anchor.x, b.anchor.y, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = 1

    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, collapsed ? 8 / scale : 5)
    ctx.fillStyle = SCENE.cardBgDark
    ctx.fill()
    ctx.strokeStyle = color
    // Error bubbles are dotted: the state is not carried by colour alone
    ctx.setLineDash(b.isError ? [2, 3] : [])
    ctx.lineWidth = emphasised ? 2 : 1
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font = `${EDGE_BUBBLE.fontSize}px monospace`
    ctx.fillStyle = SCENE.textPrimary
    if (collapsed) {
      // Count chip: how many messages the link shows; the text is the number only
      ctx.font = `${EDGE_BUBBLE.fontSize / scale}px monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(b.groupCount ?? 1), rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5)
      ctx.restore()
      continue
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    for (let i = 0; i < b.lines.length; i++) {
      ctx.fillText(b.lines[i], rect.x + EDGE_BUBBLE.padding, rect.y + EDGE_BUBBLE.padding + i * EDGE_BUBBLE.lineHeight)
    }
    ctx.restore()
  }
}
