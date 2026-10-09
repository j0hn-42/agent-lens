import { ToolCallNode } from '@/lib/agent-types'
import { SCENE, withAlpha } from '@/lib/colors'
import { TOOL_MAX_CARD_W, TOOL_DRAW, MCP_DRAW, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { truncateText } from './draw-misc'
import { measureTextCached, setToolCardSize } from './render-cache'
import { toolCardExpanded } from '@/lib/tool-lifecycle'
import { END_NOT_OBSERVED } from '@/lib/ui-glossary'
import { USAGE_LABELS } from '@/lib/usage'
import { boxInView } from './view-cull'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'

/** Glow and error halo around a card (world units) */
const TOOL_CULL_SLACK = 24

export function drawToolCalls(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  time: number,
  selectedToolCallId?: string | null,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  const { reducedMotion } = opts
  const showText = lodForZoom(opts.zoom).details
  for (const [id, tool] of toolCalls) {
    if (tool.opacity < MIN_VISIBLE_OPACITY) continue
    if (!boxInView(opts.view, tool.x - TOOL_MAX_CARD_W / 2 - TOOL_CULL_SLACK, tool.y - TOOL_DRAW.expandedHeight / 2 - TOOL_CULL_SLACK, tool.x + TOOL_MAX_CARD_W / 2 + TOOL_CULL_SLACK, tool.y + TOOL_DRAW.expandedHeight / 2 + TOOL_CULL_SLACK)) continue
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    // Cancelled / expired: neither success nor failure, drawn dashed and muted so they never pass for either
    const isUnresolved = tool.state === 'cancelled' || tool.state === 'expired'
    const pulse = reducedMotion
      ? (isRunning || isError ? 0.9 : 0.5)
      : isRunning ? Math.sin(time * 4) * 0.2 + 0.8 : isError ? Math.sin(time * 6) * 0.15 + 0.85 : 0.5

    ctx.save()
    ctx.globalAlpha = tool.opacity

    ctx.font = `${TOOL_DRAW.fontSize}px monospace`
    const mcp = tool.mcp
    const displayName = mcp ? mcp.tool : tool.toolName
    const accent = mcp ? SCENE.mcp : SCENE.tool
    const toolLabel = `${displayName}: ${tool.args}`
    const label = truncateText(ctx, toolLabel, TOOL_MAX_CARD_W - 12)
    const textWidth = Math.min(measureTextCached(ctx, label) + 12, TOOL_MAX_CARD_W)
    const cardW = Math.max(60, textWidth)
    const cardH = toolCardExpanded(tool) ? TOOL_DRAW.expandedHeight : TOOL_DRAW.collapsedHeight
    const cardX = tool.x - cardW / 2
    const cardY = tool.y - cardH / 2
    // Hit-testing reuses the exact drawn size
    setToolCardSize(id, cardW, cardH)

    const isSelected = id === selectedToolCallId

    // Error glow
    if (isError) {
      ctx.shadowColor = SCENE.error
      ctx.shadowBlur = TOOL_DRAW.errorGlowBase + (reducedMotion ? 0 : Math.sin(time * 6) * TOOL_DRAW.errorGlowPulse)
    }

    ctx.beginPath()
    ctx.roundRect(cardX, cardY, cardW, cardH, TOOL_DRAW.borderRadius)
    ctx.fillStyle = isError
      ? withAlpha(SCENE.toolCardErrorBase, 0.8 * pulse)
      : isSelected ? withAlpha(SCENE.toolCardSelectedBase, 0.15 * pulse) : withAlpha(SCENE.toolCardBase, 0.7 * pulse)
    ctx.fill()
    ctx.strokeStyle = isError
      ? SCENE.error + '90'
      : isSelected ? SCENE.holoBase + 'aa' : isRunning ? accent + '90' : mcp ? SCENE.mcp + '60' : SCENE.return + '40'
    ctx.lineWidth = isError ? 2 : isSelected ? 1.5 : mcp ? 1.5 : 1
    if (isUnresolved) ctx.setLineDash([4, 3])
    ctx.stroke()
    ctx.setLineDash([])

    ctx.shadowBlur = 0

    if (isRunning && !reducedMotion) {
      const ringR = Math.max(cardW, cardH) / 2 + (mcp ? MCP_DRAW.orbitPadding : TOOL_DRAW.spinRingPadding)
      if (mcp) {
        // MCP: dots orbiting the card, like a signal going out to an external server
        for (let i = 0; i < MCP_DRAW.orbitDots; i++) {
          const a = time * MCP_DRAW.orbitSpeed + (i / MCP_DRAW.orbitDots) * Math.PI * 2
          ctx.beginPath()
          ctx.arc(tool.x + Math.cos(a) * ringR, tool.y + Math.sin(a) * ringR * 0.6, MCP_DRAW.orbitDotSize, 0, Math.PI * 2)
          ctx.fillStyle = SCENE.mcp
          ctx.fill()
        }
      } else {
        // Spinning ring
        ctx.beginPath()
        ctx.arc(tool.x, tool.y, ringR, time * TOOL_DRAW.spinSpeed, time * TOOL_DRAW.spinSpeed + TOOL_DRAW.spinArc)
        ctx.strokeStyle = SCENE.tool + '50'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // MCP server badge above the card (text only when zoomed in; shape remains otherwise)
    if (mcp) {
      ctx.font = `${MCP_DRAW.badgeFontSize}px monospace`
      const badgeText = showText ? truncateText(ctx, `MCP · ${mcp.server}`, cardW + 20) : ''
      const badgeW = showText ? measureTextCached(ctx, badgeText) + MCP_DRAW.badgePadX * 2 : 14
      const badgeX = tool.x - badgeW / 2
      const badgeY = cardY - MCP_DRAW.badgeHeight - MCP_DRAW.badgeGap
      ctx.beginPath()
      ctx.roundRect(badgeX, badgeY, badgeW, MCP_DRAW.badgeHeight, MCP_DRAW.badgeHeight / 2)
      ctx.fillStyle = withAlpha(SCENE.toolCardBase, 0.9)
      ctx.fill()
      ctx.strokeStyle = SCENE.mcp + 'cc'
      ctx.lineWidth = 1
      ctx.stroke()
      if (showText) {
        ctx.fillStyle = SCENE.mcp
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(badgeText, tool.x, badgeY + MCP_DRAW.badgeHeight / 2 + 0.5)
      }
    }

    // Crack lines for errors
    if (isError) {
      ctx.save()
      ctx.strokeStyle = SCENE.error + '40'
      ctx.lineWidth = 0.8
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5
        ctx.beginPath()
        ctx.moveTo(tool.x, tool.y)
        ctx.lineTo(tool.x + Math.cos(a) * cardW * 0.5, tool.y + Math.sin(a) * cardH * 0.6)
        ctx.stroke()
      }
      ctx.restore()
    }

    if (!showText) { ctx.restore(); continue }

    // The MCP badge left a smaller font on the context: measure with the font the card text is drawn in
    ctx.font = `${TOOL_DRAW.fontSize}px monospace`
    const truncatedLabel = truncateText(ctx, toolLabel, cardW - 8)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    if (isRunning) {
      ctx.fillStyle = accent
      ctx.fillText(truncatedLabel, tool.x, tool.y)
    } else if (isError) {
      ctx.fillStyle = SCENE.error
      ctx.fillText(truncateText(ctx, `${displayName}: FAILED`, cardW - 8), tool.x, tool.y - TOOL_DRAW.twoLineOffset)
      ctx.font = `${TOOL_DRAW.errorFontSize}px monospace`
      ctx.fillStyle = SCENE.error + 'aa'
      ctx.fillText(truncateText(ctx, tool.errorMessage || tool.result || '', cardW - 8), tool.x, tool.y + TOOL_DRAW.twoLineOffset + 2)
    } else if (isUnresolved) {
      ctx.fillStyle = SCENE.textMuted
      const verdict = tool.state === 'expired' ? 'expired' : 'cancelled'
      ctx.fillText(truncateText(ctx, `${tool.toolName}: ${verdict}`, cardW - 8), tool.x, tool.y - TOOL_DRAW.twoLineOffset)
      ctx.font = `${TOOL_DRAW.errorFontSize}px monospace`
      ctx.fillText(truncateText(ctx, tool.state === 'expired' ? END_NOT_OBSERVED : 'interrupted', cardW - 8), tool.x, tool.y + TOOL_DRAW.twoLineOffset + 2)
    } else {
      // Completed card: show action + file path (most useful info at a glance)
      ctx.fillStyle = mcp ? SCENE.mcp : SCENE.return
      ctx.fillText(truncatedLabel, tool.x, tool.y - TOOL_DRAW.twoLineOffset)
      if (tool.tokenCost) {
        // Token cost as dim text below; an estimate is tagged, never shown as an exact figure
        ctx.fillStyle = SCENE.tool + '90'
        ctx.font = `${TOOL_DRAW.tokenFontSize}px monospace`
        const tag = tool.tokenSource === 'estimated' ? ` ${USAGE_LABELS.estimated}` : ''
        ctx.fillText(`${tool.tokenCost} tok${tag}`, tool.x, tool.y + TOOL_DRAW.twoLineOffset + 2)
      }
    }

    ctx.restore()
  }
}
