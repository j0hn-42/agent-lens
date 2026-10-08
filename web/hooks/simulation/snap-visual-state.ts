import type { SimulationState } from './types'
import { ARCHIVED_OPACITY } from './archive'
import { closeExpiredTimelineBlocks } from './animate'
import { settleToolCall } from '../../lib/tool-lifecycle'
import { TOOL_MIN_DISPLAY_S, TOOL_EXPIRY_S, DISCOVERY_HOLD_S, BUBBLE_VISIBLE_S, MIN_VISIBLE_OPACITY } from '../../lib/canvas-constants'

/** Snap visual properties to their analytically correct values at a given time (used during seek) */
export function snapVisualState(state: SimulationState, targetTime: number, toolExpiryS: number = TOOL_EXPIRY_S): SimulationState {

  const newAgents = new Map(state.agents)
  for (const [id, agent] of newAgents) {
    if (agent.state === 'complete' && !agent.isMain && !agent.archived) {
      // Remove completed (non-archived) sub-agents entirely during seek
      newAgents.delete(id)
      continue
    }
    const snapped = { ...agent }
    if (agent.state !== 'complete') {
      snapped.opacity = 1
      snapped.scale = 1
      snapped.timeAlive = targetTime - agent.spawnTime
    } else {
      // Main agent or archived agent that completed
      snapped.opacity = ARCHIVED_OPACITY
      snapped.scale = 1
    }
    snapped.messageBubbles = agent.messageBubbles.filter(b => targetTime - b.time <= BUBBLE_VISIBLE_S)
    newAgents.set(id, snapped)
  }

  const newToolCalls = new Map(state.toolCalls)
  for (const [id, current] of newToolCalls) {
    const tc = settleToolCall(current, targetTime, toolExpiryS, newAgents)
    const snapped = { ...tc }
    if (tc.state === 'running') {
      snapped.opacity = 1
    } else {
      const timeSinceComplete = targetTime - (tc.completeTime ?? 0)
      snapped.opacity = timeSinceComplete < TOOL_MIN_DISPLAY_S ? 1 : 0
    }
    newToolCalls.set(id, snapped)
  }

  const timelineEntries = closeExpiredTimelineBlocks(state.timelineEntries, state.toolCalls, newToolCalls)

  // Filter edges: only keep edges where both endpoints are visible
  const newEdges = state.edges
    .map(e => {
      const fromAgent = newAgents.get(e.from)
      const toAgent = newAgents.get(e.to)
      const toTool = newToolCalls.get(e.to)
      const fromVisible = fromAgent && fromAgent.opacity > MIN_VISIBLE_OPACITY
      const toVisible = (toAgent && toAgent.opacity > MIN_VISIBLE_OPACITY) || (toTool && toTool.opacity > MIN_VISIBLE_OPACITY)
      return { ...e, opacity: (fromVisible && toVisible) ? 1 : 0 }
    })
    .filter(e => e.opacity > 0)

  const newDiscoveries = state.discoveries.map(d => {
    const age = targetTime - d.timestamp
    return { ...d, x: d.targetX, y: d.targetY, opacity: age < DISCOVERY_HOLD_S ? 0.9 : 0 }
  }).filter(d => d.opacity > 0)

  return {
    ...state,
    agents: newAgents, toolCalls: newToolCalls, timelineEntries,
    edges: newEdges, particles: [], discoveries: newDiscoveries,
  }
}
