import { SCENE } from '@/lib/colors'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'
import { type TeamHalo, haloLabelAnchor } from './team-style'
import { type Cluster, type PhaseLabel, clusterLabelLines, haloAlphas } from './cluster-model'
import { CLUSTER_DRAW } from '@/lib/canvas-constants'
import { planKey } from './overlay-plan'
import type { OverlayPlan } from './label-placement'
import type { SessionLinkSegment } from './session-link-model'

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
      ctx.fillStyle = SCENE.cardBgDark
      ctx.fill()
      ctx.strokeStyle = h.color + 'cc'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = SCENE.textPrimary
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, anchor.x, anchor.y - hgt / 2 + 1)
    }
    ctx.restore()
  }
}

/**
 * Halo of every cluster (one per session and one per team), under the edges and nodes. A team halo is
 * dashed and a session halo solid-dotted, so the two kinds differ without colour. Colours come from
 * `Cluster.color`, already validated as '#rrggbb'. The label is drawn separately, in screen space.
 */
export function drawClusterHalos(
  ctx: CanvasRenderingContext2D, clusters: Cluster[], selectedKey?: string | null, opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  // At tiny scales (fit of dozens of clusters) a world-space stroke would fall under one device pixel:
  // below zoom 1 the outline keeps its 1.5 px on-screen width and the dashes scale with it.
  const k = Math.max(1, 1 / Math.max(opts.zoom || 1, 1e-3))
  for (const c of clusters) {
    const selected = c.key === selectedKey
    ctx.save()
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2)
    const alpha = haloAlphas(c, selected)
    ctx.fillStyle = c.color + alpha.fill
    ctx.fill()
    ctx.setLineDash(c.kind === 'team' ? [10 * k, 6 * k] : [2 * k, 5 * k])
    ctx.strokeStyle = c.color + alpha.stroke
    ctx.lineWidth = (selected ? 2.5 : 1.5) * k
    ctx.stroke()
    ctx.restore()
  }
}

/**
 * Phase labels of the workflows (#146): a small chip above each phase sub-group, in world space like the
 * nodes it names. Drawn only at zoom levels where text is readable.
 */
export function drawPhaseLabels(ctx: CanvasRenderingContext2D, labels: ReadonlyArray<PhaseLabel>, opts: DrawOpts = DEFAULT_DRAW_OPTS) {
  if (labels.length === 0 || !lodForZoom(opts.zoom).labels) return
  ctx.save()
  ctx.font = `600 ${HALO_LABEL_FONT}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const hgt = 20
  for (const l of labels) {
    const w = ctx.measureText(l.text).width + 14
    ctx.beginPath()
    ctx.roundRect(l.x - w / 2, l.y - hgt, w, hgt, 6)
    ctx.fillStyle = SCENE.cardBgDark
    ctx.fill()
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = SCENE.textMuted
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = SCENE.textPrimary
    ctx.fillText(l.text, l.x, l.y - hgt / 2 + 1)
  }
  ctx.restore()
}

/**
 * Cluster labels in SCREEN space (readable at any zoom): a chip with "Session|Team name (n)" and, under
 * it, runtime, workspace, status and cost. Positions come from the overlay plan (collision-free).
 * Call after the world transform has been restored.
 */
export function drawClusterLabels(
  ctx: CanvasRenderingContext2D, clusters: Cluster[], plan: OverlayPlan | undefined, selectedKey?: string | null,
  hoveredKey?: string | null,
) {
  if (!plan) return
  for (const c of clusters) {
    const place = plan.get(planKey.cluster(c.key))
    if (!place || !place.rect || place.hidden) continue
    const { x, y, w, h } = place.rect
    const lines = clusterLabelLines(c)
    const emphasised = c.key === selectedKey || c.key === hoveredKey
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 6)
    ctx.fillStyle = SCENE.cardBgDark
    ctx.fill()
    ctx.strokeStyle = c.color + 'dd'
    ctx.lineWidth = emphasised ? 2.5 : 1.25
    ctx.setLineDash(c.kind === 'team' ? [5, 3] : [])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(x + 9, y + 11, 4, 0, Math.PI * 2)
    ctx.fillStyle = c.color
    ctx.fill()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = `600 ${CLUSTER_DRAW.labelFontSize}px monospace`
    ctx.fillStyle = SCENE.textPrimary
    ctx.save()
    ctx.beginPath()
    ctx.rect(x + 4, y, w - 8, h)
    ctx.clip()
    ctx.fillText(lines.title, x + 18, y + 4)
    ctx.font = `${CLUSTER_DRAW.detailFontSize}px monospace`
    ctx.fillStyle = SCENE.textMuted
    ctx.fillText(lines.detail, x + 8, y + 4 + CLUSTER_DRAW.labelFontSize + 4)
    ctx.restore()
    ctx.restore()
  }
}

/**
 * Edges between a parent session's halo and the halos of the sessions it launched. Task links are
 * dotted, worktree links dashed, so the kind reads without colour; an arrowhead marks the child.
 * Drawn under the nodes, above the halos.
 */
export function drawSessionLinks(ctx: CanvasRenderingContext2D, segments: ReadonlyArray<SessionLinkSegment>, opts: DrawOpts = DEFAULT_DRAW_OPTS) {
  if (segments.length === 0) return
  const k = Math.max(1, 1 / Math.max(opts.zoom || 1, 1e-3))
  for (const s of segments) {
    ctx.save()
    ctx.strokeStyle = SCENE.textMuted
    ctx.fillStyle = SCENE.textMuted
    ctx.lineWidth = 1.5 * k
    ctx.setLineDash(s.kind === 'worktree' ? [8 * k, 5 * k] : [2 * k, 5 * k])
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
    ctx.stroke()
    ctx.setLineDash([])
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
    const size = 8 * k
    ctx.beginPath()
    ctx.moveTo(s.x2, s.y2)
    ctx.lineTo(s.x2 - size * Math.cos(angle - 0.4), s.y2 - size * Math.sin(angle - 0.4))
    ctx.lineTo(s.x2 - size * Math.cos(angle + 0.4), s.y2 - size * Math.sin(angle + 0.4))
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}
