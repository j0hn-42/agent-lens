/**
 * Measures the UI overlaid on the canvas (top bar / tabs, bottom control bar, side panels) so the
 * camera and the cluster labels keep the content out from under it. DOM only; the classification
 * itself is the pure classifyOverlayInsets().
 */
import { classifyOverlayInsets, parsePx, NO_INSETS, type Insets, type Rect } from './camera-fit'

/** Elements that cover part of the canvas. Panels may opt in with data-canvas-inset. */
const OVERLAY_SELECTOR = [
  '[data-canvas-inset]', '[role="toolbar"]', '[role="banner"]', 'header',
  '[aria-label="Session transcript"]', '[aria-label="Files accessed by agents"]', '[aria-label="Execution timeline"]',
].join(',')

export function measureOverlayInsets(canvas: HTMLElement | null): Insets {
  if (!canvas || typeof document === 'undefined') return { ...NO_INSETS }
  const c = canvas.getBoundingClientRect()
  const canvasRect: Rect = { x: c.left, y: c.top, w: c.width, h: c.height }
  const container = canvas.closest('[data-agent-canvas-root]')
  const rects: Rect[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))) {
    if (container && container.contains(el)) continue
    if (el.contains(canvas)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height })
  }
  const insets = classifyOverlayInsets(rects, canvasRect)
  // The top bar publishes its measured height (bar + offset + breathing room)
  try {
    const topbar = parsePx(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'))
    insets.top = Math.max(insets.top, topbar - Math.max(0, canvasRect.y))
  } catch { /* no computed style */ }
  return insets
}
