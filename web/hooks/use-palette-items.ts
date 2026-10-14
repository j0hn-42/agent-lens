'use client'

import { useMemo } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import type { usePanelsState } from '@/hooks/use-panels-state'
import { buildPaletteItems } from '@/lib/command-palette'

type Bridge = ReturnType<typeof useVSCodeBridge>
type Panels = ReturnType<typeof usePanelsState>

interface PaletteInput {
  open: boolean
  singleKeyEnabled: boolean
  bridge: Pick<Bridge, 'selectedSessionId' | 'sessions' | 'selectSession'>
  /** The agents the sessions list shows */
  listAgents: ReturnType<typeof useAgentSimulation>['agents']
  panels: Pick<Panels, 'setShowSessions' | 'setShowTimeline' | 'setShowStats' | 'setShowSystem' | 'setShowHexGrid' | 'toggleExclusivePanel'>
  selectAgent: (agentId: string | null) => void
  actions: { togglePlayPause: () => void; zoomToFit: () => void; toggleFullscreen: () => void; toggleMute: () => void; openShortcuts: () => void; openSettings: () => void }
}

/** Command palette (#243): built only while it is open, from the lists the panels already show */
export function usePaletteItems({ open, singleKeyEnabled, bridge, listAgents, panels, selectAgent, actions }: PaletteInput) {
  const { setShowSessions, setShowTimeline, setShowStats, setShowSystem, setShowHexGrid, toggleExclusivePanel } = panels
  const { togglePlayPause, zoomToFit, toggleFullscreen, toggleMute, openShortcuts, openSettings } = actions
  return useMemo(() => {
    if (!open) return []
    return buildPaletteItems({
      singleKeyEnabled,
      selectedSessionId: bridge.selectedSessionId,
      sessions: bridge.sessions,
      agents: listAgents.values(),
      actions: {
        togglePlayPause,
        zoomToFit,
        toggleFullscreen,
        toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
        toggleMute,
        openShortcuts,
        openSettings,
      },
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
  }, [open, singleKeyEnabled, bridge.selectedSessionId, bridge.sessions, bridge.selectSession, listAgents, togglePlayPause, zoomToFit, toggleFullscreen,
    setShowHexGrid, toggleMute, openShortcuts, openSettings, setShowSessions, setShowTimeline, setShowStats, setShowSystem, toggleExclusivePanel, selectAgent])
}
