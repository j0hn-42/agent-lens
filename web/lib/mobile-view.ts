/**
 * Mobile view (#476, #241 PR 4). Below MOBILE_BREAKPOINT the chrome takes additive branches: the top bar folds
 * behind More, every chrome control is at least 44x44 px, and an open panel is a drawer (focus moved in,
 * kept in by Tab with the surfaces drawn above it, given back on close). 768 px and wider nothing changes.
 */

/** Below this viewport width the mobile branches apply. */
const MOBILE_BREAKPOINT = 768
/** Media query of the mobile view (the .98 keeps 767.5 px, a zoomed width, on the mobile side). */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`
/** Side (px) of the touch target below 768 px; what TOUCH_TARGET gives the DOM controls, for the canvas zones. */
export const TOUCH_TARGET_PX = 44
/**
 * Classes that give a control a 44x44 px box below 768 px only (Tailwind `max-md` is `width < 48rem`, 768 px).
 * A literal string so Tailwind finds it.
 */
export const TOUCH_TARGET = 'max-md:min-h-11 max-md:min-w-11'

/** Surfaces drawn above a drawer that share its Tab cycle: the permission cards (#410) and the truncation notice (#453). */
export const DRAWER_COMPANIONS = '[data-permission-requests], [data-truncation-banner]'

/** What Tab can reach inside a drawer. */
export const DRAWER_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Where Tab must send the focus to stay in a drawer's cycle. `segments` are the Tab stops of each surface of the
 * cycle in order (the surfaces drawn above the drawer, then the drawer); empty ones are skipped. From the last stop
 * of a segment Tab goes to the first of the next one, from the very last to the very first (Shift+Tab: the
 * reverse), and to an end when the focus is on none of them. Null when the browser's own move stays inside the
 * segment, or when there is nothing to focus.
 */
export function nextTrapTarget<T>(segments: ReadonlyArray<readonly T[]>, active: T | null, shift: boolean): T | null {
  const parts = segments.filter(p => p.length > 0)
  const items = parts.flat()
  if (items.length === 0) return null
  const at = active === null ? -1 : items.indexOf(active)
  if (at === -1) return shift ? items[items.length - 1] : items[0]
  const part = parts.find(p => p.includes(active as T))!
  const edge = shift ? part[0] === active : part[part.length - 1] === active
  if (!edge) return null
  return items[(at + (shift ? -1 : 1) + items.length) % items.length]
}
