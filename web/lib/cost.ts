import { COST_RATE, MODEL_FAMILY_COST } from './canvas-constants'
import { combineUsage, usageFromAgent, withValue, type UsageStatus, type UsageTotal } from './usage'

/** Blended $/M-token rate for a model ID — first matching family wins,
 *  unknown models fall back to the Sonnet-class rate. */
export function modelCostRate(model?: string): number {
  if (model) {
    const id = model.toLowerCase()
    for (const { pattern, rate } of MODEL_FAMILY_COST) {
      if (pattern.test(id)) return rate
    }
  }
  return COST_RATE
}

export function agentCost(tokensUsed: number, model?: string): number {
  return (tokensUsed / 1_000_000) * modelCostRate(model)
}

/** Cost of one agent as a qualified total: unavailable (not $0) when its tokens are unknown, a lower bound when partial. */
export function agentCostUsage(a: { tokensUsed: number; model?: string; tokenStatus?: UsageStatus; tokensEstimated?: boolean }): UsageTotal {
  const tokens = usageFromAgent(a)
  return withValue(tokens, tokens.value === null ? null : agentCost(tokens.value, a.model))
}

/** Fleet cost, each agent priced with its own model; agents without data make the total partial. */
export function totalCostUsage(agents: Iterable<{ tokensUsed: number; model?: string; tokenStatus?: UsageStatus; tokensEstimated?: boolean }>): UsageTotal {
  return combineUsage(Array.from(agents, agentCostUsage))
}
