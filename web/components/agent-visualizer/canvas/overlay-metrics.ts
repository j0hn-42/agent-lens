import type { Agent } from '../../../lib/agent-types'
import { CONTEXT_RING } from '../../../lib/canvas-constants'
import { SCENE } from '../../../lib/colors'
import { qualify, usageFromAgent } from '../../../lib/usage'

/** Does the main agent draw its context percentage label above the ring? (pure: shared by the draw and the placement code) */
export function hasContextPercentFor(
  agent: Pick<Agent, 'isMain' | 'tokensUsed' | 'tokensMax' | 'state' | 'opacity'>,
): boolean {
  if (!agent.isMain || agent.tokensUsed <= 0 || agent.tokensMax <= 0) return false
  if (agent.state === 'complete' && agent.opacity <= 0.5) return false
  return agent.tokensUsed / agent.tokensMax > CONTEXT_RING.percentLabelThreshold
}

/** "95%", or "95% assumed" when the window it divides by is a fallback (#364). */
export function contextPercentLabel(agent: Pick<Agent, 'tokensUsed' | 'tokenStatus' | 'tokensEstimated' | 'tokensMaxAssumed'>, usage: number): string {
  const pct = qualify(usageFromAgent(agent), `${Math.floor(usage * 100)}%`)
  return agent.tokensMaxAssumed ? `${pct} assumed` : pct
}

/** Warning and critical colours claim a window is nearly full: never on an assumed window (#364). */
export function contextPercentColor(usage: number, assumed: boolean): string {
  if (assumed) return SCENE.textDim
  return usage > CONTEXT_RING.criticalThreshold ? SCENE.error : usage > CONTEXT_RING.warningThreshold ? SCENE.tool : SCENE.textDim
}
