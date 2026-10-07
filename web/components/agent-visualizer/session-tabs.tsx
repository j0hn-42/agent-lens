'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/vscode-bridge'
import {
  FOCUS_RING, SESSION_STATUS_TEXT, nextTabIndex, resolvePendingFocus, sessionStatusKind, sessionTabIds, tabStopId,
  type PendingTabFocus, type SessionStatusKind,
} from '@/lib/chrome-utils'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
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
  const closeTab = (index: number) => {
    const neighbour = sessions[index + 1] ?? sessions[index - 1]
    const active = document.activeElement
    const focusInTabs = !!active && Array.from(tabRefs.current.values()).some(el => el.parentElement?.contains(active))
    // With no neighbouring session the 'All' tab is the natural landing spot
    const focusId = neighbour ? neighbour.id : ALL_SESSIONS_ID
    pendingFocusRef.current = focusInTabs ? { closedId: sessions[index].id, focusId } : null
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    if (pendingFocusRef.current) {
      pendingTimerRef.current = setTimeout(() => { pendingFocusRef.current = null }, PENDING_FOCUS_MS)
    }
    onCloseSession(sessions[index].id)
  }
  useEffect(() => () => { if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current) }, [])
  useEffect(() => {
    const { focusId, keep } = resolvePendingFocus(pendingFocusRef.current, sessions.map(s => s.id))
    pendingFocusRef.current = keep
    if (!focusId) return
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null }
    tabRefs.current.get(focusId)?.focus({ preventScroll: true })
  }, [sessions])

  // Roving tabindex: if the selection is not among the tabs, the first ('All') tab stays reachable.
  const tabIds = sessionTabIds(sessions)
  const stopId = tabStopId(tabIds, selectedSessionId)

  const handleKeyDown = (e: React.KeyboardEvent, tabIndex: number) => {
    if (e.key === 'Delete') {
      const sessionIndex = tabIndex - 1
      if (sessionIndex < 0) return // the 'All' tab cannot be closed
      e.preventDefault()
      closeTab(sessionIndex)
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
      {sessions.map((session, index) => {
        const isSelected = session.id === selectedSessionId
        const kind = sessionStatusKind(session, sessionsWithActivity.has(session.id), isSelected)
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
              onKeyDown={(e) => handleKeyDown(e, index + 1)}
              className={`min-h-6 min-w-6 pl-2 pr-1 py-1 rounded-l flex items-center gap-1.5 text-[11px] ${isSelected ? 'font-semibold' : ''} ${FOCUS_RING}`}
              style={{ color: isSelected ? COLORS.holoBright : COLORS.textMuted }}
            >
              <StatusMarker kind={kind} />
              <span className="sr-only">{SESSION_STATUS_TEXT[kind]}, </span>
              {session.label}
            </button>
            <button
              type="button"
              aria-label={`Close session ${session.label}`}
              title="Close session"
              onClick={() => closeTab(index)}
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
