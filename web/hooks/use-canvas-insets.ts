import { useRef, useCallback, type RefObject } from 'react'
import { measureOverlayInsets } from '@/components/agent-visualizer/canvas/overlay-insets'
import { safeRect, NO_INSETS, type Insets } from '@/components/agent-visualizer/canvas/camera-fit'

/**
 * Insets of the UI overlaid on the canvas (top bar / tabs, control bar, open panels): re-measured
 * every few frames and on resize, read by the camera fit and by the cluster label clamp.
 */
export function useCanvasInsets(mainCanvasRef: RefObject<HTMLCanvasElement | null>) {
  const insetsRef = useRef<Insets>({ ...NO_INSETS })
  const insetsFrameRef = useRef(0)
  const insetsSizeRef = useRef({ w: 0, h: 0 })
  const safeAreaCacheRef = useRef<{ insets: Insets; w: number; h: number; rect: ReturnType<typeof safeRect> } | null>(null)

  const getInsets = useCallback(() => insetsRef.current, [])
  const refreshInsets = useCallback(() => {
    insetsRef.current = measureOverlayInsets(mainCanvasRef.current)
  }, [mainCanvasRef])

  /**
   * Overlay insets are cached: re-measured when the canvas is resized and, for panels opening or
   * closing without a resize, once per second (DOM reads force layout, so never per frame).
   */
  const refreshInsetsIfStale = useCallback((w: number, h: number, timestamp: number) => {
    if (insetsFrameRef.current === 0 || insetsSizeRef.current.w !== w || insetsSizeRef.current.h !== h || timestamp - insetsFrameRef.current > 1000) {
      insetsFrameRef.current = timestamp || 1
      insetsSizeRef.current = { w, h }
      refreshInsets()
    }
  }, [refreshInsets])

  /** Safe area of the viewport, recomputed only when the insets or the viewport change (not per frame) */
  const getSafeArea = useCallback((w: number, h: number) => {
    const c = safeAreaCacheRef.current
    const i = insetsRef.current
    if (c && c.insets === i && c.w === w && c.h === h) return c.rect
    const rect = safeRect({ width: w, height: h }, i)
    safeAreaCacheRef.current = { insets: i, w, h, rect }
    return rect
  }, [])

  return { getInsets, getSafeArea, refreshInsetsIfStale }
}
