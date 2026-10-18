/**
 * Texts drawn on the canvas that a replay loss qualifies (#366), shared by the drawing and the overlay plan so the
 * box the planner reserves is the box that is drawn. Pure (no canvas, no React).
 */
import { STATS_OVERLAY } from '../../../lib/canvas-constants'
import { agentCostUsage } from '../../../lib/cost'
import { boundedCount, replayLostForAgents, usageUnderLoss } from '../../../lib/event-loss'
import type { UsageTotal } from '../../../lib/usage'
import { formatDuration } from '../../../lib/utils'
import { estimateTextWidth } from './edge-bubbles'

type Lossy = { sessionId?: string }

/** Events the relay could not replay for the session of this agent (its own count, never the whole tally). */
export function agentReplayLost(lost: ReadonlyMap<string, number> | undefined, agent: Lossy): number {
  return replayLostForAgents(lost, [agent])
}

/** Cost of an agent as its pill and the Cost panel row read it: a lower bound when its session lost events. */
export function agentCostUsageUnderLoss(agent: Lossy & Parameters<typeof agentCostUsage>[0], lost: ReadonlyMap<string, number> | undefined): UsageTotal {
  return usageUnderLoss(agentCostUsage(agent), agentReplayLost(lost, agent))
}

/** Side padding of the stats text inside its box */
const STATS_PAD_X = 8

function widthFor(text: string): number {
  return Math.ceil(estimateTextWidth(text, STATS_OVERLAY.fontSize)) + STATS_PAD_X * 2
}

/**
 * The stats line of an agent and the width of its box: "13 tools · 1:02", "at least 13 tools · 1:02" or "no tool observed
 * (incomplete) · 1:02" (the words of the agent card). Nothing lost: the usual text in the usual box, as before. Lost: the
 * box widens to hold the qualified text, up to the maximum; the qualifier comes first and is never cut, a line that would
 * still be wider loses its duration instead.
 */
export function statsLabel(agent: Lossy & { toolCalls: number; timeAlive: number }, lost: ReadonlyMap<string, number> | undefined): { text: string; width: number } {
  const n = agentReplayLost(lost, agent)
  const tools = boundedCount(agent.toolCalls, n, 'tool')
  const full = `${tools} \u00B7 ${formatDuration(agent.timeAlive)}`
  if (!(n > 0)) return { text: full, width: STATS_OVERLAY.boxWidth }
  const text = widthFor(full) <= STATS_OVERLAY.maxBoxWidth ? full : tools
  return { text, width: Math.min(STATS_OVERLAY.maxBoxWidth, Math.max(STATS_OVERLAY.boxWidth, widthFor(text))) }
}
