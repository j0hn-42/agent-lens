/**
 * 'Show: active / all' (#372): the one visibility rule of the view. It replaces 'Hide inactive agents' (agents) and
 * 'Show finished sessions' (sessions of the All view), two settings with two different thresholds. Pure: no React.
 *
 * 'active' (the default) applies both filters exactly as the code always did, so nothing new is claimed:
 * - an agent is hidden when its turn is over or it finished (isInactiveAgent / visibleAgents in inactive-agents.ts:
 *   idle at the end of a turn, complete, archived, or a member that reported 'done'; an agent between two steps, in
 *   error or waiting for a permission stays, and so do the members of a workflow that still runs);
 * - a session of the All view is hidden when it is marked finished and its last event is older than
 *   ACTIVE_WINDOW_MS, 10 minutes (activeSessionIds in session-visibility.ts; the selected session and the sessions of a
 *   team at work stay). A session never marked finished is not hidden, however long it is silent.
 * 'all' turns both filters off.
 */
import { ACTIVE_WINDOW_MS } from '../hooks/simulation/session-visibility'

export type ShowMode = 'active' | 'all'
export const DEFAULT_SHOW_MODE: ShowMode = 'active'

/** The threshold of the session filter, in whole minutes, as the labels write it */
export const ACTIVE_WINDOW_MINUTES = Math.round(ACTIVE_WINDOW_MS / 60_000)

export function isShowMode(value: unknown): value is ShowMode {
  return value === 'active' || value === 'all'
}

/** 'active' hides the agents whose turn is over or that finished */
export function hidesInactiveAgents(mode: ShowMode): boolean {
  return mode === 'active'
}

/** 'all' also lists the finished sessions of the All view */
export function showsFinishedSessions(mode: ShowMode): boolean {
  return mode === 'all'
}

/**
 * Migration of the two former settings into the one mode. Only their default pair ('Hide inactive agents' on,
 * 'Show finished sessions' off) is 'active'; any other pair means the user asked to see something those filters hid,
 * so it becomes 'all': nothing the user chose to see disappears after the update.
 */
export function showModeFromLegacy(hideInactive: boolean, showFinished: boolean): ShowMode {
  return hideInactive && !showFinished ? 'active' : 'all'
}
