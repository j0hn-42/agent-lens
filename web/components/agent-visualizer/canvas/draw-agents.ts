import { Agent, NODE, ANIM } from '@/lib/agent-types'
import { COLORS, contextSegments } from '@/lib/colors'
import {
  AGENT_DRAW, CONTEXT_BAR, CONTEXT_RING, STATS_OVERLAY, ORCHESTRATOR_DRAW, MCP_DRAW, FRESHNESS_DRAW,
} from '@/lib/canvas-constants'
import { parseMcpTool } from '@/lib/mcp-tool'
import { deriveFreshness, lastKnownStateText } from '@/hooks/simulation/freshness'
import { alphaHex, formatTokens, formatDuration, pluralize } from '@/lib/utils'
import { formatTokenUsage, usageFromAgent, qualify } from '@/lib/usage'
import { drawHexagon, stateColor, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX } from './draw-misc'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'
import { computeOverlayLayout } from './overlay-layout'
import { hasContextPercentFor } from './overlay-metrics'
import { planKey, resolvePlacement, type ResolvedPlacement } from './overlay-plan'
import { getAgentGlowSprite, measureTextCached } from './render-cache'
import {
  isAgentVisible, agentDrawOpacity, agentDrawScale, teammateActivity, teammateAccent, layoutAgentLabel,
  isTeammate, isOrchestrator, orchestratorInfo, ellipsize, type OrchestratorInfo,
} from './team-style'

let _claudeSparkPath: Path2D | null = null
export function getClaudeSparkPath() {
  if (!_claudeSparkPath) _claudeSparkPath = new Path2D(CLAUDE_SPARK_D)
  return _claudeSparkPath
}

let _openaiLogoPath: Path2D | null = null
function getOpenAILogoPath() {
  if (!_openaiLogoPath) _openaiLogoPath = new Path2D(OPENAI_LOGO_D)
  return _openaiLogoPath
}

export function drawClaudeSpark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / AGENT_DRAW.sparkViewBox
  ctx.scale(scale, scale)
  ctx.translate(-AGENT_DRAW.sparkViewBox, -AGENT_DRAW.sparkViewBox + 1)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getClaudeSparkPath())
  ctx.restore()
}

export function drawOpenAILogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  // Target diameter matches the Claude spark: (r * sparkScale) total.
  const scale = (r * AGENT_DRAW.sparkScale) / OPENAI_LOGO_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-OPENAI_LOGO_VIEWBOX / 2, -OPENAI_LOGO_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getOpenAILogoPath())
  ctx.restore()
}

/** Pick the brand logo for the agent's runtime. Defaults to Claude. */
export function drawAgentBrand(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, color: string,
  runtime: Agent['runtime'],
) {
  if (runtime === 'codex') drawOpenAILogo(ctx, cx, cy, r, color)
  else drawClaudeSpark(ctx, cx, cy, r, color)
}

export function drawContextComposition(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  showLabel = true,
  /** Extra offset (world px) when the label above uses more than the standard two lines */
  yShift = 0,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const barWidth = Math.max(CONTEXT_BAR.minWidth, radius * CONTEXT_BAR.widthMultiplier)
  const barHeight = CONTEXT_BAR.barHeight
  const barX = agent.x - barWidth / 2
  const barY = agent.y + radius + CONTEXT_BAR.yOffset + yShift

  // Background
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(barX - 2, barY - 2, barWidth + 4, barHeight + (showLabel ? CONTEXT_BAR.labelBoxExtra : 4), CONTEXT_BAR.borderRadius)
  ctx.fill()

  // Label (hidden at low zoom by the level-of-detail rule)
  if (showLabel) {
    ctx.fillStyle = COLORS.textMuted
    ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`${formatTokenUsage(usageFromAgent(agent))} / ${formatTokens(agent.tokensMax)} tokens`, agent.x, barY + barHeight + CONTEXT_BAR.labelPadding)
  }

  // Segments
  const segments = contextSegments(bd)

  let x = barX
  const maxWidth = barWidth * (total / agent.tokensMax)

  for (const seg of segments) {
    if (seg.value <= 0) continue
    const segWidth = (seg.value / total) * maxWidth
    ctx.fillStyle = seg.color
    ctx.fillRect(x, barY, segWidth, barHeight)
    x += segWidth
  }

  // Remaining capacity
  if (x < barX + barWidth) {
    ctx.fillStyle = COLORS.holoBg05
    ctx.fillRect(x, barY, barX + barWidth - x, barHeight)
  }

  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.strokeRect(barX, barY, barWidth, barHeight)
}

