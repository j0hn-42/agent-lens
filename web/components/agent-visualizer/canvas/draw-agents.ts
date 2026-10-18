import { Agent, NODE, ANIM } from '../../../lib/agent-types'
import { contextSegments } from '../../../lib/colors'
import { scenePalette, sceneColor, sceneInk, type ScenePalette } from '../../../lib/scene-state-colors'
import {
  AGENT_DRAW, CONTEXT_BAR, CONTEXT_RING, STATS_OVERLAY, ORCHESTRATOR_DRAW, MCP_DRAW, FRESHNESS_DRAW, REPEAT_BADGE_DRAW, LOD,
} from '../../../lib/canvas-constants'
import { parseMcpTool } from '../../../lib/mcp-tool'
import { deriveFreshness } from '../../../hooks/simulation/freshness'
import { alphaHex, formatModelName, modelTierColor } from '../../../lib/utils'
import { formatTokensOfWindow } from '../../../lib/context-window'
import { formatTokenUsage, usageFromAgent } from '../../../lib/usage'
import { drawHexagon, stateColor, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX, COPILOT_MARK_PATH, COPILOT_MARK_VIEWBOX, PI_MARK_PATH, PI_MARK_VIEWBOX, GEMINI_MARK_PATH, GEMINI_MARK_VIEWBOX, OPENCODE_MARK_PATH, OPENCODE_MARK_VIEWBOX } from './draw-misc'
import { maskText, maskedLabelAgent } from '../../../lib/presentation'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodOf, labelScaleForZoom, textHoldScale } from './draw-options'
import { DEFAULT_THEME, type ThemeId } from '../../../lib/theme-tokens'
import { computeOverlayLayout } from './overlay-layout'
import { hasContextPercentFor, contextPercentLabel, contextPercentColor, contextAlertLevel } from './overlay-metrics'
import { statsLabel } from './loss-labels'
import { planKey, resolvePlacement, type ResolvedPlacement } from './overlay-plan'
import { pointInView, AGENT_CULL_EXTENT } from './view-cull'
import { getAgentGlowSprite, measureTextCached } from './render-cache'
import {
  isAgentVisible, agentDrawOpacity, agentDrawScale, teammateActivity, teammateAccent, layoutAgentLabel,
  isTeammate, isOrchestrator, orchestratorInfo, ellipsize, drawnStatusText, type OrchestratorInfo,
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

/** Copilot mark: a visor (two lenses joined by a bridge), drawn as paths so it needs no asset.
 *  Same footprint as the Claude spark. Geometry is shared with the legend (COPILOT_MARK_PATH). */
export function drawCopilotMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / COPILOT_MARK_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-COPILOT_MARK_VIEWBOX / 2, -COPILOT_MARK_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getCopilotMarkPath())
  ctx.restore()
}

let _copilotMarkPath: Path2D | null = null
function getCopilotMarkPath() {
  if (!_copilotMarkPath) _copilotMarkPath = new Path2D(COPILOT_MARK_PATH)
  return _copilotMarkPath
}

/** Pi mark: the letter pi, drawn as a path so it needs no asset (#238).
 *  Same footprint as the Claude spark. Geometry is shared with the legend (PI_MARK_PATH). */
export function drawPiMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / PI_MARK_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-PI_MARK_VIEWBOX / 2, -PI_MARK_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getPiMarkPath())
  ctx.restore()
}

let _piMarkPath: Path2D | null = null
function getPiMarkPath() {
  if (!_piMarkPath) _piMarkPath = new Path2D(PI_MARK_PATH)
  return _piMarkPath
}

/** Gemini mark: a four-point star, drawn as a path so it needs no asset (#238).
 *  Same footprint as the Claude spark. Geometry is shared with the legend (GEMINI_MARK_PATH). */
function drawGeminiMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / GEMINI_MARK_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-GEMINI_MARK_VIEWBOX / 2, -GEMINI_MARK_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getGeminiMarkPath())
  ctx.restore()
}

let _geminiMarkPath: Path2D | null = null
function getGeminiMarkPath() {
  if (!_geminiMarkPath) _geminiMarkPath = new Path2D(GEMINI_MARK_PATH)
  return _geminiMarkPath
}

