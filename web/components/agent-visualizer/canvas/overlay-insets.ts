/**
 * Measures the UI overlaid on the canvas (top bar / tabs, bottom control bar, side panels) so the
 * camera and the cluster labels keep the content out from under it. DOM only; the classification
 * itself is the pure classifyOverlayInsets().
 */
import { classifyOverlayInsets, parsePx, NO_INSETS, type Insets, type OverlayRect, type Rect } from './camera-fit'

/** Elements counted as bars by ROLE (not by width ratio): the control bar, toolbars, the top bar. */
const BAR_SELECTOR = '[role="toolbar"], [role="banner"], header'

const EDGES = ['top', 'right', 'bottom', 'left'] as const

/**
 * Role of an overlay element. A panel opts in with data-canvas-inset: "top" | "right" | "bottom" |
 * "left" reserves that edge whatever its size; an empty / "auto" / unknown value lets its shape decide
 * (the same as an untagged panel). Toolbars, banners and headers are bars.
 */
export function overlayRoleOf(el: Pick<Element, 'getAttribute' | 'matches'>): Pick<OverlayRect, 'edge' | 'bar'> {
  const attr = el.getAttribute('data-canvas-inset')
  const edge = EDGES.find(e => e === attr?.trim().toLowerCase())
  if (edge) return { edge }
  return { bar: el.matches(BAR_SELECTOR) }
}

/** Elements that cover part of the canvas. Panels may opt in with data-canvas-inset. */
const OVERLAY_SELECTOR = [
  '[data-canvas-inset]', '[role="toolbar"]', '[role="banner"]', 'header',
  '[aria-label="Session transcript"]', '[aria-label="Files accessed by agents"]', '[aria-label="Execution timeline"]',
].join(',')

export function measureOverlayInsets(canvas: HTMLElement | null, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Insets {
  if (!canvas || !doc) return { ...NO_INSETS }
  const c = canvas.getBoundingClientRect()
  const canvasRect: Rect = { x: c.left, y: c.top, w: c.width, h: c.height }
  const container = canvas.closest('[data-agent-canvas-root]')
  const rects: OverlayRect[] = []
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))) {
    if (container && container.contains(el)) continue
    if (el.contains(canvas)) continue
    // A header / toolbar nested in another overlay panel is part of that panel, not a bar of its own
    const outer = el.parentElement?.closest(OVERLAY_SELECTOR)
    if (outer && !outer.contains(canvas)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, ...overlayRoleOf(el) })
  }
  const insets = classifyOverlayInsets(rects, canvasRect)
  // The top bar publishes its measured height (bar + offset + breathing room)
  try {
    const topbar = parsePx((doc.defaultView ?? window).getComputedStyle(doc.documentElement).getPropertyValue('--topbar-h'))
    insets.top = Math.max(insets.top, topbar - Math.max(0, canvasRect.y))
  } catch { /* no computed style */ }
  return insets
}
