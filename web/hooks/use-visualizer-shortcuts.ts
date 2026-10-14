'use client'

import { useMemo } from 'react'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import type { usePanelsState } from '@/hooks/use-panels-state'
import type { useChromeModes } from '@/hooks/use-chrome-modes'

type Panels = ReturnType<typeof usePanelsState>
type Modes = ReturnType<typeof useChromeModes>

interface ShortcutsInput {
  panels: Pick<Panels, 'setShowSessions' | 'setShowTimeline' | 'setShowHexGrid' | 'setShowStats' | 'setShowSystem' | 'toggleExclusivePanel'>
  modes: Pick<Modes, 'toggleFullscreen' | 'presentation' | 'closeTopPanelOrImmersiveOrPresentation'>
  clearSelection: () => void
  togglePlayPause: () => void
  zoomToFit: () => void
  toggleMute: () => void
  setSpeed: (value: number) => void
  openShortcuts: () => void
  openPalette: () => void
  undoLast: () => boolean
  openSettings: () => void
  singleKeyEnabled: boolean
}

/** Global keyboard shortcuts: what each key does in the visualizer */
export function useVisualizerShortcuts(input: ShortcutsInput) {
  const { panels, modes, clearSelection, togglePlayPause, zoomToFit, toggleMute, setSpeed, openShortcuts, openPalette, openSettings, undoLast, singleKeyEnabled } = input
  const { setShowSessions, setShowTimeline, setShowHexGrid, setShowStats, setShowSystem, toggleExclusivePanel } = panels
  const { toggleFullscreen, closeTopPanelOrImmersiveOrPresentation } = modes
  const togglePresentation = modes.presentation.toggle
  const actions = useMemo(() => ({
    togglePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleSessionList: () => { setShowSessions(prev => !prev) },
    toggleConversation: () => toggleExclusivePanel('conversation'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleContext: () => toggleExclusivePanel('context'),
    toggleSystem: () => { setShowSystem(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit,
    toggleFullscreen,
    togglePresentation,
    closeTopPanel: closeTopPanelOrImmersiveOrPresentation,
    clearSelection,
    toggleMute,
    setSpeed,
    openShortcuts,
    openPalette,
    undoLast,
    openSettings,
    singleKeyEnabled,
  }), [openShortcuts, openPalette, openSettings, undoLast, togglePlayPause, clearSelection, setSpeed, toggleMute, toggleExclusivePanel, closeTopPanelOrImmersiveOrPresentation,
    toggleFullscreen, togglePresentation, singleKeyEnabled, zoomToFit, setShowSessions, setShowTimeline, setShowHexGrid, setShowStats, setShowSystem])

  useKeyboardShortcuts(actions)
}
