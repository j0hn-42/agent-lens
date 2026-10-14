'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useFullscreen } from '@/hooks/use-fullscreen'
import { usePresentationMode, usePresentationMaskAttribute, usePresentationSubtitle } from '@/hooks/use-presentation'
import { FULLSCREEN_BUTTON_ID } from '@/components/agent-visualizer/top-bar'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'

/**
 * The two modes that take over the page chrome: full screen and presentation (#245).
 * Escape peels them off in order: the newest panel, then immersive mode, then the presentation.
 * @param closeTopPanel closes the newest open panel; false when none was open
 */
export function useChromeModes(agents: ReturnType<typeof useAgentSimulation>['agents'], closeTopPanel: () => boolean) {
  const { immersive, toggle: toggleFullscreen } = useFullscreen()
  // Escape closes panels first; with none open it leaves a chrome-only immersive mode (no Fullscreen API: nothing else would)
  const closeTopPanelOrImmersive = useCallback((): boolean => {
    if (closeTopPanel()) return true
    if (immersive && !document.fullscreenElement) { toggleFullscreen(); return true }
    return false
  }, [closeTopPanel, immersive, toggleFullscreen])
  // Focus follows the chrome that disappears (#196) and the change is announced
  const exitFullscreenRef = useRef<HTMLButtonElement>(null)
  const wasImmersiveRef = useRef(false)
  const [fullscreenNote, setFullscreenNote] = useState<string | null>(null)
  useEffect(() => {
    if (immersive === wasImmersiveRef.current) return
    wasImmersiveRef.current = immersive
    setFullscreenNote(immersive ? 'Full screen on' : 'Full screen off')
    if (immersive) exitFullscreenRef.current?.focus()
    else document.getElementById(FULLSCREEN_BUTTON_ID)?.focus()
  }, [immersive])

  // Presentation mode (#245): options persist, the mode does not. Escape stops it once nothing else is open.
  const presentation = usePresentationMode()
  const presentationOn = presentation.active
  const presentationMasked = presentationOn && presentation.options.mask
  usePresentationMaskAttribute(presentationMasked)
  const presentationSubtitle = usePresentationSubtitle(agents, { enabled: presentationOn && presentation.options.subtitles, mask: presentation.options.mask })
  const wasPresentingRef = useRef(false)
  const [presentationNote, setPresentationNote] = useState<string | null>(null)
  useEffect(() => {
    if (presentationOn === wasPresentingRef.current) return
    wasPresentingRef.current = presentationOn
    setPresentationNote(presentationOn ? 'Presentation mode on' : 'Presentation mode off')
  }, [presentationOn])
  const stopPresentation = presentation.stop
  const closeTopPanelOrImmersiveOrPresentation = useCallback((): boolean => {
    if (closeTopPanelOrImmersive()) return true
    if (presentationOn) { stopPresentation(); return true }
    return false
  }, [closeTopPanelOrImmersive, presentationOn, stopPresentation])

  return {
    immersive, toggleFullscreen, exitFullscreenRef, fullscreenNote,
    presentation, presentationOn, presentationMasked, presentationSubtitle, presentationNote,
    closeTopPanelOrImmersiveOrPresentation,
  }
}
