import { useRef, useEffect, useState, useCallback, type ChangeEvent } from 'react'
import {
  ANIM_PAUSE_KEY, NEVER_HIDE_KEY, TOOL_EXPIRY_CHOICES_S, loadToolExpiryS, setToolExpiryS,
} from '@/lib/canvas-constants'

function readStoredFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}
function writeStoredFlag(key: string, value: boolean): void {
  try { window.localStorage.setItem(key, value ? '1' : '0') } catch { /* storage unavailable */ }
}

/**
 * Motion and comfort preferences of the canvas: OS reduced motion (read once + change listener) OR the
 * visible "Pause animations" toggle, "Keep cards visible" and the tool-call expiry. The refs mirror the
 * state for the draw loop.
 */
export function useCanvasPreferences() {
  const [osReducedMotion, setOsReducedMotion] = useState(false)
  const [animationsPaused, setAnimationsPaused] = useState(false)
  const [neverHide, setNeverHide] = useState(false)
  const [toolExpiryS, setToolExpiryState] = useState<number>(TOOL_EXPIRY_CHOICES_S[2])
  const reducedMotionRef = useRef(false)
  reducedMotionRef.current = osReducedMotion || animationsPaused
  const animationsPausedRef = useRef(false)
  animationsPausedRef.current = animationsPaused
  const neverHideRef = useRef(false)
  neverHideRef.current = neverHide

  useEffect(() => {
    // Stored preferences are read after mount so server and first client render match
    setAnimationsPaused(readStoredFlag(ANIM_PAUSE_KEY))
    setNeverHide(readStoredFlag(NEVER_HIDE_KEY))
    setToolExpiryState(loadToolExpiryS())
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setOsReducedMotion(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setOsReducedMotion(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const toggleAnimationsPaused = useCallback(() => {
    setAnimationsPaused(prev => { writeStoredFlag(ANIM_PAUSE_KEY, !prev); return !prev })
  }, [])
  const toggleNeverHide = useCallback(() => {
    setNeverHide(prev => { writeStoredFlag(NEVER_HIDE_KEY, !prev); return !prev })
  }, [])

  const changeToolExpiry = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setToolExpiryState(setToolExpiryS(Number(e.target.value)))
  }, [])

  return {
    animationsPaused, neverHide, toolExpiryS,
    pausedBySystem: osReducedMotion,
    reducedMotionRef, animationsPausedRef, neverHideRef,
    toggleAnimationsPaused, toggleNeverHide, changeToolExpiry,
  }
}
