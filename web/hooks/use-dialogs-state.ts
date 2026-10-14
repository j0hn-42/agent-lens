'use client'

import { useCallback, useState } from 'react'

/** Open state of the three modal dialogs: keyboard shortcuts, settings, command palette */
export function useDialogsState() {
  const [showShortcuts, setShowShortcuts] = useState(false)
  const openShortcuts = useCallback(() => setShowShortcuts(true), [])
  const closeShortcuts = useCallback(() => setShowShortcuts(false), [])
  const [showSettings, setShowSettings] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const [showPalette, setShowPalette] = useState(false)
  const openPalette = useCallback(() => setShowPalette(true), [])
  const closePalette = useCallback(() => setShowPalette(false), [])
  return { showShortcuts, openShortcuts, closeShortcuts, showSettings, openSettings, closeSettings, showPalette, openPalette, closePalette }
}
