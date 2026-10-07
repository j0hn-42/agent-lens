'use client'

import { useSyncExternalStore } from 'react'
import type { SessionInfo } from '@/lib/bridge-types'
import { observedSessions, countUnobservedSessions } from '@/lib/session-model'

/**
 * Number of listed sessions whose activity is not observed (issue #52). It follows the app-wide
 * tracker, so it updates as soon as the first event of a session arrives.
 */
export function useUnobservedSessionCount(
  sessions: ReadonlyArray<SessionInfo>,
  sessionsWithActivity: ReadonlySet<string>,
): number {
  useSyncExternalStore(observedSessions.subscribe, observedSessions.getVersion, observedSessions.getVersion)
  return countUnobservedSessions(sessions, id => sessionsWithActivity.has(id))
}