/** OpenCode mark: a pair of square brackets, drawn as a path so it needs no asset (#346).
 *  Same footprint as the Claude spark. Geometry is shared with the legend (OPENCODE_MARK_PATH). */
function drawOpenCodeMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / OPENCODE_MARK_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-OPENCODE_MARK_VIEWBOX / 2, -OPENCODE_MARK_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getOpenCodeMarkPath())
  ctx.restore()
}

let _openCodeMarkPath: Path2D | null = null
function getOpenCodeMarkPath() {
  if (!_openCodeMarkPath) _openCodeMarkPath = new Path2D(OPENCODE_MARK_PATH)
  return _openCodeMarkPath
}

/** Pick the brand logo for the agent's runtime. Defaults to Claude. */
export function drawAgentBrand(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, color: string,
  runtime: Agent['runtime'],
) {
  if (runtime === 'codex') drawOpenAILogo(ctx, cx, cy, r, color)
  else if (runtime === 'copilot') drawCopilotMark(ctx, cx, cy, r, color)
  else if (runtime === 'pi') drawPiMark(ctx, cx, cy, r, color)
  else if (runtime === 'gemini') drawGeminiMark(ctx, cx, cy, r, color)
  else if (runtime === 'opencode') drawOpenCodeMark(ctx, cx, cy, r, color)
  else drawClaudeSpark(ctx, cx, cy, r, color)
}

