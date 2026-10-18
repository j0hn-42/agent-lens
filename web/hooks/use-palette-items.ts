'use client'

import { useMemo } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import type { usePanelsState } from '@/hooks/use-panels-state'
import type { NotifyState } from '@/hooks/use-attention-alerts'
import { buildPaletteItems } from '@/lib/command-palette'
import { sessionAttentionLabel } from '@/lib/card-text'
import { useLocale } from '@/lib/locale'
import { translate, type Locale } from '@/lib/messages'
import { agentRoleOf } from '@/lib/issue-links'
import { isUnionSelection } from '@/lib/bridge-types'
import { useTheme } from '@/lib/theme'
import { THEME_IDS, THEME_LABELS, isThemeId } from '@/lib/theme-tokens'
import { type SettingsTab } from '@/lib/settings-tabs'

type Bridge = ReturnType<typeof useVSCodeBridge>
type Panels = ReturnType<typeof usePanelsState>

/** The names the theme select gives (Settings > Appearance): proper names stay, High contrast is translated; the English name stays searchable */
const themeOptions = (locale: Locale) => THEME_IDS.map(id => id === 'contrast'
  ? { id, label: translate(locale, 'theme.contrast'), alias: THEME_LABELS[id] }
  : { id, label: THEME_LABELS[id] })

interface PaletteInput {
  open: boolean
  singleKeyEnabled: boolean
  bridge: Pick<Bridge, 'selectedSessionId' | 'sessions' | 'selectSession' | 'useMockData' | 'launch' | 'relayOrigin'>
  /** The agents the sessions list shows */
  listAgents: ReturnType<typeof useAgentSimulation>['agents']
  panels: Pick<Panels, 'setShowSessions' | 'setShowTimeline' | 'setShowStats' | 'setShowSystem' | 'setShowHexGrid' | 'toggleExclusivePanel'>
  selectAgent: (agentId: string | null) => void
  actions: {
    togglePlayPause: () => void; zoomToFit: () => void; toggleFullscreen: () => void; toggleMute: () => void; openShortcuts: () => void; openSettings: () => void
    /** Opens Settings on one of its tabs (#533) */
    openSettingsTab: (tab: SettingsTab) => void
    /** The tabs the dialog shows (visibleSettingsTabs), so no command opens a tab that is absent */
    settingsTabs: readonly SettingsTab[]
    togglePresentation: () => void; clearHistory: () => void
  }
  /** Session export (#237): the same checks as the Sessions panel button */
  exportSession: { can: (id: string) => boolean; run: (id: string) => void }
  /** The tour button of the legend: absent while no tour can start */
  tour: { start?: () => void; label?: string }
  /** The top bar counter (#126) and its jump to the next blocked agent (#377) */
  attention: { waiting: number; errors: number; jump: () => void; nextInView: () => boolean }
  notify: { state: NotifyState; toggle: () => void }
}

/** Command palette (#243): built only while it is open, from the lists the panels already show */
export function usePaletteItems({ open, singleKeyEnabled, bridge, listAgents, panels, selectAgent, actions, exportSession, tour, attention, notify }: PaletteInput) {
  const { setShowSessions, setShowTimeline, setShowStats, setShowSystem, setShowHexGrid, toggleExclusivePanel } = panels
  const { togglePlayPause, zoomToFit, toggleFullscreen, toggleMute, openShortcuts, openSettings, openSettingsTab, settingsTabs, togglePresentation, clearHistory } = actions
  const [theme, setTheme] = useTheme()
  const { locale } = useLocale()
  const { waiting, errors, jump, nextInView } = attention
  const { start: startTour, label: tourLabel } = tour
  const { can: canExport, run: runExport } = exportSession
  const { state: notifyState, toggle: toggleNotify } = notify
  return useMemo(() => {
    if (!open) return []
    const sessionId = bridge.selectedSessionId
    // One real session whose events are in memory: never the demo, a union view or an empty session
    const exportable = !bridge.useMockData && sessionId && !isUnionSelection(sessionId) && canExport(sessionId) ? sessionId : null
    // The counter text of the top bar, in the language of the palette (same numbers, same conditions)
    const attentionText = sessionAttentionLabel(locale, { waiting, errors })
    // The agent card offers its Launch buttons under the same two conditions (selection-overlays, agent-detail-card)
    const launchAvailable = bridge.launch !== null && bridge.relayOrigin !== null
    return buildPaletteItems({
      locale,
      singleKeyEnabled,
      selectedSessionId: sessionId,
      sessions: bridge.sessions,
      agents: launchAvailable ? Array.from(listAgents.values(), a => ({ ...a, role: agentRoleOf(a) })) : listAgents.values(),
      launchAvailable,
      actions: {
        togglePlayPause,
        zoomToFit,
        toggleFullscreen,
        toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
        toggleMute,
        openShortcuts,
        openSettings,
        togglePresentation,
        clearHistory,
        exportSession: exportable ? () => runExport(exportable) : undefined,
      },
      attention: attentionText ? { detail: attentionText, movesFocus: nextInView(), run: jump } : undefined,
      settingsTabs: { tabs: settingsTabs, open: openSettingsTab },
      tour: startTour ? { label: tourLabel ?? 'Guided tour', run: startTour } : undefined,
      notifications: notifyState === 'on' || notifyState === 'off' ? { on: notifyState === 'on', run: toggleNotify } : undefined,
      themes: { current: theme, options: themeOptions(locale), set: id => { if (isThemeId(id)) setTheme(id) } },
      togglePanel: panel => {
        if (panel === 'sessions') setShowSessions(prev => !prev)
        else if (panel === 'timeline') setShowTimeline(prev => !prev)
        else if (panel === 'stats') setShowStats(prev => !prev)
        else if (panel === 'system') setShowSystem(prev => !prev)
        else toggleExclusivePanel(panel)
      },
      selectSession: bridge.selectSession,
      selectAgent,
    })
  }, [open, singleKeyEnabled, bridge.selectedSessionId, bridge.sessions, bridge.selectSession, bridge.useMockData, bridge.launch, bridge.relayOrigin, listAgents, togglePlayPause, zoomToFit, toggleFullscreen,
    setShowHexGrid, toggleMute, openShortcuts, openSettings, openSettingsTab, settingsTabs, togglePresentation, clearHistory, canExport, runExport, waiting, errors, jump, nextInView,
    startTour, tourLabel, locale, notifyState, toggleNotify, theme, setTheme, setShowSessions, setShowTimeline, setShowStats, setShowSystem, toggleExclusivePanel, selectAgent])
}
