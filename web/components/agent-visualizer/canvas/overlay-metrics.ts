import type { Agent } from '../../../lib/agent-types'
import { CONTEXT_RING } from '../../../lib/canvas-constants'
import { SCENE } from '../../../lib/colors'
import type { ScenePalette } from '../../../lib/scene-state-colors'
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

export type ContextAlertLevel = 'none' | 'warning' | 'critical'

/** Warning and critical claim a window is nearly full: never on an assumed window, whose size is not known (#364).
 *  Shared by the ring glow and the percentage colour so the two cannot disagree. */
export function contextAlertLevel(usage: number, assumed: boolean): ContextAlertLevel {
  if (assumed) return 'none'
  return usage > CONTEXT_RING.criticalThreshold ? 'critical' : usage > CONTEXT_RING.warningThreshold ? 'warning' : 'none'
}

/** Colour of the percentage label in a scene palette (the theme's, #381); the neon scene by default. */
export function contextPercentColor(usage: number, assumed: boolean, palette: ScenePalette = SCENE): string {
  const level = contextAlertLevel(usage, assumed)
  return level === 'critical' ? palette.error : level === 'warning' ? palette.tool : palette.textDim
}
