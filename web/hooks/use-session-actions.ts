'use client'

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import type { UseUiPreferences } from '@/hooks/use-ui-preferences'
import type { ToastInput } from '@/hooks/use-toasts'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { clusterSelectionTarget } from '@/lib/chrome-utils'
import { downloadText, EXPORT_FAILED_MESSAGE } from '@/lib/comms-export'
import { buildSessionExport, renderReplayHtml, sessionExportFileName } from '@/lib/session-export'
import { detectedSessions } from '@/lib/session-model'
import { initSessionMemory, stepSessionMemory, type SessionMemoryState } from '@/lib/ui-preferences'

type Bridge = ReturnType<typeof useVSCodeBridge>

interface SessionActionsInput {
  bridge: Pick<Bridge, 'sessions' | 'selectedSessionId' | 'allViewSessionIds' | 'useMockData' | 'removeSession' | 'restoreSession'
    | 'selectSession' | 'getBufferedEventCount' | 'getSessionEvents'>
  uiPrefs: Pick<UseUiPreferences, 'getPrefs' | 'setPref'>
  pushToast: (toast: ToastInput) => void
  /** Cached simulation state per session: an entry is dropped once closing its session can no longer be undone */
  sessionCacheRef: RefObject<Map<string, unknown>>
}

/** What the session list and the halo labels do with a session: remember, close (with undo), export, select a cluster */
export function useSessionActions({ bridge, uiPrefs, pushToast, sessionCacheRef }: SessionActionsInput) {
  const { getPrefs, setPref } = uiPrefs
  const { removeSession, restoreSession, selectSession } = bridge

  // Remembered session: restored once when the session list first arrives, persisted only afterwards
  // (state machine in lib/ui-preferences.ts: a persist effect on mount would overwrite the stored id with
  // the startup null, and the bridge's own auto-selection would overwrite it again).
  const sessionMemoryRef = useRef<SessionMemoryState | null>(null)
  useEffect(() => {
    if (!sessionMemoryRef.current) sessionMemoryRef.current = initSessionMemory(getPrefs().lastSelectedSessionId)
    const step = stepSessionMemory(sessionMemoryRef.current, { sessions: bridge.sessions, selectedId: bridge.selectedSessionId })
    sessionMemoryRef.current = step.state
    if (step.select) selectSession(step.select)
    if (step.persist !== undefined) setPref('lastSelectedSessionId', step.persist)
  }, [bridge.sessions, bridge.selectedSessionId, selectSession, setPref, getPrefs])

  const handleCloseSession = useCallback((id: string) => {
    const closed = bridge.sessions.find(s => s.id === id)
    const wasSelected = bridge.selectedSessionId === id
    const remaining = bridge.sessions.filter(s => s.id !== id)
    removeSession(id)
    if (wasSelected) {
      // Never leave a stale id selected: fall back to the last remaining session, else the 'All' tab
      selectSession(remaining.length > 0 ? remaining[remaining.length - 1].id : ALL_SESSIONS_ID)
    }
    pushToast({
      message: `Session closed${closed ? `: ${closed.label}` : ''}`,
      actionLabel: 'Undo',
      onAction: () => {
        if (restoreSession(id) && wasSelected) selectSession(id)
      },
      // The cached simulation state is only needed while undo is possible (the toast stays until used or dismissed, #371)
      onExpire: () => { sessionCacheRef.current?.delete(id) },
    })
  }, [bridge.sessions, bridge.selectedSessionId, removeSession, restoreSession, selectSession, pushToast, sessionCacheRef])

  // Session export (#237): only real sessions with events in memory; the demo has no export
  const canExportSession = useCallback((id: string) => !bridge.useMockData && bridge.getBufferedEventCount(id) > 0,
    [bridge.useMockData, bridge.getBufferedEventCount])
  const handleExportSession = useCallback((id: string) => {
    const session = bridge.sessions.find(s => s.id === id)
    const { events, droppedBefore } = bridge.getSessionEvents(id)
    if (!session || events.length === 0) {
      pushToast({ message: 'Nothing to export: no event of this session is in memory', durationMs: 5000 })
      return
    }
    const exp = buildSessionExport({ sessionId: id, label: session.label, events, droppedBefore })
    const saved = downloadText(sessionExportFileName(exp), renderReplayHtml(exp), 'text/html')
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const lost = droppedBefore > 0 ? `, ${plural(droppedBefore, 'earlier event')} already dropped` : ''
    pushToast({
      message: saved
        ? `Exported ${plural(exp.eventCount, 'event')} as an HTML replay${lost}; ${plural(exp.redactions.total, 'secret')} redacted (best effort)`
        : EXPORT_FAILED_MESSAGE,
      durationMs: 6000,
    })
  }, [bridge.sessions, bridge.getSessionEvents, pushToast])

  // A halo label click selects its session / team tab (kept in refs: the canvas holds the latest callback)
  const allViewSessionIds = bridge.allViewSessionIds
  const shownSessionCount = detectedSessions(bridge.sessions).filter(s => !allViewSessionIds || allViewSessionIds.has(s.id)).length
  const clusterStateRef = useRef({ selectedId: bridge.selectedSessionId, shown: shownSessionCount })
  clusterStateRef.current = { selectedId: bridge.selectedSessionId, shown: shownSessionCount }
  const handleClusterSelect = useCallback((cluster: { kind: 'session' | 'team'; sessionIds: string[]; teamName?: string }) => {
    const target = clusterSelectionTarget(cluster, clusterStateRef.current.selectedId, clusterStateRef.current.shown)
    if (target !== null) selectSession(target)
  }, [selectSession])

  return { handleCloseSession, canExportSession, handleExportSession, handleClusterSelect }
}
