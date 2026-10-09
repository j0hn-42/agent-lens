/**
 * Team identity (#36): the teams map is keyed by a key that is unique per (lead session, name), so
 * two teams with the same name under different lead sessions never overwrite each other. The first
 * team of a name keeps the plain name as key (tabs and selections address teams by name); a second
 * team of that name gets `name@leadSessionId`. The display name is always `TeamSummary.name`.
 * Pure: no React, no DOM.
 */
import type { Agent, TeamSummary } from '../../lib/agent-types'

/** Key under which a team (name, lead session) lives in the map: its existing key, or a new unique one. */
export function teamKeyFor(teams: ReadonlyMap<string, TeamSummary>, name: string, leadSessionId: string): string {
  for (const [key, t] of teams) if (t.name === name && t.leadSessionId === leadSessionId) return key
  let key = teams.has(name) ? `${name}@${leadSessionId}` : name
  while (teams.has(key)) key += '~'
  return key
}

/** Whether a session takes part in the team (its lead session or the session of one of its members). */
export function sessionInTeam(t: TeamSummary, sessionId: string): boolean {
  return t.leadSessionId === sessionId || t.members.some(m => m.sessionId === sessionId)
}

/**
 * Team of an agent that carries a team name: the team of that name the agent's session takes part
 * in. Undefined when no team of that name includes the session.
 */
export function findTeam(
  teams: ReadonlyMap<string, TeamSummary> | undefined,
  name: string,
  sessionId: string,
): TeamSummary | undefined {
  if (!teams) return undefined
  const direct = teams.get(name)
  if (direct && direct.name === name && sessionInTeam(direct, sessionId)) return direct
  for (const t of teams.values()) if (t.name === name && sessionInTeam(t, sessionId)) return t
  return undefined
}

/** Team an agent belongs to: by its team name, else the team its session leads or takes part in. */
export function teamOfAgent(
  teams: ReadonlyMap<string, TeamSummary> | undefined,
  agent: Pick<Agent, 'sessionId' | 'teamName'>,
): TeamSummary | undefined {
  if (!teams) return undefined
  if (agent.teamName) return findTeam(teams, agent.teamName, agent.sessionId)
  for (const t of teams.values()) if (sessionInTeam(t, agent.sessionId)) return t
  return undefined
}

/**
 * Phase of a workflow agent: the label the workflow announced for its member in team_info, matched by member name.
 * Undefined for anything else (no team_info yet, member without phase, Agent Team): a phase is never inferred.
 */
export function phaseOfAgent(
  agent: Pick<Agent, 'sessionId' | 'teamName' | 'teamKind' | 'name' | 'localId'>,
  teams: ReadonlyMap<string, TeamSummary> | undefined,
): string | undefined {
  if (agent.teamKind !== 'workflow' || !agent.teamName) return undefined
  const member = findTeam(teams, agent.teamName, agent.sessionId)?.members.find(m => m.name === agent.name || m.name === agent.localId)
  return member?.phase || undefined
}

/** Key of the team in the map (the map key, not the display name), when the team is in the map. */
export function keyOfTeam(teams: ReadonlyMap<string, TeamSummary>, team: TeamSummary): string | undefined {
  for (const [key, t] of teams) if (t === team) return key
  return undefined
}

export type TeamHaloStatus = 'error' | 'waiting' | 'working' | 'idle' | 'complete'

/**
 * Status of a team halo: error, then waiting for permission, then working when any member runs
 * (agent state) or any teammate reports activity 'working', then complete when all are done, else idle.
 * A teammate that is idle between tasks (state idle) still counts as working while its activity says so.
 */
export function teamHaloStatus(members: Iterable<Pick<Agent, 'state' | 'activity'>>): TeamHaloStatus {
  let error = false, waiting = false, working = false, any = false, allComplete = true
  for (const m of members) {
    any = true
    if (m.state === 'error') error = true
    else if (m.state === 'waiting_permission') waiting = true
    else if (m.state === 'thinking' || m.state === 'tool_calling') working = true
    else if (m.state !== 'complete' && m.activity === 'working') working = true
    if (m.state !== 'complete') allComplete = false
  }
  if (error) return 'error'
  if (waiting) return 'waiting'
  if (working) return 'working'
  return any && allComplete ? 'complete' : 'idle'
}
