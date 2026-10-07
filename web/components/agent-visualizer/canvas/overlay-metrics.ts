import type { Agent } from '../../../lib/agent-types'
import { CONTEXT_RING } from '../../../lib/canvas-constants'

/** Does the main agent draw its context percentage label above the ring? (pure: shared by the draw and the placement code) */
export function hasContextPercentFor(
  agent: Pick<Agent, 'isMain' | 'tokensUsed' | 'tokensMax' | 'state' | 'opacity'>,
): boolean {
  if (!agent.isMain || agent.tokensUsed <= 0 || agent.tokensMax <= 0) return false
  if (agent.state === 'complete' && agent.opacity <= 0.5) return false
  return agent.tokensUsed / agent.tokensMax > CONTEXT_RING.percentLabelThreshold
}