export function drawContextRing(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  time: number,
  reducedMotion = false,
  showPercent = true,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const usage = total / agent.tokensMax
  const ringR = radius + CONTEXT_RING.ringOffset
  const ringW = CONTEXT_RING.ringWidth
  const startAngle = -Math.PI / 2

  // Background ring (empty capacity)
  ctx.beginPath()
  ctx.arc(agent.x, agent.y, ringR, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.holoBorder06
  ctx.lineWidth = ringW
  ctx.stroke()

  // Filled segments
  const segments = contextSegments(bd)

  let currentAngle = startAngle
  for (const seg of segments) {
    if (seg.value <= 0) continue
    const sweep = (seg.value / agent.tokensMax) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR, currentAngle, currentAngle + sweep)
    ctx.strokeStyle = seg.color
    ctx.lineWidth = ringW
    ctx.stroke()
    currentAngle += sweep
  }

  // Warning glow at high usage
  if (usage > CONTEXT_RING.warningThreshold) {
    const warningColor = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : COLORS.tool
    const intensity = reducedMotion
      ? (usage > CONTEXT_RING.criticalThreshold ? 0.35 : 0.15)
      : usage > CONTEXT_RING.criticalThreshold
      ? 0.35 + Math.sin(time * 6) * 0.2
      : 0.15 + Math.sin(time * 3) * 0.1

    ctx.save()
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR + CONTEXT_RING.glowPadding, 0, Math.PI * 2)
    ctx.strokeStyle = warningColor
    ctx.lineWidth = CONTEXT_RING.glowLineWidth
    ctx.globalAlpha = intensity
    ctx.shadowColor = warningColor
    ctx.shadowBlur = CONTEXT_RING.glowBlur
    ctx.stroke()
    ctx.restore()
  }

  // Percentage label when usage is high
  if (showPercent && usage > CONTEXT_RING.percentLabelThreshold) {
    ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : usage > CONTEXT_RING.warningThreshold ? COLORS.tool : COLORS.textDim
    ctx.fillText(qualify(usageFromAgent(agent), `${Math.floor(usage * 100)}%`), agent.x, agent.y - radius - CONTEXT_RING.percentYOffset)
  }
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = AGENT_DRAW.shadowBlur
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY
  drawHexagon(ctx, agent.x, agent.y, r * 0.9)
  ctx.fillStyle = COLORS.cardBgFaintOverlay
  ctx.fill()
  ctx.restore()
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isHovered || isSelected ? 0.35 : isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '25'
  ctx.lineWidth = 1
  ctx.stroke()

  // Inner hex fill
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
}

function drawScanline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isWaiting: boolean, time: number) {
  const scanSpeed = agent.state === 'thinking' || isHovered || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = agent.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.clip()
  const scanGrad = ctx.createLinearGradient(agent.x, scanY - AGENT_DRAW.scanlineHalfH, agent.x, scanY + AGENT_DRAW.scanlineHalfH)
  const scanAlpha = isHovered ? '35' : '20'
  scanGrad.addColorStop(0, color + '00')
  scanGrad.addColorStop(0.5, color + scanAlpha)
  scanGrad.addColorStop(1, color + '00')
  ctx.fillStyle = scanGrad
  ctx.fillRect(agent.x - r, scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineWidth)
  ctx.restore()
}

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean, time: number, reducedMotion: boolean) {
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = color
  ctx.lineWidth = (isSelected || isHovered) ? 2.5 : 2
  if (agent.state === 'complete' || agent.archived) {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = color + '60'
  } else if (isWaiting) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = reducedMotion ? 0 : -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0

  // Calling an MCP tool: dashed cyan rim around the agent (static dashes under reduced motion)
  if (agent.state === 'tool_calling' && parseMcpTool(agent.currentTool)) {
    ctx.save()
    drawHexagon(ctx, agent.x, agent.y, r + MCP_DRAW.agentRimPadding)
    ctx.setLineDash([...MCP_DRAW.agentRimDash])
    ctx.lineDashOffset = reducedMotion ? 0 : -time * MCP_DRAW.agentRimSpeed
    ctx.strokeStyle = COLORS.mcp
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }
}