export function drawContextComposition(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  showLabel = true,
  /** Extra offset (world px) when the label above uses more than the standard two lines */
  yShift = 0,
  /** Theme of the scene (#381); absent = the neon scene */
  theme?: ThemeId,
) {
  const scene = scenePalette(theme)
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const barWidth = Math.max(CONTEXT_BAR.minWidth, radius * CONTEXT_BAR.widthMultiplier)
  const barHeight = CONTEXT_BAR.barHeight
  const barX = agent.x - barWidth / 2
  const barY = agent.y + radius + CONTEXT_BAR.yOffset + yShift

  // Background
  ctx.fillStyle = scene.cardBgDark
  ctx.beginPath()
  ctx.roundRect(barX - 2, barY - 2, barWidth + 4, barHeight + (showLabel ? CONTEXT_BAR.labelBoxExtra : 4), CONTEXT_BAR.borderRadius)
  ctx.fill()

  // Label (hidden at low zoom by the level-of-detail rule)
  if (showLabel) {
    ctx.fillStyle = sceneColor(theme, 'text', scene.textMuted)
    ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(formatTokensOfWindow(formatTokenUsage(usageFromAgent(agent)), agent), agent.x, barY + barHeight + CONTEXT_BAR.labelPadding)
  }

  // Segments
  const segments = contextSegments(bd, scene)

  let x = barX
  const maxWidth = barWidth * (total / agent.tokensMax)

  for (const seg of segments) {
    if (seg.value <= 0) continue
    const segWidth = (seg.value / total) * maxWidth
    ctx.fillStyle = sceneColor(theme, 'mark', seg.color)
    ctx.fillRect(x, barY, segWidth, barHeight)
    x += segWidth
  }

  // Remaining capacity
  if (x < barX + barWidth) {
    ctx.fillStyle = scene.holoBg05
    ctx.fillRect(x, barY, barX + barWidth - x, barHeight)
  }

  ctx.strokeStyle = sceneColor(theme, 'mark', scene.glassBorder)
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
  /** Factor that holds the percentage at LOD.minTextPx on screen (textHoldScale) */
  textScale = 1,
  /** Theme of the scene (#381); absent = the neon scene */
  theme?: ThemeId,
) {
  const scene = scenePalette(theme)
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
  ctx.strokeStyle = sceneColor(theme, 'mark', scene.holoBorder06)
  ctx.lineWidth = ringW
  ctx.stroke()

  // Filled segments
  const segments = contextSegments(bd, scene)

  let currentAngle = startAngle
  for (const seg of segments) {
    if (seg.value <= 0) continue
    const sweep = (seg.value / agent.tokensMax) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR, currentAngle, currentAngle + sweep)
    ctx.strokeStyle = sceneColor(theme, 'mark', seg.color)
    ctx.lineWidth = ringW
    ctx.stroke()
    currentAngle += sweep
  }

  // Warning glow at high usage; none on an assumed window, whose fullness cannot be proven (#364)
  const alert = contextAlertLevel(usage, agent.tokensMaxAssumed === true)
  if (alert !== 'none') {
    const critical = alert === 'critical'
    const warningColor = critical ? scene.error : scene.tool
    const intensity = reducedMotion
      ? (critical ? 0.35 : 0.15)
      : critical
      ? 0.35 + Math.sin(time * 6) * 0.2
      : 0.15 + Math.sin(time * 3) * 0.1

    ctx.save()
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR + CONTEXT_RING.glowPadding, 0, Math.PI * 2)
    const glow = sceneInk(theme, 'mark', warningColor, intensity)
    ctx.strokeStyle = glow.color
    ctx.lineWidth = CONTEXT_RING.glowLineWidth
    ctx.globalAlpha = glow.alpha
    ctx.shadowColor = warningColor
    ctx.shadowBlur = CONTEXT_RING.glowBlur
    ctx.stroke()
    ctx.restore()
  }

  // Percentage label when usage is high
  if (showPercent && usage > CONTEXT_RING.percentLabelThreshold) {
    ctx.font = `${CONTEXT_BAR.fontSize * textScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = sceneColor(theme, 'text', contextPercentColor(usage, agent.tokensMaxAssumed === true, scene))
    ctx.fillText(contextPercentLabel(agent, usage), agent.x, agent.y - radius - CONTEXT_RING.percentYOffset)
  }
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, scene: ScenePalette) {
  ctx.save()
  ctx.shadowColor = scene.depthShadow
  ctx.shadowBlur = AGENT_DRAW.shadowBlur
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY
  drawHexagon(ctx, agent.x, agent.y, r * 0.9)
  ctx.fillStyle = scene.cardBgFaintOverlay
  ctx.fill()
  ctx.restore()
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean, theme: ThemeId | undefined) {
  const scene = scenePalette(theme)
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isHovered || isSelected ? 0.35 : isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = sceneColor(theme, 'mark', color, '25')
  ctx.lineWidth = 1
  ctx.stroke()

  // Inner hex fill
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.fillStyle = scene.nodeInterior
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

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean, time: number, reducedMotion: boolean, theme: ThemeId | undefined) {
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = color
  ctx.lineWidth = (isSelected || isHovered) ? 2.5 : 2
  if (agent.state === 'complete' || agent.archived) {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = sceneColor(theme, 'mark', color, '60')
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
    const scene = scenePalette(theme)
    ctx.strokeStyle = sceneColor(theme, 'mark', scene.mcp)
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }
}

/** Model caption font size, as a fraction of the node radius */
const MODEL_CAPTION_SCALE = 0.22

/**
 * Zoom at which the model caption is drawn, or null when it is not: it follows the node radius, so it is
 * shown only from the zoom where it reaches LOD.minTextPx on screen (from the node's resting radius, so the
 * breathing never makes it blink). The model stays in the agent card and the outline (#378).
 */
function modelCaptionZoom(agent: Agent, restRadius: number, zoom: number, detailText: boolean): number | null {
  if (!detailText || !agent.model || !formatModelName(agent.model)) return null
  return restRadius * MODEL_CAPTION_SCALE * zoom >= LOD.minTextPx ? zoom : null
}

/** With a model caption drawn, the centre icon moves up a little to leave room for it underneath. */
function modelLogoDy(r: number, captionZoom: number | null): number {
  return captionZoom !== null ? -r * 0.14 : 0
}

/** Model name (tier-coloured) under the centre icon of main agents, subagents and teammates, never under LOD.minTextPx on screen. */
function drawModelCaption(ctx: CanvasRenderingContext2D, agent: Agent, r: number, captionZoom: number | null, theme: ThemeId | undefined) {
  const modelName = agent.model ? formatModelName(agent.model) : ''
  if (!modelName || captionZoom === null) return
  ctx.save()
  ctx.fillStyle = sceneColor(theme, 'text', modelTierColor(agent.model))
  ctx.font = `bold ${Math.max(r * MODEL_CAPTION_SCALE, LOD.minTextPx / captionZoom)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(modelName, agent.x, agent.y + r * 0.4, r * 1.3)
  ctx.restore()
}

function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean, captionZoom: number | null, theme: ThemeId | undefined) {
  // The state glyph is a text, the lock and the brand mark are shapes: each reaches the floor of its kind (#381)
  const glyph = sceneColor(theme, 'text', color, '90')
  const shape = sceneColor(theme, 'mark', color, '90')
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = shape
    ctx.fillStyle = shape
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
    ctx.fillStyle = glyph
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('\u25C6', agent.x, agent.y + modelLogoDy(r, captionZoom))
    drawModelCaption(ctx, agent, r, captionZoom, theme)
  } else if (agent.isMain) {
    const dy = modelLogoDy(r, captionZoom)
    drawAgentBrand(ctx, agent.x, agent.y + dy, r, shape, agent.runtime)
    drawModelCaption(ctx, agent, r, captionZoom, theme)
  } else {
    ctx.fillStyle = glyph
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(agent.state === 'tool_calling' ? '\u2699' : '\u25C7', agent.x, agent.y + modelLogoDy(r, captionZoom))
    drawModelCaption(ctx, agent, r, captionZoom, theme)
  }
}

