import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Immersive mode: the browser's fullscreen plus the app chrome hidden (top bar and control strip).
 * Where the Fullscreen API is missing (iOS Safari, some embedded webviews) it degrades to hiding the chrome only.
 * Leaving browser fullscreen by any route (Esc, F11, the browser UI) also leaves immersive mode.
 */
export function useFullscreen(): { immersive: boolean; toggle: () => void } {
  const [immersive, setImmersive] = useState(false)
  // True when this hook put the document into fullscreen, so an external exit can be told apart from never having entered
  const enteredRef = useRef(false)

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && enteredRef.current) {
        enteredRef.current = false
        setImmersive(false)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggle = useCallback(() => {
    if (immersive) {
      setImmersive(false)
      if (enteredRef.current && document.fullscreenElement) {
        enteredRef.current = false
        document.exitFullscreen().catch(() => {})
      }
      return
    }
    setImmersive(true)
    const root = document.documentElement
    if (typeof root.requestFullscreen === 'function') {
      // Denied (no user gesture, iframe policy): the chrome stays hidden, the browser stays windowed
      root.requestFullscreen().then(() => { enteredRef.current = true }).catch(() => {})
    }
  }, [immersive])

  return { immersive, toggle }
}
