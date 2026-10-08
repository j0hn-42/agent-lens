import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { type DrawOpts, DEFAULT_DRAW_OPTS } from './draw-options'
import { isAgentVisible, agentDrawOpacity } from './team-style'
import { badgeRect, badgeSizeText, branchBadge, BADGE, type CollapseView } from './branch-collapse'

/**
 * Badge on every collapsed branch (#55): "+N" hidden agents, or a green dot with the count of
 * active ones. The same text is exposed in the DOM mirror, so colour is never the only cue.
 */
export function drawBranchBadges(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  view: CollapseView,
  focusedId: string | null = null,
  _opts: DrawOpts = DEFAULT_DRAW_OPTS,
) {
  for (const [id, info] of view.branches) {
    if (!info.collapsed) continue
    const agent = agents.get(id)
    if (!agent || !isAgentVisible(agent)) continue
    const badge = branchBadge(info)
    const r = badgeRect(agent, badgeSizeText(badge))
    const active = badge.kind === 'active'
    const accent = active ? COLORS.complete : COLORS.holoBase

    ctx.save()
    ctx.globalAlpha = agentDrawOpacity(agent)
    ctx.beginPath()
    ctx.roundRect(r.x, r.y, r.w, r.h, r.h / 2)
    ctx.fillStyle = COLORS.panelBg
    ctx.fill()
    ctx.lineWidth = id === focusedId ? 2 : 1
    ctx.strokeStyle = accent
    ctx.stroke()
    if (active) {
      ctx.beginPath()
      ctx.arc(r.x + r.h / 2, r.y + r.h / 2, 3, 0, Math.PI * 2)
      ctx.fillStyle = accent
      ctx.fill()
    }
    ctx.fillStyle = COLORS.textPrimary
    ctx.font = `${BADGE.font}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(badge.text, r.x + r.w / 2 + (active ? 4 : 0), r.y + r.h / 2 + 0.5)
    ctx.restore()
  }
}
