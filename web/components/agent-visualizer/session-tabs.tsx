'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/vscode-bridge'
import type { TeamSummary } from '@/lib/agent-types'
import {
  FOCUS_RING, SESSION_STATUS_TEXT, buildTabModel, formatTeamSummary, nextTabIndex, resolvePendingFocus, runtimeBadge,
  sessionStatusKind, tabStopId,
  type PendingTabFocus, type SessionStatusKind,
} from '@/lib/chrome-utils'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  /** Agent Teams seen so far: each gets a team tab (union of the team's sessions) */
  teams?: ReadonlyMap<string, TeamSummary>
  /** Members currently working per team name */
  teamWorking?: ReadonlyMap<string, number>
  /** Known member count per team name (falls back to the team config) */
  teamMemberCounts?: ReadonlyMap<string, number>
}

const PENDING_FOCUS_MS = 1000

/** Status marker: shape differs per status (filled disc / ring / check) so colour is never the only cue. */
function StatusMarker({ kind }: { kind: SessionStatusKind }) {
  if (kind === 'completed') {
    return (
      <span aria-hidden="true" className="shrink-0 text-[11px] leading-none" style={{ color: COLORS.idle }}>✓</span>
    )
  }
  const isNew = kind === 'new-activity'
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${isNew ? 'motion-safe:animate-pulse' : ''}`}
      style={{
        background: isNew ? 'transparent' : COLORS.complete,
        border: `2px solid ${COLORS.complete}`,
        boxShadow: `0 0 4px ${COLORS.complete}`,
      }}
    />
  )
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
  teams,
  teamWorking,
  teamMemberCounts,
}: SessionTabsProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const setTabRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) tabRefs.current.set(id, el)
    else tabRefs.current.delete(id)
  }, [])

  // Scroll selected tab into view whenever it changes
  useEffect(() => {
    if (!selectedSessionId) return
    const el = tabRefs.current.get(selectedSessionId)
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  // Closing a tab unmounts the focused control: move focus to the neighbouring tab once the list updates.
  // The pending move is dropped when the close turns out to be a no-op (see resolvePendingFocus) or
  // after a short grace period, so an unrelated later change never steals focus.
  const pendingFocusRef = useRef<PendingTabFocus | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabItems = buildTabModel(sessions, teams ? teams.keys() : [])
  const tabIds = tabItems.map(t => t.id)
  const closeTab = (id: string) => {
    const at = tabIds.indexOf(id)
    if (at < 0) return
    // Neighbour in visual order; with none left the 'All' tab is the natural landing spot
    const focusId = tabIds[at + 1] ?? tabIds[at - 1] ?? ALL_SESSIONS_ID
    const active = document.activeElement
    const focusInTabs = !!active && Array.from(tabRefs.current.values()).some(el => el.parentElement?.contains(active))
    pendingFocusRef.current = focusInTabs ? { closedId: id, focusId } : null
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    if (pendingFocusRef.current) {
      pendingTimerRef.current = setTimeout(() => { pendingFocusRef.current = null }, PENDING_FOCUS_MS)
    }
    onCloseSession(id)
  }
  useEffect(() => () => { if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current) }, [])
  useEffect(() => {
    const { focusId, keep } = resolvePendingFocus(pendingFocusRef.current, tabIds)
    pendingFocusRef.current = keep
    if (!focusId) return
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null }
    tabRefs.current.get(focusId)?.focus({ preventScroll: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tabIds is derived from sessions and teams
  }, [sessions, teams])

  // Roving tabindex: if the selection is not among the tabs, the first ('All') tab stays reachable.
  const stopId = tabStopId(tabIds, selectedSessionId)

  const handleKeyDown = (e: React.KeyboardEvent, tabIndex: number) => {
    if (e.key === 'Delete') {
      if (tabItems[tabIndex]?.kind !== 'session') return // the 'All' and team tabs cannot be closed
      e.preventDefault()
      closeTab(tabIds[tabIndex])
      return
    }
    const next = nextTabIndex(tabIndex, e.key, tabIds.length)
    if (next === null) return
    e.preventDefault()
    const targetId = tabIds[next]
    tabRefs.current.get(targetId)?.focus()
    onSelectSession(targetId)
  }

  const allSelected = selectedSessionId === ALL_SESSIONS_ID

  return (
    <div role="tablist" aria-label="Sessions" className="flex gap-1">
      <div
        role="presentation"
        className="flex items-center shrink-0 rounded"
        style={{
          whiteSpace: 'nowrap',
          background: allSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
          border: `1px solid ${allSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
          borderBottomWidth: allSelected ? 3 : 1,
        }}
      >
        <button
          type="button"
          role="tab"
          id={`session-tab-${ALL_SESSIONS_ID}`}
          aria-selected={allSelected}
          aria-controls="visualizer-main"
          tabIndex={stopId === ALL_SESSIONS_ID ? 0 : -1}
          ref={(el) => setTabRef(ALL_SESSIONS_ID, el)}
          onClick={() => onSelectSession(ALL_SESSIONS_ID)}
          onKeyDown={(e) => handleKeyDown(e, 0)}
          className={`min-h-6 min-w-6 px-2.5 py-1 rounded flex items-center text-[11px] ${allSelected ? 'font-semibold' : ''} ${FOCUS_RING}`}
          style={{ color: allSelected ? COLORS.holoBright : COLORS.textMuted }}
        >
          All
          <span className="sr-only"> sessions</span>
        </button>
      </div>
      {tabItems.slice(1).map((item, i) => {
        const tabIndex = i + 1
        if (item.kind === 'team') {
          const name = item.teamName!
          const isSelected = item.id === selectedSessionId
          const members = Math.max(teamMemberCounts?.get(name) ?? 0, teams?.get(name)?.members.length ?? 0)
          const summary = formatTeamSummary(name, members, teamWorking?.get(name) ?? 0)
          return (
            <div
              key={item.id}
              role="presentation"
              className="flex items-center shrink-0 rounded"
              style={{
                whiteSpace: 'nowrap',
                background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                borderBottomWidth: isSelected ? 3 : 1,
              }}
            >
              <button
                type="button"
                role="tab"
                id={`session-tab-${item.id}`}
                aria-selected={isSelected}
                aria-controls="visualizer-main"
                tabIndex={item.id === stopId ? 0 : -1}
                ref={(el) => setTabRef(item.id, el)}
                onClick={() => onSelectSession(item.id)}
                onKeyDown={(e) => handleKeyDown(e, tabIndex)}
                title={summary}
                className={`min-h-6 min-w-6 px-2.5 py-1 rounded flex items-center gap-1.5 text-[11px] ${isSelected ? 'font-semibold' : ''} ${FOCUS_RING}`}
                style={{ color: isSelected ? COLORS.holoBright : COLORS.textMuted }}
              >
                {summary}
                <span className="sr-only">, whole team in one view</span>
              </button>
            </div>
          )
        }
        const session = sessions.find(s => s.id === item.id)
        if (!session) return null
        const isSelected = session.id === selectedSessionId
        const kind = sessionStatusKind(session, sessionsWithActivity.has(session.id), isSelected)
        const badge = runtimeBadge(session.runtime)
        return (
          <div
            key={session.id}
            role="presentation"
            className="group flex items-center shrink-0 rounded"
            style={{
              whiteSpace: 'nowrap',
              background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
              border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
              borderBottomWidth: isSelected ? 3 : 1,
            }}
          >
            <button
              type="button"
              role="tab"
              id={`session-tab-${session.id}`}
              aria-selected={isSelected}
              aria-controls="visualizer-main"
              tabIndex={session.id === stopId ? 0 : -1}
              ref={(el) => setTabRef(session.id, el)}
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(e) => handleKeyDown(e, tabIndex)}
              className={`min-h-6 min-w-6 pl-2 pr-1 py-1 rounded-l flex items-center gap-1.5 text-[11px] ${isSelected ? 'font-semibold' : ''} ${FOCUS_RING}`}
              style={{ color: isSelected ? COLORS.holoBright : COLORS.textMuted }}
            >
              <StatusMarker kind={kind} />
              <span className="sr-only">{SESSION_STATUS_TEXT[kind]}, </span>
              {badge && (
                <>
                  <span aria-hidden="true" title={badge.label} className="shrink-0 rounded px-1 text-[11px] leading-4" style={{ border: `1px solid ${COLORS.tabInactiveBorder}` }}>{badge.short}</span>
                  <span className="sr-only">{badge.label} session, </span>
                </>
              )}
              {item.teamName && <span className="sr-only">team {item.teamName}, </span>}
              {session.label}
            </button>
            <button
              type="button"
              aria-label={`Close session ${session.label}`}
              title="Close session"
              onClick={() => closeTab(session.id)}
              className={`min-h-6 min-w-6 rounded-r text-[11px] leading-none opacity-70 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
              style={{ color: COLORS.tabClose }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
