import type { AgentEvent } from './protocol'
import { ORCHESTRATOR_NAME } from './constants'

/** Convert orchestrator agent_complete to agent_idle unless it's a session end.
 *  Prevents premature "completed" state during long API calls. The idle is flagged `turnEnd`:
 *  the orchestrator finished its turn and is now paused (active time stops, #107). */
export function filterOrchestratorCompletion(event: AgentEvent): AgentEvent | null {
  if (event.type !== 'agent_complete') return event
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (!isOrchestrator) return event
  if (event.payload?.sessionEnd) return event
  return { ...event, type: 'agent_idle', payload: { ...event.payload, turnEnd: true } }
}
