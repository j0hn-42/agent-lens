'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { UseUiPreferences } from '@/hooks/use-ui-preferences'
import { createPanelRegistry } from '@/hooks/use-panel-registry'
import { useFocusReturn } from '@/hooks/use-focus-return'
import { PANEL_BUTTON_IDS, TOPBAR_MORE_ID } from '@/components/agent-visualizer/top-bar'
import { subscribeDockUserResize, type DockResizeTarget } from '@/components/agent-visualizer/shared-ui'
import { dockStore, SHEET_BREAKPOINT } from '@/lib/panel-layout'
import { shouldAutoOpenConversation } from '@/lib/exclusive-panels'
import type { UiPrefs } from '@/lib/ui-preferences'

type PanelId = 'files' | 'conversation' | 'cost' | 'timeline' | 'stats' | 'sessions' | 'context' | 'system'

/** The preference each resizable dock size is stored under. */
const RESIZE_PREF_KEY: Readonly<Record<DockResizeTarget, 'dockRightWidth' | 'dockLeftWidth' | 'detailPanelHeight' | 'systemPanelHeight'>> = {
  rightWidth: 'dockRightWidth',
  leftWidth: 'dockLeftWidth',
  detailHeight: 'detailPanelHeight',
  systemHeight: 'systemPanelHeight',
}

type FlagKey = 'showStats' | 'showHexGrid' | 'showCostOverlay' | 'showTimeline' | 'showFiles' | 'showConversation'

/** The panels that can be toggled together: Files, Conversation and Context exclude each other, Cost is an independent overlay (#370) */
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
export function usePanelsState(uiPrefs: UseUiPreferences, selectedAgentId: string | null) {
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

  // Dock sizes: the stored size is applied after mount (and when another tab changes it); a resize
  // by the user is stored. A size that was only clamped by a narrow viewport is never written back.
  useEffect(() => { dockStore.setRightWidth(prefs.dockRightWidth) }, [prefs.dockRightWidth])
  useEffect(() => { dockStore.setLeftWidth(prefs.dockLeftWidth) }, [prefs.dockLeftWidth])
  useEffect(() => { dockStore.setLeftHeight('detail', prefs.detailPanelHeight) }, [prefs.detailPanelHeight])
  useEffect(() => { dockStore.setLeftHeight('system', prefs.systemPanelHeight) }, [prefs.systemPanelHeight])
  useEffect(() => subscribeDockUserResize((target, value) => setPref(RESIZE_PREF_KEY[target], value)), [setPref])

  // Files, Conversation and Context share the right dock and are mutually exclusive; Cost is an independent overlay (#370)
  const toggleExclusivePanel = useCallback((panel: ExclusivePanel) => {
    if (panel === 'cost') { setShowCostOverlay(prev => !prev); return }
    setShowContext(prev => panel === 'context' ? !prev : false)
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowConversation(prev => panel === 'conversation' ? !prev : false)
  }, [setShowFileAttention, setShowConversation, setShowCostOverlay])
  const openConversation = useCallback(() => {
    setShowFileAttention(false)
    setShowContext(false)
    setShowConversation(true)
  }, [setShowFileAttention, setShowConversation])
  const closeConversation = useCallback(() => setShowConversation(false), [setShowConversation])

  // Per-agent chat is a preset of the Conversation panel: selecting an agent opens it on that agent's tab
  // (the panel follows `selectedAgentId`); the role label of each message comes from its agent's runtime.
  // Not on a narrow viewport (#116): panels are one-at-a-time sheets there and the newest wins, so opening
  // Conversation right after the card would hide the inspector (and closing it would drop the selection).
  // Not over a panel the user opened (Files, Context): selecting an agent must not close them (#370). The flags are
  // read from a ref so that closing a panel does not re-run the effect.
  const dockFlagsRef = useRef({ files: false, context: false })
  dockFlagsRef.current = { files: showFileAttention, context: showContext }
  useEffect(() => {
    if (selectedAgentId && shouldAutoOpenConversation(dockFlagsRef.current, dockStore.getSnapshot().env.viewport.w, SHEET_BREAKPOINT)) openConversation()
  }, [selectedAgentId, openConversation])

  // Focus management: move focus into a panel when it opens, back to its trigger when it closes
  const filesPanelRef = useRef<HTMLDivElement>(null)
  const timelinePanelRef = useRef<HTMLDivElement>(null)
  const sessionsPanelRef = useRef<HTMLDivElement>(null)
  const contextPanelRef = useRef<HTMLDivElement>(null)
  const systemPanelRef = useRef<HTMLDivElement>(null)
  useFocusReturn(showFileAttention, filesPanelRef, [PANEL_BUTTON_IDS.files, TOPBAR_MORE_ID])
  // The Conversation panel restores focus itself (to its pill or its top bar button)
  useFocusReturn(showTimeline, timelinePanelRef, [PANEL_BUTTON_IDS.timeline, TOPBAR_MORE_ID])
  useFocusReturn(showSessions, sessionsPanelRef, [PANEL_BUTTON_IDS.sessions, TOPBAR_MORE_ID])
  useFocusReturn(showContext, contextPanelRef, [PANEL_BUTTON_IDS.context, TOPBAR_MORE_ID])
  useFocusReturn(showSystem, systemPanelRef, [PANEL_BUTTON_IDS.system, TOPBAR_MORE_ID])

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
