import { useRef, useEffect, useState, useCallback, useMemo, type ChangeEvent } from 'react'
import { setToolExpiryS } from '@/lib/canvas-constants'
import { allLayersCalm, toggleCalmLayer, type CalmLayers, type MotionLayer } from '@/lib/motion-layers'
import { useLocale } from '@/lib/locale'
import { useUiPreferences } from '@/hooks/use-ui-preferences'
import type { UiPrefKey } from '@/lib/ui-preferences'

/** Field of the preference blob that holds each layer's choice (#372) */
const CALM_PREF: Readonly<Record<MotionLayer, UiPrefKey & `calm${string}`>> = {
  background: 'calmBackground', links: 'calmLinks', agents: 'calmAgents', effects: 'calmEffects',
}

/**
 * Motion and comfort preferences of the canvas: OS reduced motion (read once + change listener) OR the
 * visible "Freeze motion" toggle, "Pin cards" and the tool-call expiry. The View menu choices live in the
 * preference blob (#372: one store, reset by 'Reset preferences'). The refs mirror the state for the draw loop.
 */
export function useCanvasPreferences() {
  const { prefs, setPref } = useUiPreferences()
  const [osReducedMotion, setOsReducedMotion] = useState(false)
  const animationsPaused = prefs.freezeMotion
  const neverHide = prefs.pinCards
  const toolExpiryS = prefs.toolExpiryS
  const { calmBackground, calmLinks, calmAgents, calmEffects } = prefs
  const calmLayers = useMemo<CalmLayers>(
    () => ({ background: calmBackground, links: calmLinks, agents: calmAgents, effects: calmEffects }),
    [calmBackground, calmLinks, calmAgents, calmEffects],
  )
  const { locale } = useLocale()
  const reducedMotionRef = useRef(false)
  // All four layers calm is the same as reduced motion: the clock freezes and the gate slows down
  reducedMotionRef.current = osReducedMotion || animationsPaused || allLayersCalm(calmLayers)
  const globalReducedRef = useRef(false)
  globalReducedRef.current = osReducedMotion || animationsPaused
  const calmLayersRef = useRef<CalmLayers>(calmLayers)
  calmLayersRef.current = calmLayers
  const animationsPausedRef = useRef(false)
  animationsPausedRef.current = animationsPaused
  const neverHideRef = useRef(false)
  neverHideRef.current = neverHide

  // The simulation reads the expiry from a live setting on each frame and each seek
  useEffect(() => { setToolExpiryS(toolExpiryS) }, [toolExpiryS])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setOsReducedMotion(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setOsReducedMotion(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const toggleAnimationsPaused = useCallback(() => {
    setPref('freezeMotion', !animationsPausedRef.current)
  }, [setPref])
  const toggleCalmLayerPref = useCallback((layer: MotionLayer) => {
    const next = toggleCalmLayer(calmLayersRef.current, layer)
    setPref(CALM_PREF[layer], next[layer])
  }, [setPref])
  const toggleNeverHide = useCallback(() => {
    setPref('pinCards', !neverHideRef.current)
  }, [setPref])

  const changeToolExpiry = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setPref('toolExpiryS', setToolExpiryS(Number(e.target.value)))
  }, [setPref])

  return {
    animationsPaused, neverHide, toolExpiryS,
    pausedBySystem: osReducedMotion,
    calmLayers, locale, calmLayersRef, globalReducedRef, toggleCalmLayer: toggleCalmLayerPref,
    reducedMotionRef, animationsPausedRef, neverHideRef,
    toggleAnimationsPaused, toggleNeverHide, changeToolExpiry,
  }
}
