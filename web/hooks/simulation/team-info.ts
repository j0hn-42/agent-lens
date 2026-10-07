/**
 * Agent Team data: sanitising of untrusted team_info / spawn extras, and a tracker that follows
 * team membership across every session (independent of which tab is selected).
 * Pure: no React, no DOM.
 */
import type { TeamSummary } from '../../lib/agent-types'
import { ALL_SESSIONS_ID, cleanLine, parseTeamSelection } from '../../lib/bridge-types'
import { teamKeyFor } from './team-key'

export const MAX_TEAM_NAME_LEN = 80
export const MAX_TEAM_MEMBERS = 100
const MAX_ID = 200

export { cleanLine }

/** Team color: '#rrggbb' only, anything else is dropped. */
export function sanitizeColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined
}

export function sanitizeTeamName(v: unknown): string {
  return cleanLine(v, MAX_TEAM_NAME_LEN)
}

/** Validate a team_info payload (untrusted); null when it names no team. */
export function sanitizeTeamInfo(payload: Record<string, unknown>): TeamSummary | null {
  const name = sanitizeTeamName(payload.teamName)
  if (!name) return null
  const rawMembers = Array.isArray(payload.members) ? payload.members.slice(0, MAX_TEAM_MEMBERS) : []
  const members: TeamSummary['members'] = []
  for (const m of rawMembers) {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) continue
    const rec = m as Record<string, unknown>
    const memberName = cleanLine(rec.name)
    if (!memberName) continue
    const agentType = cleanLine(rec.agentType)
    const backendType = cleanLine(rec.backendType, 40)
    const sessionId = cleanLine(rec.sessionId, MAX_ID)
    const color = sanitizeColor(rec.color)
    members.push({
      name: memberName,
      ...(agentType ? { agentType } : {}),
      ...(color ? { color } : {}),
      ...(backendType ? { backendType } : {}),
      ...(sessionId ? { sessionId } : {}),
    })
  }
  const leadSessionId = cleanLine(payload.leadSessionId, MAX_ID)
  const leadName = cleanLine(payload.leadName)
  return { name, leadSessionId, ...(leadName ? { leadName } : {}), members }
}

export interface TeammateExtras {
  teamName: string
  teamColor?: string
  agentType?: string
  backend?: string
  memberSessionId?: string
}

/** Teammate extras of an agent_spawn payload (untrusted); null when the agent is not a teammate. */
export function parseTeammateExtras(payload: Record<string, unknown>): TeammateExtras | null {
  if (payload.kind !== 'teammate') return null
  const teamName = sanitizeTeamName(payload.teamName)
  if (!teamName) return null
  const teamColor = sanitizeColor(payload.color)
  const agentType = cleanLine(payload.agentType)
  const backend = cleanLine(payload.backendType, 40)
  const memberSessionId = cleanLine(payload.memberSessionId, MAX_ID)
  return {
    teamName,
    ...(teamColor ? { teamColor } : {}),
    ...(agentType ? { agentType } : {}),
    ...(backend ? { backend } : {}),
    ...(memberSessionId ? { memberSessionId } : {}),
  }
}

export type Activity = 'working' | 'idle' | 'done'

export function parseActivity(v: unknown): Activity | null {
  return v === 'working' || v === 'idle' || v === 'done' ? v : null
}

/** Max teams stored by the simulation / followed by a tracker (new teams beyond it are ignored) */
export const MAX_TEAMS = 50
/** Sessions remembered per team */
const MAX_TEAM_SESSIONS = 200

/**
 * Follows teams over the whole event stream (all sessions, selected or not) so the tabs can show
 * 'Team X: N members, M working' and know which sessions belong to a team.
 */
export interface TeamTracker {
  /** Feed one event; true when the tracked data changed */
  ingest(event: { type: string; payload: Record<string, unknown>; sessionId?: string }): boolean
  /** Keyed per (lead session, name) - see team-key.ts; `TeamSummary.name` is the display name */
  teams: Map<string, TeamSummary>
  /** Session ids known to take part in the team (lead, members, sessions of its teammates); takes a team key or a plain name */
  sessionsOf(teamName: string): ReadonlySet<string>
  /** Members of the team whose last reported activity is 'working' */
  working(teamName: string): number
  /** Known members: the larger of the team config and the teammates seen spawning */
  memberCount(teamName: string): number
  clear(): void
}

