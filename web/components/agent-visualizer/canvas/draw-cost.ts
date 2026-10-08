import { Agent, ToolCallNode } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { COST_DRAW, COST_PANEL } from '@/lib/canvas-constants'
import { formatTokens, formatCost } from '@/lib/utils'
import { agentCost, modelCostRate, agentCostUsage } from '@/lib/cost'
import { formatCostUsage, formatTokenUsage, type UsageTotal } from '@/lib/usage'
import { summarizeCosts, sessionUsage, type UnattributedUsage } from '@/lib/attribution'
import { truncateText } from './draw-misc'
import { type DrawOpts, DEFAULT_DRAW_OPTS, lodForZoom } from './draw-options'
import { computeOverlayLayout } from './overlay-layout'
import { hasContextPercent } from './draw-agents'
import { isAgentVisible, agentDrawOpacity, agentDrawRadius } from './team-style'
import { planKey, resolvePlacement } from './overlay-plan'

export { modelCostRate, agentCost }

/** Label of the remainder row: usage tied to no single agent */
export const UNATTRIBUTED_LABEL = 'Unattributed'

/** Tool name -> color for mini cost bar */
export function toolTypeColor(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return COLORS.contextUser
  if (n.includes('edit') || n.includes('write')) return COLORS.contextReasoning
  if (n.includes('bash')) return COLORS.tool
  return COLORS.contextSubagent
}

/** Pre-group tool calls by agentId to avoid O(agents * toolCalls) per frame */
function groupToolsByAgent(toolCalls: Map<string, ToolCallNode>): Map<string, ToolCallNode[]> {
  const grouped = new Map<string, ToolCallNode[]>()
  for (const tc of toolCalls.values()) {
    if (!tc.tokenCost) continue
    let list = grouped.get(tc.agentId)
    if (!list) { list = []; grouped.set(tc.agentId, list) }
    list.push(tc)
  }
  return grouped
}

export function drawCostLabels(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  // Cost pills are secondary text: hidden below the level-of-detail zoom threshold
  if (!lodForZoom(opts.zoom).details) return
  const toolsByAgent = groupToolsByAgent(toolCalls)

  for (const [, agent] of agents) {
    if (!isAgentVisible(agent)) continue
    const costUsage = agentCostUsage(agent)
    if (costUsage.value === null || costUsage.value < COST_DRAW.minDisplayCost) continue

    const r = agentDrawRadius(agent)
    // Stacked above the stats box and the context % label (see overlay-layout.ts)
    const layout = computeOverlayLayout({
      hasPercent: hasContextPercent(agent),
      showStats: opts.showStats && agent.state !== 'complete',
      showCost: true,
    })
    const pillY = agent.y - r - (layout.costTop ?? COST_DRAW.pillYOffset)
    // Screen-space placement: hidden or shifted when it would collide with another text
    const place = resolvePlacement(opts.plan, planKey.cost(agent.id), opts.zoom)
    if (!place.visible) continue

    // Floating cost pill
    const label = formatCostUsage(costUsage)
    ctx.font = 'bold 11px monospace'
    const labelW = ctx.measureText(label).width
    const pillW = labelW + COST_DRAW.pillPadding
    const pillH = COST_DRAW.pillHeight
    const pillX = agent.x - pillW / 2

    ctx.save()
    ctx.translate(place.dx, place.dy)
    ctx.globalAlpha = agentDrawOpacity(agent) * 0.9

    // Pill background
    ctx.fillStyle = COLORS.costPillBg
    ctx.strokeStyle = COLORS.costPillStroke
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, COST_DRAW.pillRadius)
    ctx.fill()
    ctx.stroke()

    // Cost text
    ctx.fillStyle = COLORS.costText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, agent.x, pillY + pillH / 2)

    // Mini tool-type cost bar below the pill
    const agentTools = toolsByAgent.get(agent.id)
    if (agentTools && agentTools.length > 0) {
      // Group by tool type
      const byType = new Map<string, number>()
      let totalToolTokens = 0
      for (const tc of agentTools) {
        const tokens = tc.tokenCost || 0
        const key = tc.toolName
        byType.set(key, (byType.get(key) || 0) + tokens)
        totalToolTokens += tokens
      }
      if (totalToolTokens > 0) {
        const barW = Math.min(pillW + COST_DRAW.miniBarMaxExtra, COST_DRAW.miniBarMax)
        const barH = COST_DRAW.miniBarHeight
        const barX = agent.x - barW / 2
        const barY = pillY + pillH + COST_DRAW.miniBarGap

        // Bar background
        ctx.fillStyle = COLORS.holoBorder06
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, COST_DRAW.miniBarRadius)
        ctx.fill()

        // Segments
        let segX = barX
        for (const [toolName, tokens] of byType) {
          const segW = (tokens / totalToolTokens) * barW
          if (segW < 1) continue
          ctx.fillStyle = toolTypeColor(toolName)
          ctx.globalAlpha = agentDrawOpacity(agent) * 0.7
          ctx.beginPath()
          ctx.roundRect(segX, barY, segW, barH, COST_DRAW.miniBarRadius)
          ctx.fill()
          segX += segW
        }
      }
    }

    ctx.restore()
  }
}

