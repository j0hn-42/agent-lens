import { Agent } from '@/lib/agent-types'
import { COLORS, withAlpha } from '@/lib/colors'
import { BUBBLE_MAX_W, BUBBLE_GAP, BUBBLE_MAX_LINES, AGENT_DRAW, BUBBLE_DRAW, isExpiryHeld } from '@/lib/canvas-constants'
import { isAgentVisible, agentDrawOpacity, agentDrawRadius } from './team-style'
import { planKey, resolvePlacement } from './overlay-plan'
import { overlayHits } from './overlay-state'
import { bubbleAlpha } from './bubble-utils'
import { measureTextCached } from './render-cache'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'

/** World-space bubbles attached to agents (used when zoomed in) */
export function drawMessageBubblesWorld(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  time: number,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  const showText = lodForZoom(opts.zoom).details
  for (const agent of agents.values()) {
    if (agent.messageBubbles.length === 0 || !isAgentVisible(agent)) continue
    // Hovered / focused agents, paused playback and "never hide" keep their bubbles visible
    const held = isExpiryHeld('agent', agent.id)

    const radius = agentDrawRadius(agent)
    // Crowded: the stack collapses to a small count chip (or is hidden when even that does not fit)
    const place = resolvePlacement(opts.plan, planKey.bubbles(agent.id), opts.zoom)
    if (!place.visible) continue
    if (place.collapsed) {
      drawBubbleChip(ctx, agent, time, held, opts.zoom)
      continue
    }
    const anchorX = agent.x + radius + AGENT_DRAW.bubbleAnchorOffset
    let cursorY = agent.y + AGENT_DRAW.bubbleCursorY

    let firstVisible = true

    for (const bubble of agent.messageBubbles) {
      const age = time - bubble.time
      const alpha = bubbleAlpha(age, agentDrawOpacity(agent), held)
      if (alpha < 0.01) continue

      const { role, text } = bubble

      const isThinking = role === 'thinking'
      const bgColor = isThinking ? COLORS.bubbleThinkingBase : role === 'user' ? COLORS.bubbleUserBase : COLORS.bubbleAssistantBase
      const textColor = isThinking ? COLORS.roleThinkingText : role === 'user' ? COLORS.roleUserText : COLORS.roleAssistantText
      const assistantLabel = agent.runtime === 'codex' ? 'CODEX' : 'CLAUDE'
      const label = isThinking ? 'THINKING' : role === 'user' ? 'USER' : assistantLabel

      // Thinking bubbles: smaller font, tighter spacing, more translucent
      const style = isThinking ? BUBBLE_DRAW.thinking : BUBBLE_DRAW.normal

      const font = `${style.fontSize}px monospace`
      ctx.font = font
      // Cache wrapped lines on the bubble to avoid re-wrapping every frame
      let allLines: string[]
      if (bubble._cachedWrappedLines && bubble._cachedWrappedFont === font) {
        allLines = bubble._cachedWrappedLines
      } else {
        allLines = wrapText(ctx, text, BUBBLE_MAX_W - 16)
        bubble._cachedWrappedLines = allLines
        bubble._cachedWrappedFont = font
      }
      const truncated = allLines.length > BUBBLE_MAX_LINES
      const lines = truncated ? allLines.slice(0, BUBBLE_MAX_LINES) : allLines

      const bubbleW = Math.min(BUBBLE_MAX_W, Math.max(...lines.map(l => measureTextCached(ctx, l))) + style.padding * 2 + 4)
      const bubbleH = style.headerH + lines.length * style.lineH + style.padding + (truncated ? style.lineH * 0.8 : 0)

      // Cache dimensions so hit-detection can use exact same values
      bubble._cachedW = bubbleW
      bubble._cachedH = bubbleH
      bubble._cachedLines = lines.length

      ctx.save()
      ctx.globalAlpha = isThinking ? alpha * 0.85 : alpha

      if (firstVisible) {
        const triY = cursorY + bubbleH / 2
        ctx.beginPath()
        ctx.moveTo(anchorX, triY - BUBBLE_DRAW.triOffset)
        ctx.lineTo(anchorX - BUBBLE_DRAW.triWidth, triY)
        ctx.lineTo(anchorX, triY + BUBBLE_DRAW.triOffset)
        ctx.fillStyle = withAlpha(bgColor, 0.12)
        ctx.fill()
        firstVisible = false
      }

      ctx.beginPath()
      ctx.roundRect(anchorX, cursorY, bubbleW, bubbleH, BUBBLE_DRAW.borderRadius)
      ctx.fillStyle = withAlpha(bgColor, isThinking ? 0.08 : 0.12)
      ctx.fill()
      ctx.strokeStyle = withAlpha(bgColor, isThinking ? 0.15 : 0.25)
      ctx.lineWidth = 0.5
      ctx.stroke()

      if (showText) {
        ctx.font = `${style.labelSize}px monospace`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = textColor + (isThinking ? 'c0' : 'd0')
        ctx.fillText(label, anchorX + style.padding, cursorY + 3)

        // Upright text: italics are harder to read at small sizes
        ctx.font = `${style.fontSize}px monospace`
        ctx.fillStyle = textColor + (isThinking ? 'e0' : '')
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], anchorX + style.padding, cursorY + style.headerH + i * style.lineH)
        }
        if (truncated) {
          ctx.fillStyle = textColor + 'c0'
          ctx.fillText('...', anchorX + style.padding, cursorY + style.headerH + lines.length * style.lineH)
        }
      }

      ctx.restore()

      cursorY += bubbleH + BUBBLE_GAP
    }
  }
}

