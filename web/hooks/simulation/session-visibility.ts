/**
 * Which sessions the 'All' view shows (#36). Finished, long-idle sessions would turn the union into a
 * crowd of tiny clusters, so by default only active ones count. Pure: no React, no DOM.
 */
import type { SessionInfo } from '../../lib/bridge-types'

/** A session with an event younger than this counts as active even when its status says completed */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000

/** localStorage key of the 'Show finished sessions' preference */
export const SHOW_FINISHED_STORAGE_KEY = 'agent-lens:show-finished-sessions'

export interface SessionVisibilityInput {
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'status' | 'lastActivityTime' | 'teamName'>>
  /** Wall-clock time (ms) of the latest event seen per session */
  lastEventAt?: ReadonlyMap<string, number>
  /** The selected tab (a session id, 'All' or a team pseudo selection): a selected session is always shown */
  selectedId?: string | null
  /** Sessions of every known team, by team name */
  teamSessions?: ReadonlyMap<string, ReadonlySet<string>>
  /** Members currently working per team name */
  teamWorking?: ReadonlyMap<string, number>
  now: number
  windowMs?: number
}

/**
 * Ids of the sessions shown in 'All': status active, OR an event/activity in the last `windowMs`,
 * OR the selected one, OR a member of a team that has a working member. Sessions only known from
 * events (not in the list) are judged by their last event alone.
 */
export function activeSessionIds(input: SessionVisibilityInput): Set<string> {
  const { sessions, lastEventAt, selectedId, teamSessions, teamWorking, now } = input
  const windowMs = input.windowMs ?? ACTIVE_WINDOW_MS
  const recent = (t: number | undefined): boolean => typeof t === 'number' && Number.isFinite(t) && now - t <= windowMs
  const out = new Set<string>()
  for (const s of sessions) {
    if (s.status === 'active' || recent(s.lastActivityTime) || recent(lastEventAt?.get(s.id)) || s.id === selectedId) out.add(s.id)
  }
  if (lastEventAt) for (const [id, t] of lastEventAt) if (recent(t)) out.add(id)
  if (teamWorking) {
    if (teamSessions) {
      for (const [team, ids] of teamSessions) {
        if ((teamWorking.get(team) ?? 0) > 0) for (const id of ids) out.add(id)
      }
    }
    // A team tagged on the session itself counts too
    for (const s of sessions) if (s.teamName && (teamWorking.get(s.teamName) ?? 0) > 0) out.add(s.id)
  }
  return out
}

/** Sessions of the list that are not in the active set (the 'finished' ones). */
export function finishedSessionIds(
  sessions: ReadonlyArray<Pick<SessionInfo, 'id'>>,
  active: ReadonlySet<string>,
): string[] {
  return sessions.filter(s => !active.has(s.id)).map(s => s.id)
}

/** Stable identity of a visibility set (null = everything visible), to detect changes cheaply. */
export function visibilityKey(visible: ReadonlySet<string> | null): string {
  return visible === null ? '*' : Array.from(visible).sort().join('\u0001')
}

/** Parse the persisted preference: only the exact string 'true' turns it on. */
export function parseShowFinished(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/** Label of the toggle: 'Show finished sessions (N)'. */
export function finishedToggleLabel(count: number): string {
  return `Show finished sessions (${count})`
}
