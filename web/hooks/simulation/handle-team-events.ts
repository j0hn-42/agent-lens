import type { MutableEventState, ProcessEventContext } from './process-event'
import { agentKeyOf, DEFAULT_SESSION_ID } from './types'
import { idString } from './agent-keys'
import { MAX_TEAMS, parseActivity, sanitizeTeamInfo } from './team-info'
import { handleAgentComplete } from './handle-agent-events'
import { restampClusterKeys, restampPhases } from './fleet-layout'
import { teamKeyFor } from './team-key'

/** team_info: store (sanitised) the team summary. The team of the same name and lead is replaced, new ones are capped. */
export function handleTeamInfo(payload: Record<string, unknown>, state: MutableEventState, ctx?: ProcessEventContext): void {
  const info = sanitizeTeamInfo(payload)
  if (!info) return
  // Keyed per (lead session, name): same-named teams under different leads coexist
  const key = teamKeyFor(state.teams, info.name, info.leadSessionId)
  if (!state.teams.has(key) && state.teams.size >= MAX_TEAMS) return
  state.teams.set(key, info)
  // Sessions may now belong to a team: regroup their agents into its cluster
  restampClusterKeys(state.agents, state.teams)
  // The workflow may now announce the phase of its members
  // The layout pulls each member to the centre of its phase: a phase received after the spawn must move them
  if (restampPhases(state.agents, state.teams) && ctx && !ctx.skipForceSync) {
    setTimeout(() => ctx.syncForceSimulation(state.agents, state.edges), 0)
  }
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