/** Top of the panel: under the top bar, whose published height (--topbar-h) grows when its controls wrap. */
export function costPanelTop(topbarH: string | null | undefined): number {
  const px = parseFloat(topbarH ?? '')
  return Number.isFinite(px) && px > COST_PANEL.yStart ? Math.round(px) : COST_PANEL.yStart
}

function readTopbarH(): string {
  try { return typeof document === 'undefined' ? '' : document.documentElement.style.getPropertyValue('--topbar-h') } catch { return '' }
}

export function drawCostSummaryPanel(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  unattributed: Iterable<UnattributedUsage> = [],
) {
  const agentList = Array.from(agents.values()).filter(a => a.tokensUsed > 0)
  // Usage that belongs to no single agent is shown apart, never folded into one (#61)
  const summary = summarizeCosts(agentList, unattributed)
  const hasRest = summary.unattributedTokens > 0
  if (agentList.length === 0 && !hasRest) return

  // Per-agent breakdown sorted by cost desc
  const agentBreakdown = agentList
    .map(a => ({ name: a.name, tokens: a.tokensUsed, cost: agentCost(a.tokensUsed, a.model), usage: agentCostUsage(a) }))
    .sort((a, b) => b.cost - a.cost)
  const totalCost = summary.sessionCost
  // Header qualifies the totals: agents with no data make them a lower bound, estimates are flagged;
  // the unattributed remainder counts in the session total
  const { cost: costUsage, tokens: tokenUsage } = sessionUsage(agents.values(), unattributed)

  // Per-tool-type breakdown, costed at the owning agent's model rate
  // A figure is an estimate as soon as one call of the tool is, and a lower bound when a call has no figure
  const toolBreakdown = new Map<string, { tokens: number; cost: number; estimated: boolean; missing: boolean }>()
  for (const [, tc] of toolCalls) {
    const entry = toolBreakdown.get(tc.toolName) || { tokens: 0, cost: 0, estimated: false, missing: false }
    if (tc.tokenCost) {
      entry.tokens += tc.tokenCost
      entry.cost += agentCost(tc.tokenCost, agents.get(tc.agentId)?.model)
      if (tc.tokenSource !== 'reported') entry.estimated = true
    } else if (tc.tokenCost === null && tc.state !== 'running') {
      entry.missing = true
    }
    toolBreakdown.set(tc.toolName, entry)
  }
  const toolList = Array.from(toolBreakdown.entries())
    .filter(([, e]) => e.tokens > 0)
    .map(([name, e]): { name: string; tokens: number; cost: number; usage: UsageTotal } =>
      ({ name, tokens: e.tokens, cost: e.cost, usage: { value: e.cost, status: e.missing ? 'partial' : 'available', estimated: e.estimated } }))
    .sort((a, b) => b.cost - a.cost)

  // Panel dimensions — positioned top-right
  const dpr = ctx.canvas.width / ctx.canvas.offsetWidth
  const canvasW = ctx.canvas.width / dpr
  const panelW = COST_PANEL.width
  const panelX = canvasW - panelW - COST_PANEL.xMargin
  const panelY = costPanelTop(readTopbarH())
  const lineH = COST_PANEL.lineHeight
  const headerH = COST_PANEL.headerHeight
  const sectionGap = COST_PANEL.sectionGap
  const agentRows = Math.min(agentBreakdown.length, COST_PANEL.maxRows)
  const toolRows = Math.min(toolList.length, COST_PANEL.maxRows)
  const restRows = hasRest ? 1 : 0
  const panelH = headerH + ((agentRows + restRows) * lineH) + sectionGap + (toolRows > 0 ? 14 + toolRows * lineH : 0) + 12

  ctx.save()

  // Panel background
  ctx.fillStyle = COLORS.panelBg
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(panelX, panelY, panelW, panelH, COST_PANEL.borderRadius)
  ctx.fill()
  ctx.stroke()

  let y = panelY + 8

  // Header: total cost
  ctx.font = 'bold 12px monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.costText
  const headerCost = formatCostUsage(costUsage)
  ctx.fillText(headerCost, panelX + COST_PANEL.contentPadding, y)

  ctx.font = '11px monospace'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(`${formatTokenUsage(tokenUsage)} tokens`, panelX + COST_PANEL.contentPadding + ctx.measureText(headerCost).width + 14, y + 2)

  y += headerH

  // Per-agent breakdown
  const barW = panelW - COST_PANEL.contentPadding * 2
  for (let i = 0; i < agentRows; i++) {
    const a = agentBreakdown[i]

    // Mini bar background
    const ratio = totalCost > 0 ? a.cost / totalCost : 0
    ctx.fillStyle = COLORS.holoBorder06
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Bar fill
    ctx.fillStyle = a.name.includes('main') || agentBreakdown.length === 1
      ? COLORS.barFillMain
      : COLORS.barFillSub
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Agent name
    ctx.font = '11px monospace'
    ctx.fillStyle = COLORS.textPrimary
    ctx.textAlign = 'left'
    const costLabel = formatCostUsage(a.usage)
    const costW = ctx.measureText(costLabel).width
    ctx.fillText(truncateText(ctx, a.name, barW - costW - 16), panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, y + 3)

    // Cost, qualified like the header ("au moins", "estimé")
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.costText
    ctx.fillText(costLabel, panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, y + 3)

    y += lineH
  }

  // Unattributed remainder: orphan or ambiguous usage, priced at the default rate (the model is unknown)
  if (hasRest) {
    ctx.strokeStyle = COLORS.textMuted
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = '11px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText(UNATTRIBUTED_LABEL, panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, y + 3)
    ctx.textAlign = 'right'
    ctx.fillText(`${formatTokens(summary.unattributedTokens)} \u00b7 ${formatCost(summary.unattributedCost)}`, panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, y + 3)
    y += lineH
  }

  // Per-tool-type breakdown
  if (toolList.length > 0) {
    y += sectionGap

    ctx.font = '11px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText('BY TOOL', panelX + COST_PANEL.contentPadding, y)
    y += 14

    for (let i = 0; i < toolRows; i++) {
      const t = toolList[i]
      const ratio = totalCost > 0 ? t.cost / totalCost : 0

      // Background
      ctx.fillStyle = COLORS.panelSeparator
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()

      // Fill
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.globalAlpha = 0.2
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()
      ctx.globalAlpha = 1

      // Tool name
      ctx.font = '11px monospace'
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.textAlign = 'left'
      const toolCostLabel = formatCostUsage(t.usage)
      const toolCostW = ctx.measureText(toolCostLabel).width
      ctx.fillText(truncateText(ctx, t.name, barW - toolCostW - 16), panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, y + 3)

      // Cost (a Claude tool cost is always an estimate: say so)
      ctx.textAlign = 'right'
      ctx.fillStyle = COLORS.costTextDim
      ctx.fillText(toolCostLabel, panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, y + 3)

      y += lineH
    }
  }

  ctx.restore()
}
