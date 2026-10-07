import { COLORS } from '@/lib/colors'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'
import { type TeamHalo, haloLabelAnchor } from './team-style'

const HALO_LABEL_FONT = 12

/**
 * Translucent cluster halo behind every team with several members, with the team name above it.
 * Colours come from `TeamHalo.color`, which is already validated as '#rrggbb'.
 * Drawn first, under edges and nodes.
 */
export function drawTeamHalos(ctx: CanvasRenderingContext2D, halos: TeamHalo[], opts: DrawOpts = DEFAULT_DRAW_OPTS) {
  if (halos.length === 0) return
  const lod = lodForZoom(opts.zoom)
  for (const h of halos) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(h.cx, h.cy, h.r, 0, Math.PI * 2)
    ctx.fillStyle = h.color + '14'
    ctx.fill()
    // Dashed outline: the halo is also recognisable without its colour
    ctx.setLineDash([10, 6])
    ctx.strokeStyle = h.color + '99'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.setLineDash([])

    if (lod.labels) {
      const anchor = haloLabelAnchor(h)
      const text = `${h.name} (${h.memberIds.length})`
      ctx.font = `600 ${HALO_LABEL_FONT}px monospace`
      const w = ctx.measureText(text).width + 14
      const hgt = 20
      ctx.beginPath()
      ctx.roundRect(anchor.x - w / 2, anchor.y - hgt, w, hgt, 6)
      ctx.fillStyle = COLORS.cardBgDark
      ctx.fill()
      ctx.strokeStyle = h.color + 'cc'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = COLORS.textPrimary
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, anchor.x, anchor.y - hgt / 2 + 1)
    }
    ctx.restore()
  }
}
