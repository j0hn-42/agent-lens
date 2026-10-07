/**
 * Which sessions the 'All' view shows (#36). Finished, long-idle sessions would turn the union into a
 * crowd of tiny clusters, so by default only active ones count. Pure: no React, no DOM.
 */
import type { SessionInfo } from '../../lib/bridge-types'
import { isGroupActive, type GroupSummary } from './team-info'

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
  /** Tracked members / done members per team name (a workflow idle between calls stays active) */
  teamSummaries?: ReadonlyMap<string, GroupSummary>
  now: number
  windowMs?: number
}

/**
 * Ids of the sessions shown in 'All': status active, OR an event/activity in the last `windowMs`,
 * OR the selected one, OR a member of a team that has a working member. Sessions only known from
 * events (not in the list) are judged by their last event alone.
 */
export function activeSessionIds(input: SessionVisibilityInput): Set<string> {
  const { sessions, lastEventAt, selectedId, teamSessions, teamWorking, teamSummaries, now } = input
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
        if (isGroupActive(teamSummaries?.get(team), teamWorking.get(team))) for (const id of ids) out.add(id)
      }
    }
    // A team tagged on the session itself counts too
    for (const s of sessions) if (s.teamName && isGroupActive(teamSummaries?.get(s.teamName), teamWorking.get(s.teamName))) out.add(s.id)
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

type StampSession = Pick<SessionInfo, 'status' | 'lastActivityTime'>

/**
 * A session the list already marks completed whose last activity is older than the window. The relay replays
 * every session buffer on connect, so an event of such a session is history, not activity (#36).
 */
export function isStaleCompleted(session: StampSession | undefined, now: number, windowMs: number = ACTIVE_WINDOW_MS): boolean {
  if (!session || session.status !== 'completed') return false
  const t = session.lastActivityTime
  return typeof t === 'number' && Number.isFinite(t) && now - t > windowMs
}

/** Whether an event received now should stamp its session as recently active. */
export function shouldStampActivity(session: StampSession | undefined, now: number, windowMs: number = ACTIVE_WINDOW_MS): boolean {
  return !isStaleCompleted(session, now, windowMs)
}

/**
 * Remove the stamps of sessions that turn out to be stale-completed (events replayed before the list arrived).
 * Mutates `lastEventAt`; returns how many were dropped.
 */
export function pruneReplayStamps(
  lastEventAt: Map<string, number>,
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'status' | 'lastActivityTime'>>,
  now: number,
  windowMs: number = ACTIVE_WINDOW_MS,
): number {
  let dropped = 0
  for (const s of sessions) {
    if (lastEventAt.has(s.id) && isStaleCompleted(s, now, windowMs)) { lastEventAt.delete(s.id); dropped++ }
  }
  return dropped
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