function drawOrbitingParticles(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number, theme: ThemeId | undefined) {
  for (let i = 0; i < 4; i++) {
    const angle = time * ANIM.orbitSpeed + (i / 4) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = sceneColor(theme, 'mark', color, '80')
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      AGENT_DRAW.orbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

function drawWaitingRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number, theme: ThemeId | undefined) {
  // Radar ripples — 2 concentric rings expanding outward, staggered
  for (let i = 0; i < 2; i++) {
    const ripplePhase = ((time * 0.65 + i * 0.5) % 1.0)
    const rippleR = r + AGENT_DRAW.rippleInnerOffset + ripplePhase * AGENT_DRAW.rippleMaxExpand
    const rippleAlpha = (1 - ripplePhase) * AGENT_DRAW.rippleMaxAlpha
    ctx.beginPath()
    drawHexagon(ctx, agent.x, agent.y, rippleR)
    ctx.strokeStyle = sceneColor(theme, 'mark', color, alphaHex(rippleAlpha))
    ctx.lineWidth = 1.5 * (1 - ripplePhase)
    ctx.stroke()
  }

  // Slower orbiting particles in amber
  for (let i = 0; i < 3; i++) {
    const angle = time * AGENT_DRAW.waitingOrbitSpeed + (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = sceneColor(theme, 'mark', color, '70')
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      AGENT_DRAW.waitingOrbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

/** Label text with a dark outline so edges and neighbours passing behind it do not cut the letters. */
function fillLabelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scene: ScenePalette) {
  const fill = ctx.fillStyle
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineWidth = AGENT_DRAW.labelHaloWidth
  ctx.strokeStyle = scene.void
  ctx.strokeText(text, x, y)
  ctx.restore()
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

/**
 * Opaque plate in the scene background under a label block whose lines, centred on `x` from `top`, are
 * `widths` wide (#378). Edges and links are drawn before the nodes: one passing under the label stops at the
 * plate instead of cutting the letters. It covers no data: only what is drawn under the label.
 * - One rounded rectangle per line, fitted to that line with a margin of the text outline: no dark block as
 *   wide as the widest line cutting through the node's glow, ripples or halo.
 * - It starts 1 px above the first line, never higher: an edge leaving the node downward stays visible from
 *   the rim to the text. The lines touch, so the edge is not shown between them as a dashed stroke (dashes
 *   mean "not proven" on a link).
 * - Opaque once the label reaches AGENT_DRAW.labelPlateFullAlpha, even while the agent fades in or out: the text
 *   fades, the edges still do not show through its letters. Below that the plate fades with the label (the text
 *   is not legible yet, an edge is not cut by an opaque block). Nothing is painted when fully transparent.
 */
function fillLabelPlate(ctx: CanvasRenderingContext2D, x: number, top: number, widths: number[], scene: ScenePalette) {
  if (ctx.globalAlpha <= 0 || widths.length === 0) return
  const pad = AGENT_DRAW.labelHaloWidth
  const gap = AGENT_DRAW.stateLabelGap
  ctx.save()
  ctx.globalAlpha = Math.min(1, ctx.globalAlpha / AGENT_DRAW.labelPlateFullAlpha)
  ctx.fillStyle = scene.void
  ctx.beginPath()
  widths.forEach((w, i) => {
    // Each line overlaps the next by 1 px so the plate has no seam
    ctx.roundRect(x - w / 2 - pad, top + i * gap - 1, w + pad * 2, gap + 1, pad)
  })
  ctx.fill()
  ctx.restore()
}

/**
 * Name, status text, the orchestrator badge ('LEAD' / 'MAIN' + team or session name) and (with several
 * sessions on screen) the session label under the node. Teammates get up to two name lines; the hover
 * tooltip carries the full name. `place` comes from the overlay plan: hidden, shifted to a free spot,
 * or collapsed to one line. Returns the number of extra lines so the context bar can move down.
 */
function maskedOrchestrator(info: OrchestratorInfo | null, masked: boolean | undefined): OrchestratorInfo | null {
  return info && masked ? { ...info, groupName: maskText(info.groupName) } : info
}

function drawAgentLabel(
  ctx: CanvasRenderingContext2D, agent: Agent, r: number, isHovered: boolean, color: string, showSession: boolean,
  orch: OrchestratorInfo | null, place: ResolvedPlacement,
  /** Time the status line is read at (drawnStatusText) */
  now: number,
  /** The node is stale: its status line is its last known state, drawn in the stale grey */
  stale: boolean,
  /** Size factor that holds the text at LOD.minTextPx on screen (labelScaleForZoom) */
  scale = 1,
  /** Theme of the scene (#381); absent = the neon scene */
  theme?: ThemeId,
): { extraLines: number; dx: number; dy: number; scale: number; visible: boolean } {
  const scene = scenePalette(theme)
  const ink = (c: string) => sceneColor(theme, 'text', c)
  ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
  const measure = (t: string) => measureTextCached(ctx, t)
  const layout = layoutAgentLabel(agent, r, measure, showSession, orch)
  // The status line is drawnStatusText, the function the agent rows of the Sessions panel quote (#502): a teammate's
  // activity, or "last known state: Working" for a stale node, whose state is no longer proven (that longer line is cut to fit)
  const status = drawnStatusText(agent, now)
  layout.statusLine = stale ? ellipsize(status, FRESHNESS_DRAW.labelMaxWidth, measure) : status
  if (!place.visible) return { extraLines: layout.extraLines, dx: 0, dy: 0, scale: 1, visible: false }

  ctx.save()
  ctx.translate(place.dx, place.dy)
  scaleAbout(ctx, agent.x, agent.y + r + AGENT_DRAW.labelYOffset, scale)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const gap = AGENT_DRAW.stateLabelGap
  let y = agent.y + r + AGENT_DRAW.labelYOffset

  if (place.collapsed) {
    // Crowded: one line "name · status" (the full label is in the tooltip and the outline)
    const line = ellipsize(`${agent.name} \u00B7 ${layout.statusLine}`, r * AGENT_DRAW.labelWidthMultiplier * 1.5, measure)
    fillLabelPlate(ctx, agent.x, y, [measure(line)], scene)
    ctx.fillStyle = ink(isHovered ? scene.textPrimary : scene.textDim)
    fillLabelText(ctx, line, agent.x, y, scene)
    ctx.restore()
    return { extraLines: layout.extraLines, dx: place.dx, dy: place.dy, scale, visible: true }
  }

  // Width of the LEAD / MAIN pill line, measured before the plate that has to cover it
  let pill: { bw: number; rw: number; rest: string } | null = null
  if (layout.badgeText && layout.groupLine) {
    const rest = layout.groupLine.slice(layout.badgeText.length).trim()
    ctx.font = `bold ${ORCHESTRATOR_DRAW.badgeFontSize}px monospace`
    const bw = ctx.measureText(layout.badgeText).width + 10
    ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
    pill = { bw, rw: rest ? measure(rest) + 6 : 0, rest }
  }
  {
    // Widths in drawing order: names, status, pill line, session line
    const widths = [...layout.nameLines.map(measure), measure(layout.statusLine)]
    if (pill) widths.push(pill.bw + pill.rw)
    if (layout.sessionLine) widths.push(measure(layout.sessionLine))
    fillLabelPlate(ctx, agent.x, y, widths, scene)
  }

  ctx.fillStyle = ink(isHovered ? scene.textPrimary : scene.textDim)
  for (const line of layout.nameLines) {
    fillLabelText(ctx, line, agent.x, y, scene)
    y += gap
  }

  // Short status text for every agent: state never relies on colour alone (WCAG 1.4.1)
  ctx.fillStyle = ink(stale ? scene.staleText : color)
  fillLabelText(ctx, layout.statusLine, agent.x, y, scene)
  y += gap

  if (layout.badgeText && pill) {
    // Orchestrator: a filled 'LEAD' / 'MAIN' pill followed by its team or session name
    const { bw, rw, rest } = pill
    const x0 = agent.x - (bw + rw) / 2
    ctx.beginPath()
    ctx.roundRect(x0, y - 1, bw, gap + 1, 4)
    // Dark contour like the label text: an edge crossing the pill does not merge with it
    ctx.lineJoin = 'round'
    ctx.lineWidth = AGENT_DRAW.labelHaloWidth
    ctx.strokeStyle = scene.void
    ctx.stroke()
    ctx.fillStyle = scene.crownAccent
    ctx.fill()
    ctx.textAlign = 'left'
    ctx.font = `bold ${ORCHESTRATOR_DRAW.badgeFontSize}px monospace`
    ctx.fillStyle = scene.crownInk
    ctx.fillText(layout.badgeText, x0 + 5, y)
    if (rest) {
      ctx.font = `${AGENT_DRAW.labelFontSize}px monospace`
      ctx.fillStyle = ink(scene.textPrimary)
      ctx.fillText(rest, x0 + bw + 6, y)
    }
    ctx.textAlign = 'center'
    y += gap
  }

  if (layout.sessionLine) {
    ctx.fillStyle = ink(scene.textMuted)
    fillLabelText(ctx, layout.sessionLine, agent.x, y, scene)
  }
  ctx.restore()
  return { extraLines: layout.extraLines, dx: place.dx, dy: place.dy, scale, visible: true }
}

/** Scale the drawing by `k` around (x, y): the label block grows from its top centre, under the node. */
function scaleAbout(ctx: CanvasRenderingContext2D, x: number, y: number, k: number) {
  if (k === 1) return
  ctx.translate(x, y)
  ctx.scale(k, k)
  ctx.translate(-x, -y)
}

/**
 * Crown badge of the orchestrator on the upper-right rim of its node: a crown SHAPE (so the role does
 * not rely on colour) on a dark disc. The text badge ('LEAD' / 'MAIN') is drawn in the label.
 */
export function drawCrownBadge(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, theme?: ThemeId) {
  const scene = scenePalette(theme)
  const k = size * 0.5
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, size + 2, 0, Math.PI * 2)
  ctx.fillStyle = scene.cardBgDark
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = sceneColor(theme, 'mark', scene.crownAccent)
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
  ctx.fillStyle = sceneColor(theme, 'mark', scene.crownAccent)
  ctx.fill()
  ctx.restore()
}

/**
 * Loop / repeat badge on the upper-left rim of a node (#377), the mirror of the crown. The meaning is in the
 * SHAPE, not the colour: a circular arrow for a proven loop, a double chevron for repeated reads or calls.
 * Static: it never spins or pulses (a spinning arrow would read as "running", while a loop may be over).
 */
function drawRepeatBadge(ctx: CanvasRenderingContext2D, x: number, y: number, kind: 'loop' | 'repeated', theme: ThemeId | undefined) {
  const scene = scenePalette(theme)
  const warn = sceneColor(theme, 'mark', scene.warn)
  const size = REPEAT_BADGE_DRAW.size
  const k = size * 0.5
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, size + 2, 0, Math.PI * 2)
  ctx.fillStyle = scene.cardBgDark
  ctx.fill()
  ctx.lineWidth = REPEAT_BADGE_DRAW.ringWidth
  ctx.strokeStyle = warn
  ctx.stroke()
  ctx.strokeStyle = warn
  ctx.fillStyle = warn
  ctx.lineWidth = REPEAT_BADGE_DRAW.glyphWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (kind === 'loop') {
    // An open arc of 300° ending in an arrow head (⟳)
    const start = -Math.PI / 2 + Math.PI / 6
    const end = start + (Math.PI * 5) / 3
    ctx.beginPath()
    ctx.arc(x, y, k, start, end)
    ctx.stroke()
    const hx = x + k * Math.cos(end)
    const hy = y + k * Math.sin(end)
    const t = end + Math.PI / 2 // tangent of the arc at its end
    const h = k * 0.7
    ctx.beginPath()
    ctx.moveTo(hx + h * Math.cos(t), hy + h * Math.sin(t))
    ctx.lineTo(hx + h * 0.6 * Math.cos(t - Math.PI * 0.6), hy + h * 0.6 * Math.sin(t - Math.PI * 0.6))
    ctx.lineTo(hx + h * 0.6 * Math.cos(t + Math.PI * 0.6), hy + h * 0.6 * Math.sin(t + Math.PI * 0.6))
    ctx.closePath()
    ctx.fill()
  } else {
    // Two stacked chevrons (»): no arc, so it never reads as the loop arrow
    for (const dx of [-k * 0.45, k * 0.45]) {
      ctx.beginPath()
      ctx.moveTo(x + dx - k * 0.35, y - k * 0.6)
      ctx.lineTo(x + dx + k * 0.35, y)
      ctx.lineTo(x + dx - k * 0.35, y + k * 0.6)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * Teammate decoration: an accent ring in the (validated) team colour plus an activity badge whose
 * SHAPE carries the activity: hollow ring = idle, arc (spinning when motion is allowed) = working,
 * filled dot = done.
 */
function drawTeammateDecor(ctx: CanvasRenderingContext2D, agent: Agent, r: number, time: number, reducedMotion: boolean, theme: ThemeId | undefined) {
  // The team colour is an identity colour: kept as given, unless High contrast needs the ink to reach its floor (#381)
  const accent = sceneColor(theme, 'mark', teammateAccent(agent))
  const scene = scenePalette(theme)
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
  ctx.fillStyle = scene.cardBgDark
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

function drawStatsOverlay(ctx: CanvasRenderingContext2D, agent: Agent, r: number, statsTop: number, textScale: number, theme: ThemeId | undefined, replayLost?: ReadonlyMap<string, number>) {
  const scene = scenePalette(theme)
  const sy = agent.y - r - statsTop
  // Held at LOD.minTextPx on screen: the stack above the node (stats, cost) is enlarged as a whole around the
  // top of the node, so the box and the pill keep their order without overlapping, as the overlay plan reserves them
  scaleAbout(ctx, agent.x, agent.y - r, textScale)
  // A tool count that is a lower bound says so (#366): the box widens to hold it, the plan reserves the same width
  const { text, width: boxW } = statsLabel(agent, replayLost)
  ctx.fillStyle = scene.cardBgDark
  ctx.beginPath()
  ctx.roundRect(agent.x - boxW / 2, sy, boxW, STATS_OVERLAY.boxHeight, STATS_OVERLAY.borderRadius)
  ctx.fill()
  ctx.strokeStyle = sceneColor(theme, 'mark', scene.glassBorder)
  ctx.lineWidth = 0.5
  ctx.stroke()
  ctx.fillStyle = sceneColor(theme, 'text', scene.textMuted)
  ctx.font = `${STATS_OVERLAY.fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(text, agent.x, sy + STATS_OVERLAY.textPaddingY)
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
  // States default to the default theme; the rest of the scene to the neon scene (scenePalette)
  const theme = opts.theme ?? DEFAULT_THEME
  const sceneTheme = opts.theme
  const scene = scenePalette(sceneTheme)
  const lod = lodOf(opts)
  // Below 100% the label is held at LOD.minTextPx on screen; the overlay plan thins out the ones that collide (#378)
  const labelScale = labelScaleForZoom(opts.zoom)
  for (const [id, agent] of agents) {
    if (!isAgentVisible(agent)) continue
    if (!pointInView(opts.view, agent.x, agent.y, AGENT_CULL_EXTENT)) continue
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const stale = deriveFreshness(agent, now) === 'stale'
    const color = stale ? scene.staleMark : stateColor(agent.state, theme)
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

    drawDepthShadow(ctx, agent, r, scene)
    drawAgentGlow(ctx, agent, r, color, isHovered, isSelected, isWaiting, sceneTheme)
    if (!reducedMotion && live) drawScanline(ctx, agent, r, color, isHovered, isWaiting, time)
    drawStateRing(ctx, agent, r, color, isHovered, isSelected, isWaiting, time, reducedMotion, sceneTheme)
    drawCenterIcon(ctx, agent, r, color, isWaiting, modelCaptionZoom(agent, radius * agentDrawScale(agent), opts.zoom, lod.detailText), sceneTheme)
    if (isTeammate(agent)) drawTeammateDecor(ctx, agent, r, time, reducedMotion, sceneTheme)
    if (isOrchestrator(agent)) drawCrownBadge(ctx, agent.x + r * 0.8, agent.y - r * 0.8, ORCHESTRATOR_DRAW.badgeFontSize - 1, sceneTheme)

    if (agent.state === 'thinking' && !reducedMotion && live) {
      drawOrbitingParticles(ctx, agent, r, color, time, sceneTheme)
    }

    if (isWaiting && !reducedMotion && live) {
      drawWaitingRipples(ctx, agent, r, color, time, sceneTheme)
    }

    const priorityAgent = isSelected || isHovered || id === opts.focusedAgentId
    // The label stays fully readable on a dimmed node
    ctx.globalAlpha = baseAlpha
    const labelDrawn = lod.labels
      ? drawAgentLabel(
        ctx, opts.maskText ? maskedLabelAgent(agent) : agent, r, isHovered, color, !!opts.showSessionLabels && (!opts.crowded || priorityAgent),
        maskedOrchestrator(orchestratorInfo(agent, opts.teams), opts.maskText), resolvePlacement(opts.plan, planKey.label(id), opts.zoom),
        now, stale, labelScale, sceneTheme,
      )
      : { extraLines: 0, dx: 0, dy: 0, scale: 1, visible: false }
    ctx.globalAlpha = nodeAlpha
    const extraLines = labelDrawn.extraLines

    // Context composition — ring for main agent, bar for sub-agents (archived agents stay light)
    if (live && (agent.state !== 'complete' || agent.opacity > 0.5)) {
      if (agent.isMain) {
        drawContextRing(ctx, agent, r, time, reducedMotion, lod.detailText, textHoldScale(CONTEXT_BAR.fontSize, opts.zoom), sceneTheme)
      }
      // The bar hangs under the label: it follows the label when the placement shifted or enlarged it
      ctx.save()
      ctx.translate(labelDrawn.dx, labelDrawn.dy)
      scaleAbout(ctx, agent.x, agent.y + r + AGENT_DRAW.labelYOffset, labelDrawn.scale)
      // A label hidden by the plan (a tool card covers it, #378) takes its token line with it
      drawContextComposition(ctx, agent, r, lod.details && labelDrawn.visible, extraLines * AGENT_DRAW.stateLabelGap, sceneTheme)
      ctx.restore()
    }

    // Loop / repeat badge (#377): after the context ring so the ring never covers it; a shape, drawn at every zoom
    const repeatMark = opts.repeatMarks?.get(id)
    if (repeatMark) drawRepeatBadge(ctx, agent.x - r * REPEAT_BADGE_DRAW.offset, agent.y - r * REPEAT_BADGE_DRAW.offset, repeatMark.kind, sceneTheme)

    // From the detail zoom, held at LOD.minTextPx: a Stats button that is on shows the box where the auto-fit lands (#378)
    if (lod.details && showStats && agent.state !== 'complete') {
      // Stacked layout shared with the cost pill: stats, cost and the % label never overlap
      const layout = computeOverlayLayout({ hasPercent: hasContextPercent(agent), showStats: true, showCost: opts.showCost })
      const place = resolvePlacement(opts.plan, planKey.stats(id), opts.zoom)
      if (layout.statsTop != null && place.visible) {
        ctx.save()
        ctx.translate(place.dx, place.dy)
        drawStatsOverlay(ctx, agent, r, layout.statsTop, textHoldScale(STATS_OVERLAY.fontSize, opts.zoom), sceneTheme, opts.replayLost)
        ctx.restore()
      }
    }

    ctx.restore()
  }
}
