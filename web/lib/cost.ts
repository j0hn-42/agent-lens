import { COST_RATE, MODEL_FAMILY_COST } from './canvas-constants'

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

/** Total cost across agents, each priced with its own model. */
export function totalAgentCost(agents: Iterable<{ tokensUsed: number; model?: string }>): number {
  let sum = 0
  for (const a of agents) sum += agentCost(a.tokensUsed, a.model)
  return sum
}
