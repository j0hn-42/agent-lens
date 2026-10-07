import type { MutableEventState, ProcessEventContext } from './process-event'
import { agentKeyOf, DEFAULT_SESSION_ID } from './types'
import { idString } from './agent-keys'
import { MAX_TEAMS, parseActivity, sanitizeTeamInfo } from './team-info'
import { handleAgentComplete } from './handle-agent-events'

/** team_info: store (sanitised) the team summary. Existing teams are replaced, new ones are capped. */
export function handleTeamInfo(payload: Record<string, unknown>, state: MutableEventState): void {
  const info = sanitizeTeamInfo(payload)
  if (!info) return
  if (!state.teams.has(info.name) && state.teams.size >= MAX_TEAMS) return
  state.teams.set(info.name, info)
}

/** agent_activity: record what a teammate is doing. Idle teammates stay on screen; 'done' archives. */
export function handleAgentActivity(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const activity = parseActivity(payload.activity)
  if (!activity) return
  const key = agentKeyOf(sessionId, idString(payload.name))
  const agent = state.agents.get(key)
  if (!agent) return
  if (activity === 'done') {
    handleAgentComplete({ name: agent.localId }, currentTime, state, ctx, sessionId)
    const done = state.agents.get(key)
    if (done && done.activity !== 'done') state.agents.set(key, { ...done, activity: 'done' })
    return
  }
  if (agent.activity === activity) return
  state.agents.set(key, { ...agent, activity })
}
