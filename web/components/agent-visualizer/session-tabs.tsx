'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { FOCUS_RING, SESSION_STATUS_TEXT, nextTabIndex, sessionStatusKind, type SessionStatusKind } from '@/lib/chrome-utils'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

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
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  // Closing a tab unmounts the focused control: move focus to the neighbouring tab once the list updates.
  const pendingFocusRef = useRef<string | null>(null)
  const closeTab = (index: number) => {
    const neighbour = sessions[index + 1] ?? sessions[index - 1]
    const active = document.activeElement
    const focusInTabs = !!active && Array.from(tabRefs.current.values()).some(el => el.parentElement?.contains(active))
    pendingFocusRef.current = focusInTabs && neighbour ? neighbour.id : null
    onCloseSession(sessions[index].id)
  }
  useEffect(() => {
    const id = pendingFocusRef.current
    if (!id) return
    const el = tabRefs.current.get(id)
    if (el) { pendingFocusRef.current = null; el.focus({ preventScroll: true }) }
  }, [sessions])

  // Roving tabindex: if the selection is not among the sessions, the first tab stays reachable.
  const tabStopId = sessions.some(s => s.id === selectedSessionId) ? selectedSessionId : sessions[0]?.id

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Delete') {
      e.preventDefault()
      closeTab(index)
      return
    }
    const next = nextTabIndex(index, e.key, sessions.length)
    if (next === null) return
    e.preventDefault()
    const target = sessions[next]
    tabRefs.current.get(target.id)?.focus()
    onSelectSession(target.id)
  }

  return (
    <div role="tablist" aria-label="Sessions" className="flex gap-1">
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
              tabIndex={session.id === tabStopId ? 0 : -1}
              ref={(el) => setTabRef(session.id, el)}
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
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
