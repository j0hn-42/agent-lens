import { SCENE } from '@/lib/colors'
import { type DrawOpts, DEFAULT_DRAW_OPTS } from './draw-options'
import type { FileConflictSegment } from './file-conflict-model'

/**
 * File conflicts (#227): a red dash-dot line between two agents that edited the same file, with a
 * diamond at its middle, so it reads apart from the dotted red error link without colour. Static
 * (no motion of its own). Drawn under the nodes.
 */
export function drawFileConflicts(ctx: CanvasRenderingContext2D, segments: ReadonlyArray<FileConflictSegment>, opts: DrawOpts = DEFAULT_DRAW_OPTS) {
  if (segments.length === 0) return
  const k = Math.max(1, 1 / Math.max(opts.zoom || 1, 1e-3))
  for (const s of segments) {
    ctx.save()
    ctx.strokeStyle = SCENE.error
    ctx.fillStyle = SCENE.error
    ctx.globalAlpha = 0.85
    ctx.lineWidth = 1.75 * k
    ctx.setLineDash([10 * k, 4 * k, 2 * k, 4 * k])
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
    ctx.stroke()
    ctx.setLineDash([])
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    const d = 5 * k
    ctx.beginPath()
    ctx.moveTo(mx, my - d)
    ctx.lineTo(mx + d, my)
    ctx.lineTo(mx, my + d)
    ctx.lineTo(mx - d, my)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}
