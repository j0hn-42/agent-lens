import { Agent, Discovery } from '@/lib/agent-types'
import { SCENE, getDiscoveryTypeColor } from '@/lib/colors'
import { getDiscoveryCardDimensions, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { truncateText } from './draw-misc'
import { maskText } from '../../../lib/presentation'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodOf, textHoldScale } from './draw-options'

export function drawDiscoveryConnections(ctx: CanvasRenderingContext2D, discoveries: Discovery[], agents: Map<string, Agent>) {
  for (const disc of discoveries) {
    const agent = agents.get(disc.agentId)
    if (!agent || disc.opacity < 0.1) continue

    ctx.save()
    ctx.globalAlpha = disc.opacity * 0.3
    ctx.strokeStyle = SCENE.holoBase + '30'
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 5])
    ctx.beginPath()
    ctx.moveTo(agent.x, agent.y)
    ctx.lineTo(disc.x, disc.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }
}

export function drawDiscoveries(ctx: CanvasRenderingContext2D, discoveries: Discovery[], agents: Map<string, Agent>, selectedDiscoveryId?: string | null, opts: DrawOpts = DEFAULT_DRAW_OPTS) {
  // The text is hidden where 11 px would fall under LOD.minTextPx; in the hysteresis band the card is enlarged to hold it (#378)
  const showText = lodOf(opts).detailText
  const textScale = showText ? textHoldScale(11, opts.zoom) : 1
  for (const disc of discoveries) {
    if (disc.opacity < MIN_VISIBLE_OPACITY) continue

    ctx.save()
    ctx.globalAlpha = disc.opacity
    if (textScale !== 1) {
      ctx.translate(disc.x, disc.y)
      ctx.scale(textScale, textScale)
      ctx.translate(-disc.x, -disc.y)
    }

    const lines = disc.content.split('\n')
    const { cardW, cardH } = getDiscoveryCardDimensions(disc.label, lines)
    const cardX = disc.x - cardW / 2
    const cardY = disc.y - cardH / 2

    const isSelected = disc.id === selectedDiscoveryId

    ctx.beginPath()
    ctx.roundRect(cardX, cardY, cardW, cardH, 3)
    ctx.fillStyle = isSelected ? SCENE.cardBgSelected : SCENE.cardBg
    ctx.fill()

    const typeColor = getDiscoveryTypeColor(disc.type, SCENE)

    // Selection glow
    if (isSelected) {
      ctx.shadowColor = typeColor
      ctx.shadowBlur = 12
      ctx.strokeStyle = typeColor + '80'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.shadowBlur = 0
    }

    // The colour bar is decorative (about 2.2:1): the type is given in text, in the tooltip and the a11y list
    ctx.fillStyle = typeColor + '60'
    ctx.fillRect(cardX, cardY, 2, cardH)

    if (!isSelected) {
      ctx.strokeStyle = typeColor + '30'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }

    if (!showText) { ctx.restore(); continue }

    ctx.fillStyle = typeColor
    ctx.font = 'bold 11px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(truncateText(ctx, opts.maskText ? maskText(disc.label) : disc.label, cardW - 10), cardX + 6, cardY + 3)

    ctx.fillStyle = SCENE.textMuted
    ctx.font = '11px monospace'
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(truncateText(ctx, opts.maskText ? maskText(lines[i]) : lines[i], cardW - 10), cardX + 6, cardY + 17 + i * 14)
    }

    ctx.restore()
  }
}
