import type { Discovery, ToolCallNode } from '@/lib/agent-types'
import { SCENE, getDiscoveryTypeColor } from '@/lib/colors'
import { SEARCH_DISCOVERY, SEARCH_FLOW, MIN_VISIBLE_OPACITY, getDiscoveryCardDimensions } from '@/lib/canvas-constants'
import type { DrawOpts } from './draw-options'

/** A line from a completed Grep tool card (Glob makes no card, #451) to one of the file cards its output listed (#384) */
export interface FlowSegment {
  discoveryId: string
  toolCallId: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** Opacity of the file card (or of the tool card when it fades first) */
  opacity: number
  /** 0-based rank among the segments of the same call, and how many the call has */
  index: number
  count: number
}

/**
 * The segments to draw. A card gets one only when it was made from a search (`listing`) and a tool call of the
 * same agent with the same `toolUseId` is present and complete: the link is the id, never a guess from position
 * or time. A card that has faded out or a call that has disappeared gives nothing. At most
 * SEARCH_DISCOVERY.maxPerCall segments per call, whatever the discoveries hold.
 */
export function searchFlowSegments(
  discoveries: readonly Discovery[],
  toolCalls: ReadonlyMap<string, ToolCallNode>,
  cardSize: (toolCallId: string) => { w: number; h: number } | undefined,
): FlowSegment[] {
  let byKey: Map<string, ToolCallNode> | null = null
  const perCall = new Map<string, number>()
  const out: FlowSegment[] = []
  for (const d of discoveries) {
    if (!d.listing || !d.toolUseId || d.opacity < MIN_VISIBLE_OPACITY) continue
    if (!byKey) {
      byKey = new Map()
      for (const t of toolCalls.values()) {
        if (t.toolUseId && t.state === 'complete') byKey.set(`${t.agentId}\u0000${t.toolUseId}`, t)
      }
    }
    const call = byKey.get(`${d.agentId}\u0000${d.toolUseId}`)
    if (!call || call.opacity < MIN_VISIBLE_OPACITY) continue
    const n = perCall.get(call.id) ?? 0
    if (n >= SEARCH_DISCOVERY.maxPerCall) continue
    perCall.set(call.id, n + 1)
    const toolW = cardSize(call.id)?.w ?? 0
    const { cardW } = getDiscoveryCardDimensions(d.label, d.content.split('\n'))
    out.push({
      discoveryId: d.id,
      toolCallId: call.id,
      x1: call.x + toolW / 2,
      y1: call.y,
      x2: d.x - cardW / 2 - SEARCH_FLOW.edgeGap,
      y2: d.y,
      opacity: Math.min(d.opacity, call.opacity),
      index: n,
      count: 0,
    })
  }
  for (const s of out) s.count = perCall.get(s.toolCallId) ?? 1
  return out
}

/** Where a chip is along its line, in [0, 1): chips of one call are spread evenly so they never pile up */
function flowChipPosition(time: number, index: number, count: number): number {
  const phase = time * SEARCH_FLOW.speed + index / Math.max(1, count)
  return phase - Math.floor(phase)
}

/**
 * A thin line with an arrowhead at the file card, always drawn: the direction (call to files) is carried by the
 * arrowhead, not by motion. Unless motion is calm, one chip per card also travels along the line; the chip
 * count is the card count, so it is bounded by SEARCH_DISCOVERY.maxPerCall per call. No text is drawn.
 */
export function drawSearchFlow(ctx: CanvasRenderingContext2D, segments: readonly FlowSegment[], time: number, opts: DrawOpts) {
  if (segments.length === 0) return
  const color = getDiscoveryTypeColor('file', SCENE)
  for (const s of segments) {
    const dx = s.x2 - s.x1
    const dy = s.y2 - s.y1
    const len = Math.hypot(dx, dy)
    if (len < SEARCH_FLOW.arrowLength * 2) continue
    const ux = dx / len
    const uy = dy / len
    const bx = s.x2 - ux * SEARCH_FLOW.arrowLength
    const by = s.y2 - uy * SEARCH_FLOW.arrowLength
    ctx.save()
    ctx.globalAlpha = s.opacity * 0.6
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(bx, by)
    ctx.stroke()
    // Arrowhead: the direction, whatever the motion setting
    ctx.beginPath()
    ctx.moveTo(s.x2, s.y2)
    ctx.lineTo(bx - uy * SEARCH_FLOW.arrowHalfWidth, by + ux * SEARCH_FLOW.arrowHalfWidth)
    ctx.lineTo(bx + uy * SEARCH_FLOW.arrowHalfWidth, by - ux * SEARCH_FLOW.arrowHalfWidth)
    ctx.closePath()
    ctx.fill()
    if (!opts.reducedMotion) {
      const p = flowChipPosition(time, s.index, s.count)
      ctx.globalAlpha = s.opacity
      ctx.beginPath()
      ctx.arc(s.x1 + dx * p, s.y1 + dy * p, SEARCH_FLOW.chipRadius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}
