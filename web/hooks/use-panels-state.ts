'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { UseUiPreferences } from '@/hooks/use-ui-preferences'
import { createPanelRegistry } from '@/hooks/use-panel-registry'
import { useFocusReturn } from '@/hooks/use-focus-return'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { subscribeDockUserResize } from '@/components/agent-visualizer/shared-ui'
import { dockStore } from '@/lib/panel-layout'
import type { UiPrefs } from '@/lib/ui-preferences'

type PanelId = 'files' | 'conversation' | 'cost' | 'timeline' | 'stats' | 'sessions' | 'context' | 'system'

type FlagKey = 'showStats' | 'showHexGrid' | 'showCostOverlay' | 'showTimeline' | 'showFiles' | 'showConversation'

/** The panels that exclude each other (Conversation and Files share the right dock, Cost is an overlay on it) */
export type ExclusivePanel = 'files' | 'conversation' | 'cost' | 'context'

/**
 * A persisted on/off flag with the useState setter shape (value or updater). The updater reads the live
 * stored value (getPrefs), so two toggles in one tick compose correctly. The first render is the server
 * render (defaults); the stored value is applied right after mount.
 */
function usePersistedFlag(key: FlagKey, prefsApi: Pick<UseUiPreferences, 'prefs' | 'getPrefs' | 'setPref'>) {
  const { prefs, getPrefs, setPref } = prefsApi
  const set = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setPref(key, typeof value === 'function' ? value((getPrefs() as UiPrefs)[key]) : value)
  }, [key, getPrefs, setPref])
  return [prefs[key], set] as const
}

/**
 * Which panels are open: the persisted flags (#32), the right dock width, mutual exclusion, the Escape order
 * (newest panel first) and the focus that moves into a panel when it opens and back to its trigger when it closes.
 */
export function usePanelsState(uiPrefs: UseUiPreferences) {
  const { prefs, setPref } = uiPrefs
  const [showStats, setShowStats] = usePersistedFlag('showStats', uiPrefs)
  const [showHexGrid, setShowHexGrid] = usePersistedFlag('showHexGrid', uiPrefs)
  const [showCostOverlay, setShowCostOverlay] = usePersistedFlag('showCostOverlay', uiPrefs)
  const [showTimeline, setShowTimeline] = usePersistedFlag('showTimeline', uiPrefs)
  const [showFileAttention, setShowFileAttention] = usePersistedFlag('showFiles', uiPrefs)
  const [showSessions, setShowSessions] = useState(false)
  const [showConversation, setShowConversation] = usePersistedFlag('showConversation', uiPrefs)
  const [showContext, setShowContext] = useState(false)
  const [showSystem, setShowSystem] = useState(false)

  // Right dock width: the stored width is applied after mount (and when another tab changes it); a resize
  // by the user is stored. A width that was only clamped by a narrow viewport is never written back.
  useEffect(() => { dockStore.setRightWidth(prefs.dockRightWidth) }, [prefs.dockRightWidth])
  useEffect(() => subscribeDockUserResize(width => setPref('dockRightWidth', width)), [setPref])

  // Opening one exclusive panel closes the others (the project context panel included)
  const toggleExclusivePanel = useCallback((panel: ExclusivePanel) => {
    setShowContext(prev => panel === 'context' ? !prev : false)
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowConversation(prev => panel === 'conversation' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
  }, [setShowFileAttention, setShowConversation, setShowCostOverlay])
  const openConversation = useCallback(() => {
    setShowFileAttention(false)
    setShowCostOverlay(false)
    setShowContext(false)
    setShowConversation(true)
  }, [setShowFileAttention, setShowCostOverlay, setShowConversation])
  const closeConversation = useCallback(() => setShowConversation(false), [setShowConversation])

  // Focus management: move focus into a panel when it opens, back to its trigger when it closes
  const filesPanelRef = useRef<HTMLDivElement>(null)
  const timelinePanelRef = useRef<HTMLDivElement>(null)
  const sessionsPanelRef = useRef<HTMLDivElement>(null)
  const contextPanelRef = useRef<HTMLDivElement>(null)
  const systemPanelRef = useRef<HTMLDivElement>(null)
  useFocusReturn(showFileAttention, filesPanelRef, PANEL_BUTTON_IDS.files)
  // The Conversation panel restores focus itself (to its pill or its top bar button)
  useFocusReturn(showTimeline, timelinePanelRef, PANEL_BUTTON_IDS.timeline)
  useFocusReturn(showSessions, sessionsPanelRef, PANEL_BUTTON_IDS.sessions)
  useFocusReturn(showContext, contextPanelRef, PANEL_BUTTON_IDS.context)
  useFocusReturn(showSystem, systemPanelRef, PANEL_BUTTON_IDS.system)

  // Panel open-order stack (LIFO) so Escape closes the most recently opened panel first
  const panelStackRef = useRef<PanelId[]>([])
  useEffect(() => {
    const open: Record<PanelId, boolean> = {
      files: showFileAttention, conversation: showConversation, cost: showCostOverlay,
      timeline: showTimeline, stats: showStats, sessions: showSessions, context: showContext, system: showSystem,
    }
    const stack = panelStackRef.current.filter(id => open[id])
    for (const id of Object.keys(open) as PanelId[]) {
      if (open[id] && !stack.includes(id)) stack.push(id)
    }
    panelStackRef.current = stack
  }, [showFileAttention, showConversation, showCostOverlay, showTimeline, showStats, showSessions, showContext, showSystem])

  // Extra panels (e.g. the expandable message feed) join the Escape stack through this registry
  const panelRegistry = useMemo(() => createPanelRegistry(), [])
  const registerPanel = panelRegistry.register

  const closeTopPanel = useCallback((): boolean => {
    const top = panelStackRef.current[panelStackRef.current.length - 1]
    if (!top) return panelRegistry.escape()
    panelStackRef.current = panelStackRef.current.slice(0, -1)
    if (top === 'files') setShowFileAttention(false)
    else if (top === 'conversation') setShowConversation(false)
    else if (top === 'cost') setShowCostOverlay(false)
    else if (top === 'timeline') setShowTimeline(false)
    else if (top === 'sessions') setShowSessions(false)
    else if (top === 'context') setShowContext(false)
    else if (top === 'system') setShowSystem(false)
    else setShowStats(false)
    return true
  }, [panelRegistry, setShowFileAttention, setShowConversation, setShowCostOverlay, setShowTimeline, setShowStats])

  return {
    showStats, setShowStats, showHexGrid, setShowHexGrid, showCostOverlay, showTimeline, setShowTimeline,
    showFileAttention, setShowFileAttention, showSessions, setShowSessions, showConversation,
    showContext, setShowContext, showSystem, setShowSystem,
    toggleExclusivePanel, openConversation, closeConversation, closeTopPanel, registerPanel,
    panelRefs: { files: filesPanelRef, timeline: timelinePanelRef, sessions: sessionsPanelRef, context: contextPanelRef, system: systemPanelRef },
  }
}