/** Small count chip that stands for the bubbles of an agent when they would overlap other texts. */
function drawBubbleChip(ctx: CanvasRenderingContext2D, agent: Agent, time: number, held: boolean, zoom: number) {
  const rect = overlayHits.collapsedBubbles.get(agent.id)
  if (!rect) return
  let n = 0
  for (const b of agent.messageBubbles) if (bubbleAlpha(time - b.time, agentDrawOpacity(agent), held) >= 0.01) n++
  if (n === 0) return
  const scale = zoom > 0 ? zoom : 1
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h / 2)
  ctx.fillStyle = COLORS.cardBgDark
  ctx.fill()
  ctx.strokeStyle = COLORS.bubbleAssistantBase
  ctx.lineWidth = 1 / scale
  ctx.stroke()
  ctx.font = `${11 / scale}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLORS.textPrimary
  ctx.fillText(`\u2026${n}`, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5 / scale)
  ctx.restore()
}

/** Word-wrap text into lines that fit within maxW pixels, preserving newlines.
 *  Force-breaks long unbroken tokens (paths, URLs) that exceed maxW. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []
  // Split on explicit newlines first to preserve line breaks
  const paragraphs = text.split('\n')
  for (const para of paragraphs) {
    if (para.trim() === '') {
      lines.push('') // preserve blank lines
      continue
    }
    // Word-wrap within each paragraph, preserving leading whitespace
    const leadingMatch = para.match(/^(\s*)/)
    const leading = leadingMatch ? leadingMatch[1] : ''
    const words = para.trimStart().split(/\s+/)
    let currentLine = leading
    for (const word of words) {
      const test = currentLine.trimStart() ? `${currentLine} ${word}` : `${currentLine}${word}`
      if (measureTextCached(ctx, test) > maxW && currentLine.trimStart()) {
        lines.push(currentLine)
        currentLine = leading + word
      } else {
        currentLine = test
      }
      // Force-break if a single token still exceeds maxW
      while (measureTextCached(ctx, currentLine) > maxW && currentLine.length > 1) {
        let breakAt = currentLine.length - 1
        while (breakAt > 1 && measureTextCached(ctx, currentLine.slice(0, breakAt)) > maxW) { breakAt-- }
        lines.push(currentLine.slice(0, breakAt))
        currentLine = leading + currentLine.slice(breakAt)
      }
    }
    if (currentLine) lines.push(currentLine)
  }
  return lines.length > 0 ? lines : ['']
}