export function createTeamTracker(): TeamTracker {
  /** team key (see team-key.ts) -> summary */
  const teams = new Map<string, TeamSummary>()
  const sessions = new Map<string, Set<string>>()
  /** `${sessionId}:${localName}` -> team key */
  const memberTeam = new Map<string, string>()
  const activity = new Map<string, Activity>()
  /** team key -> number of tracked teammates / of those working: O(1) reads, bounded by MAX_TEAMS * MAX_TEAM_MEMBERS */
  const seenCount = new Map<string, number>()
  const workingCount = new Map<string, number>()
  /** Teams created by a teammate spawn before any team_info named their lead: a team_info of that name adopts them */
  const provisional = new Set<string>()

  /** A team key, or the plain name of a team (first team of that name) */
  const resolve = (k: string): string => {
    if (teams.has(k)) return k
    for (const [key, t] of teams) if (t.name === k) return key
    return k
  }
  const addSession = (team: string, sid: string | undefined): void => {
    if (!sid) return
    let set = sessions.get(team)
    if (!set) { set = new Set(); sessions.set(team, set) }
    if (set.size < MAX_TEAM_SESSIONS) set.add(sid)
  }
  const bump = (m: Map<string, number>, team: string, by: number): void => { m.set(team, Math.max(0, (m.get(team) ?? 0) + by)) }
  const setActivity = (key: string, team: string, next: Activity): boolean => {
    const prev = activity.get(key)
    if (prev === next) return false
    if (prev === 'working') bump(workingCount, team, -1)
    if (next === 'working') bump(workingCount, team, 1)
    activity.set(key, next)
    return true
  }
  /** Team of that name a teammate spawn in session `sid` belongs to (lead session or a known session of the team) */
  const teamForSpawn = (name: string, sid: string): string | undefined => {
    for (const [key, t] of teams) if (t.name === name && (t.leadSessionId === sid || sessions.get(key)?.has(sid))) return key
    return undefined
  }

  return {
    teams,
    ingest(event) {
      const sid = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : 'default'
      if (event.type === 'team_info') {
        const info = sanitizeTeamInfo(event.payload)
        if (!info) return false
        let key = teamKeyFor(teams, info.name, info.leadSessionId)
        if (!teams.has(key)) {
          // Adopt a team made provisionally by a teammate spawn of the same name in a session of this team
          const adoptable = Array.from(provisional).find(k => teams.get(k)?.name === info.name
            && (sessions.get(k)?.has(sid) || sessions.get(k)?.has(info.leadSessionId)))
          if (adoptable) key = adoptable
          else if (teams.size >= MAX_TEAMS) return false
        }
        provisional.delete(key)
        teams.set(key, info)
        addSession(key, info.leadSessionId)
        addSession(key, sid)
        for (const m of info.members) addSession(key, m.sessionId)
        return true
      }
      if (event.type === 'agent_spawn') {
        const extras = parseTeammateExtras(event.payload)
        const name = cleanLine(event.payload.name, MAX_ID)
        if (!extras || !name) return false
        let team = teamForSpawn(extras.teamName, sid)
        if (team === undefined) {
          if (teams.size >= MAX_TEAMS) return false
          team = teamKeyFor(teams, extras.teamName, sid)
        }
        const key = `${sid}:${name}`
        const known = memberTeam.has(key)
        if (!known && (seenCount.get(team) ?? 0) >= MAX_TEAM_MEMBERS) return false
        if (!teams.has(team)) {
          teams.set(team, { name: extras.teamName, leadSessionId: sid, members: [] })
          provisional.add(team)
        }
        if (!known) {
          memberTeam.set(key, team)
          bump(seenCount, team, 1)
          setActivity(key, team, 'working')
        }
        addSession(team, sid)
        addSession(team, extras.memberSessionId)
        return true
      }
      if (event.type === 'agent_activity') {
        const act = parseActivity(event.payload.activity)
        const key = `${sid}:${cleanLine(event.payload.name, MAX_ID)}`
        const team = memberTeam.get(key)
        if (!act || !team) return false
        return setActivity(key, team, act)
      }
      if (event.type === 'agent_complete') {
        const key = `${sid}:${cleanLine(event.payload.name, MAX_ID)}`
        const team = memberTeam.get(key)
        if (!team) return false
        return setActivity(key, team, 'done')
      }
      return false
    },
    sessionsOf(team) { return sessions.get(resolve(team)) ?? new Set() },
    working(team) { return workingCount.get(resolve(team)) ?? 0 },
    memberCount(team) {
      const key = resolve(team)
      return Math.max(teams.get(key)?.members.length ?? 0, seenCount.get(key) ?? 0)
    },
    clear() { teams.clear(); sessions.clear(); memberTeam.clear(); activity.clear(); seenCount.clear(); workingCount.clear(); provisional.clear() },
  }
}

/** Sessions of a team: tracked sessions plus any SessionInfo tagged with the team name. */
export function teamSessionIds(
  teamName: string,
  tracker: Pick<TeamTracker, 'sessionsOf'>,
  sessions: ReadonlyArray<{ id: string; teamName?: string }>,
): Set<string> {
  const ids = new Set(tracker.sessionsOf(teamName))
  for (const s of sessions) if (s.teamName === teamName) ids.add(s.id)
  return ids
}

/**
 * Whether an event of `sessionId` belongs to the selected view: the session itself, every event for
 * 'All', the sessions of the team for a team pseudo selection. Nothing selected matches nothing.
 */
export function eventMatchesSelection(
  selected: string | null | undefined,
  sessionId: string | undefined,
  tracker: Pick<TeamTracker, 'sessionsOf'>,
  sessions: ReadonlyArray<{ id: string; teamName?: string }>,
  /** 'All' only: the sessions it shows (null/undefined = every session); events without a session pass */
  visibleInAll?: ReadonlySet<string> | null,
): boolean {
  if (!selected) return false
  if (selected === ALL_SESSIONS_ID) return !visibleInAll || !sessionId || visibleInAll.has(sessionId)
  const team = parseTeamSelection(selected)
  if (team !== null) return !!sessionId && teamSessionIds(team, tracker, sessions).has(sessionId)
  return sessionId === selected
}
