'use client'

import { useCallback, useState } from 'react'
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from '@/lib/settings-tabs'

/**
 * Open state of the three modal dialogs: keyboard shortcuts, settings, command palette.
 * The Settings tab (#533) is kept here, in memory, for as long as the page lives: reopening Settings shows the last tab,
 * and nothing about it is stored (not in the agent-lens:ui-prefs blob, so 'Reset preferences' has nothing to reset).
 */
export function useDialogsState() {
  const [showShortcuts, setShowShortcuts] = useState(false)
  const openShortcuts = useCallback(() => setShowShortcuts(true), [])
  const closeShortcuts = useCallback(() => setShowShortcuts(false), [])
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(DEFAULT_SETTINGS_TAB)
  // Takes no argument on purpose: it is also a click handler (the gear button), whose event must not pick a tab
  const openSettings = useCallback(() => setShowSettings(true), [])
  /** Opens Settings on a given tab (the palette's "Settings: <tab>" commands) */
  const openSettingsTab = useCallback((tab: SettingsTab) => { setSettingsTab(tab); setShowSettings(true) }, [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const [showPalette, setShowPalette] = useState(false)
  const openPalette = useCallback(() => setShowPalette(true), [])
  const closePalette = useCallback(() => setShowPalette(false), [])
  return {
    showShortcuts, openShortcuts, closeShortcuts,
    showSettings, openSettings, openSettingsTab, closeSettings, settingsTab, setSettingsTab,
    showPalette, openPalette, closePalette,
  }
}
