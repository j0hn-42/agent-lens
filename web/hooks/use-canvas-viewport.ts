import { useRef, useEffect, useState } from 'react'

/**
 * Size + devicePixelRatio tracking of the canvas container. The ratio changes with browser zoom and
 * when the window moves between screens, so it is re-read on resize, via the observer, and on the
 * resolution media query (which fires when the ratio changes). The draw loop resizes the
 * backing store (and the bloom buffers) whenever it no longer matches.
 */
export function useCanvasViewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const dprRef = useRef(1)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    dprRef.current = window.devicePixelRatio || 1
    const observer = new ResizeObserver((entries) => {
      dprRef.current = window.devicePixelRatio || 1
      for (const entry of entries) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(container)

    let mql: MediaQueryList | null = null
    const onDprChange = () => {
      dprRef.current = window.devicePixelRatio || 1
      watchResolution()
    }
    const watchResolution = () => {
      mql?.removeEventListener('change', onDprChange)
      if (typeof window.matchMedia !== 'function') return
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', onDprChange)
    }
    watchResolution()
    window.addEventListener('resize', onDprChange)

    return () => {
      observer.disconnect()
      mql?.removeEventListener('change', onDprChange)
      window.removeEventListener('resize', onDprChange)
    }
  }, [])

  return { containerRef, dimensions, dprRef }
}
