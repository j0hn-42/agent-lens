import type { Agent, TimelineEntry } from '../../lib/agent-types'
import type { SimulationState } from './types'
import { createEmptyState, agentKeyOf } from './types'
import { eventSessionId } from './process-event'

/**
 * "Clear history": keep the active agents, drop completed ones and the visual history. The clock restarts at 0
 * (fresh state); the kept spawns stay in the log so a later seek can rebuild them.
 */
export function clearHistoryState(prev: SimulationState): SimulationState {
  const agents = new Map<string, Agent>()
  // spawnTime is kept: the log keeps the spawns at their real time and the next event brings the clock back to
  // the session time, so the age stays measured from the real birth (0 until then)
  for (const [id, agent] of prev.agents) {
    if (agent.state !== 'complete') {
      agents.set(id, { ...agent, toolCalls: 0, toolErrors: 0, messageBubbles: [] })
    }
  }

  const edges = prev.edges.filter(e =>
    e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to)
  )

  const timelineEntries = new Map<string, TimelineEntry>()
  for (const [id, entry] of prev.timelineEntries) {
    if (agents.has(id)) {
      timelineEntries.set(id, { ...entry, blocks: [] })
    }
  }

  const conversations: SimulationState['conversations'] = new Map()
  for (const id of agents.keys()) conversations.set(id, [])

  const keptLocalIds = new Set(Array.from(agents.values()).map(a => a.id))
  const eventLog = prev.eventLog.filter(e =>
    e.type === 'agent_spawn' && typeof e.payload?.name === 'string'
    && keptLocalIds.has(agentKeyOf(eventSessionId(e), e.payload.name))
  )

  return {
    ...createEmptyState({ isPlaying: true, speed: prev.speed }),
    agents, edges, timelineEntries, conversations,
    eventLog, eventIndex: eventLog.length,
  }
}
