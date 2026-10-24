'use client'

import type { SessionInfo } from '@/lib/bridge-types'
import { buildAnnouncementParts, type ConnectionDisplay, type ModeNote } from '@/lib/chrome-utils'
import { useLocale } from '@/lib/locale'
import { hiddenDoneCount, hiddenDoneText } from '@/lib/inactive-agents'
import type { Agent } from '@/lib/agent-types'
import { useMemo } from 'react'
import { useUnobservedSessionCount } from '@/hooks/use-unobserved-sessions'

interface ChromeAnnouncerProps {
  connection: ConnectionDisplay
  sessionLabel: string | null
  isReviewing: boolean
  isEmpty: boolean
  sessions: ReadonlyArray<SessionInfo>
  sessionsWithActivity: ReadonlySet<string>
  /** Full screen on/off, once the mode has changed (#196) */
  fullscreenNote?: ModeNote | null
  /** Presentation mode on/off, once the mode has changed (#245) */
  presentationNote?: ModeNote | null
}

/**
 * Polite live region: connection, session, review mode and empty state changes, plus the number of
 * listed sessions whose activity is not observed (issue #52), which follows the observation tracker.
 */
export function ChromeAnnouncer({ connection, sessionLabel, isReviewing, isEmpty, sessions, sessionsWithActivity, fullscreenNote, presentationNote }: ChromeAnnouncerProps) {
  const unobservedSessions = useUnobservedSessionCount(sessions, sessionsWithActivity)
  const { locale } = useLocale()
  const parts = buildAnnouncementParts({ connection, sessionLabel, isReviewing, isEmpty, unobservedSessions, fullscreenNote, presentationNote, locale })
  // The whole sentence is in the locale (#613): the region declares it, each piece too.
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" lang={locale}>
      {parts.map((p, i) => (
        <span key={i} lang={p.lang}>
          {i > 0 ? '. ' : ''}
          {p.segments ? p.segments.map((s, j) => <span key={j} lang={s.lang}>{s.text}</span>) : p.text}
        </span>
      ))}
    </div>
  )
}

interface HiddenFinishedAnnouncerProps {
  agents: Map<string, Agent>
  hideInactive: boolean
  /** Agents that stay visible whatever their state (the selected one) */
  keepIds?: ReadonlyArray<string | null | undefined>
}

/** Polite live region: how many finished agents 'Hide inactive agents' keeps off the screen (empty when none). */
export function HiddenFinishedAnnouncer({ agents, hideInactive, keepIds }: HiddenFinishedAnnouncerProps) {
  const count = useMemo(() => hiddenDoneCount(agents, hideInactive, keepIds), [agents, hideInactive, keepIds])
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="hidden-finished">{hiddenDoneText(count)}</div>
}
