'use client'

import type { SessionInfo } from '@/lib/bridge-types'
import { buildAnnouncement, type ConnectionDisplay } from '@/lib/chrome-utils'
import { useUnobservedSessionCount } from '@/hooks/use-unobserved-sessions'

interface ChromeAnnouncerProps {
  connection: ConnectionDisplay
  sessionLabel: string | null
  isReviewing: boolean
  isEmpty: boolean
  sessions: ReadonlyArray<SessionInfo>
  sessionsWithActivity: ReadonlySet<string>
}

/**
 * Polite live region: connection, session, review mode and empty state changes, plus the number of
 * listed sessions whose activity is not observed (issue #52), which follows the observation tracker.
 */
export function ChromeAnnouncer({ connection, sessionLabel, isReviewing, isEmpty, sessions, sessionsWithActivity }: ChromeAnnouncerProps) {
  const unobservedSessions = useUnobservedSessionCount(sessions, sessionsWithActivity)
  const announcement = buildAnnouncement({ connection, sessionLabel, isReviewing, isEmpty, unobservedSessions })
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
}