function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean) {
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = color + '90'
    ctx.fillStyle = color + '90'
    ctx.lineWidth = 1.5
    // Lock body (rounded rect)
    ctx.beginPath()
    ctx.roundRect(agent.x - s * 0.6, agent.y - s * 0.1, s * 1.2, s * 1.0, 2)
    ctx.fill()
    // Lock shackle (arc)
    ctx.beginPath()
    ctx.arc(agent.x, agent.y - s * 0.15, s * 0.4, Math.PI, 0)
    ctx.stroke()
    ctx.restore()
  } else if (isTeammate(agent) && !agent.isMain) {
    ctx.fillStyle = color + '90'
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('\u25C6', agent.x, agent.y)
  } else if (agent.isMain) {
    drawAgentBrand(ctx, agent.x, agent.y, r, color + '90', agent.runtime)
  } else {
    ctx.fillStyle = color + '90'
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(agent.state === 'tool_calling' ? '\u2699' : '\u25C7', agent.x, agent.y)
  }
}

function drawOrbitingParticles(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  for (let i = 0; i < 4; i++) {
    const angle = time * ANIM.orbitSpeed + (i / 4) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '80'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      AGENT_DRAW.orbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

function drawWaitingRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  // Radar ripples — 2 concentric rings expanding outward, staggered
  for (let i = 0; i < 2; i++) {
    const ripplePhase = ((time * 0.65 + i * 0.5) % 1.0)
    const rippleR = r + AGENT_DRAW.rippleInnerOffset + ripplePhase * AGENT_DRAW.rippleMaxExpand
    const rippleAlpha = (1 - ripplePhase) * AGENT_DRAW.rippleMaxAlpha
    ctx.beginPath()
    drawHexagon(ctx, agent.x, agent.y, rippleR)
    ctx.strokeStyle = color + alphaHex(rippleAlpha)
    ctx.lineWidth = 1.5 * (1 - ripplePhase)
    ctx.stroke()
  }

  // Slower orbiting particles in amber
  for (let i = 0; i < 3; i++) {
    const angle = time * AGENT_DRAW.waitingOrbitSpeed + (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '70'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      AGENT_DRAW.waitingOrbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

/**
 * Name, status text, the orchestrator badge ('LEAD' / 'MAIN' + team or session name) and (with several
 * sessions on screen) the session label under the node. Teammates get up to two name lines; the hover
 * tooltip carries the full name. `place` comes from the overlay plan: hidden, shifted to a free spot,
 * or collapsed to one line. Returns the number of extra lines so the context bar can move down.
 */
function drawAgentLabel(
  ctx: CanvasRenderingContext2D, agent: Agent, r: number, isHovered: boolean, color: string, showSession: boolean,
  orch: OrchestratorInfo | null, place: ResolvedPlacement, staleText?: string,
): { extraLines: number; dx: number; dy: number } {
  ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
  const measure = (t: string) => measureTextCached(ctx, t)
  const layout = layoutAgentLabel(agent, r, measure, showSession, orch)
  // A stale node says so in words ("last known state: Working"): the state is no longer proven
  if (staleText) layout.statusLine = ellipsize(staleText, FRESHNESS_DRAW.labelMaxWidth, measure)
  if (!place.visible) return { extraLines: layout.extraLines, dx: 0, dy: 0 }

  ctx.save()
  ctx.translate(place.dx, place.dy)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const gap = AGENT_DRAW.stateLabelGap
  let y = agent.y + r + AGENT_DRAW.labelYOffset

  if (place.collapsed) {
    // Crowded: one line "name · status" (the full label is in the tooltip and the outline)
    ctx.fillStyle = isHovered ? COLORS.textPrimary : COLORS.textDim
    ctx.fillText(ellipsize(`${agent.name} \u00B7 ${layout.statusLine}`, r * AGENT_DRAW.labelWidthMultiplier * 1.5, measure), agent.x, y)
    ctx.restore()
    return { extraLines: layout.extraLines, dx: place.dx, dy: place.dy }
  }

  ctx.fillStyle = isHovered ? COLORS.textPrimary : COLORS.textDim
  for (const line of layout.nameLines) {
    ctx.fillText(line, agent.x, y)
    y += gap
  }

  // Short status text for every agent: state never relies on colour alone (WCAG 1.4.1)
  ctx.fillStyle = staleText ? COLORS.textMuted : color
  ctx.fillText(layout.statusLine, agent.x, y)
  y += gap

  if (layout.badgeText && layout.groupLine) {
    // Orchestrator: a filled 'LEAD' / 'MAIN' pill followed by its team or session name
    const rest = layout.groupLine.slice(layout.badgeText.length).trim()
    ctx.font = `bold ${ORCHESTRATOR_DRAW.badgeFontSize}px monospace`
    const bw = ctx.measureText(layout.badgeText).width + 10
    ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
    const rw = rest ? measure(rest) + 6 : 0
    const x0 = agent.x - (bw + rw) / 2
    ctx.beginPath()
    ctx.roundRect(x0, y - 1, bw, gap + 1, 4)
    ctx.fillStyle = ORCHESTRATOR_DRAW.accent
    ctx.fill()
    ctx.textAlign = 'left'
    ctx.font = `bold ${ORCHESTRATOR_DRAW.badgeFontSize}px monospace`
    ctx.fillStyle = '#11161c'
    ctx.fillText(layout.badgeText, x0 + 5, y)
    if (rest) {
      ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
      ctx.fillStyle = COLORS.textPrimary
      ctx.fillText(rest, x0 + bw + 6, y)
    }
    ctx.textAlign = 'center'
    y += gap
  }

  if (layout.sessionLine) {
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(layout.sessionLine, agent.x, y)
  }
  ctx.restore()
  return { extraLines: layout.extraLines, dx: place.dx, dy: place.dy }
}

/**
 * Crown badge of the orchestrator on the upper-right rim of its node: a crown SHAPE (so the role does
 * not rely on colour) on a dark disc. The text badge ('LEAD' / 'MAIN') is drawn in the label.
 */
export function drawCrownBadge(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const k = size * 0.5
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, size + 2, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.cardBgDark
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = ORCHESTRATOR_DRAW.accent
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - k, y + k * 0.6)
  ctx.lineTo(x - k, y - k * 0.5)
  ctx.lineTo(x - k * 0.5, y + k * 0.05)
  ctx.lineTo(x, y - k * 0.75)
  ctx.lineTo(x + k * 0.5, y + k * 0.05)
  ctx.lineTo(x + k, y - k * 0.5)
  ctx.lineTo(x + k, y + k * 0.6)
  ctx.closePath()
  ctx.fillStyle = ORCHESTRATOR_DRAW.accent
  ctx.fill()
  ctx.restore()
}

/**
 * Teammate decoration: an accent ring in the (validated) team colour plus an activity badge whose
 * SHAPE carries the activity: hollow ring = idle, arc (spinning when motion is allowed) = working,
 * filled dot = done.
 */
function drawTeammateDecor(ctx: CanvasRenderingContext2D, agent: Agent, r: number, time: number, reducedMotion: boolean) {
  const accent = teammateAccent(agent)
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset + 3)
  ctx.strokeStyle = accent
  ctx.lineWidth = 2.5
  ctx.setLineDash(agent.archived ? [3, 4] : [])
  ctx.stroke()
  ctx.setLineDash([])

  const activity = teammateActivity(agent)
  const bx = agent.x + r * 0.8
  const by = agent.y - r * 0.8
  const br = 6
  ctx.beginPath()
  ctx.arc(bx, by, br + 2, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.cardBgDark
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = accent
  if (activity === 'idle') {
    ctx.beginPath()
    ctx.arc(bx, by, br, 0, Math.PI * 2)
    ctx.stroke()
  } else if (activity === 'working') {
    const start = reducedMotion ? -Math.PI / 2 : time * 4
    ctx.beginPath()
    ctx.arc(bx, by, br, start, start + (reducedMotion ? Math.PI * 1.5 : Math.PI * 1.2))
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(bx, by, br - 1, 0, Math.PI * 2)
    ctx.fillStyle = accent
    ctx.fill()
  }
}

/** Does the main agent draw its context percentage label above the ring? */
export function hasContextPercent(agent: Agent): boolean {
  return hasContextPercentFor(agent)
}

function drawStatsOverlay(ctx: CanvasRenderingContext2D, agent: Agent, r: number, statsTop: number) {
  const sy = agent.y - r - statsTop
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(agent.x - STATS_OVERLAY.boxWidth / 2, sy, STATS_OVERLAY.boxWidth, STATS_OVERLAY.boxHeight, STATS_OVERLAY.borderRadius)
  ctx.fill()
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.stroke()
  ctx.fillStyle = COLORS.textMuted
  ctx.font = `${STATS_OVERLAY.fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${pluralize(agent.toolCalls, 'tool')} \u00B7 ${formatDuration(agent.timeAlive)}`, agent.x, sy + STATS_OVERLAY.textPaddingY)
}

export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  selectedAgentId: string | null,
  hoveredAgentId: string | null,
  showStats: boolean,
  time: number,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
  /** Wall clock (ms) used to age the states; injectable for tests */
  now: number = Date.now(),
) {
  const { reducedMotion } = opts
  const lod = lodForZoom(opts.zoom)
  for (const [id, agent] of agents) {
    if (!isAgentVisible(agent)) continue
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const stale = deriveFreshness(agent, now) === 'stale'
    const color = stale ? FRESHNESS_DRAW.staleColor : stateColor(agent.state)
    const isHovered = id === hoveredAgentId
    const isSelected = id === selectedAgentId

    const isWaiting = agent.state === 'waiting_permission'

    const breathe = reducedMotion || agent.archived ? 1 : isWaiting
      ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
      : agent.state === 'thinking'
      ? Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
      : agent.state === 'idle' ? Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1 : 1

    const r = radius * breathe * agentDrawScale(agent)
    const live = !agent.archived

    ctx.save()
    const baseAlpha = agentDrawOpacity(agent)
    const nodeAlpha = stale ? baseAlpha * FRESHNESS_DRAW.staleAlpha : baseAlpha
    ctx.globalAlpha = nodeAlpha

    drawDepthShadow(ctx, agent, r)
    drawAgentGlow(ctx, agent, r, color, isHovered, isSelected, isWaiting)
    if (!reducedMotion && live) drawScanline(ctx, agent, r, color, isHovered, isWaiting, time)
    drawStateRing(ctx, agent, r, color, isHovered, isSelected, isWaiting, time, reducedMotion)
    drawCenterIcon(ctx, agent, r, color, isWaiting)
    if (isTeammate(agent)) drawTeammateDecor(ctx, agent, r, time, reducedMotion)
    if (isOrchestrator(agent)) drawCrownBadge(ctx, agent.x + r * 0.8, agent.y - r * 0.8, ORCHESTRATOR_DRAW.badgeFontSize - 1)

    if (agent.state === 'thinking' && !reducedMotion && live) {
      drawOrbitingParticles(ctx, agent, r, color, time)
    }

    if (isWaiting && !reducedMotion && live) {
      drawWaitingRipples(ctx, agent, r, color, time)
    }

    const priorityAgent = isSelected || isHovered || id === opts.focusedAgentId
    // The label stays fully readable on a dimmed node
    ctx.globalAlpha = baseAlpha
    const labelDrawn = lod.labels
      ? drawAgentLabel(
        ctx, agent, r, isHovered, color, !!opts.showSessionLabels && (!opts.crowded || priorityAgent),
        orchestratorInfo(agent, opts.teams), resolvePlacement(opts.plan, planKey.label(id), opts.zoom),
        stale ? lastKnownStateText(agent.state) : undefined,
      )
      : { extraLines: 0, dx: 0, dy: 0 }
    ctx.globalAlpha = nodeAlpha
    const extraLines = labelDrawn.extraLines

    // Context composition — ring for main agent, bar for sub-agents (archived agents stay light)
    if (live && (agent.state !== 'complete' || agent.opacity > 0.5)) {
      if (agent.isMain) {
        drawContextRing(ctx, agent, r, time, reducedMotion, lod.details)
      }
      // The bar hangs under the label: it follows the label when the placement shifted it
      ctx.save()
      ctx.translate(labelDrawn.dx, labelDrawn.dy)
      drawContextComposition(ctx, agent, r, lod.details, extraLines * AGENT_DRAW.stateLabelGap)
      ctx.restore()
    }

    if (lod.details && showStats && agent.state !== 'complete') {
      // Stacked layout shared with the cost pill: stats, cost and the % label never overlap
      const layout = computeOverlayLayout({ hasPercent: hasContextPercent(agent), showStats: true, showCost: opts.showCost })
      const place = resolvePlacement(opts.plan, planKey.stats(id), opts.zoom)
      if (layout.statsTop != null && place.visible) {
        ctx.save()
        ctx.translate(place.dx, place.dy)
        drawStatsOverlay(ctx, agent, r, layout.statsTop)
        ctx.restore()
      }
    }

    ctx.restore()
  }
}
