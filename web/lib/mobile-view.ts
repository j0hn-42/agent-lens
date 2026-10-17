/**
 * Mobile view (#476, #241 PR 4). Below MOBILE_BREAKPOINT the chrome takes additive branches: the top bar folds
 * behind More, every chrome control is at least 44x44 px, and an open panel is a modal drawer (focus moved in,
 * kept in by Tab, given back on close). 768 px and wider nothing changes.
 */

/** Below this viewport width the mobile branches apply. */
const MOBILE_BREAKPOINT = 768
/** Media query of the mobile view (the .98 keeps 767.5 px, a zoomed width, on the mobile side). */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`
/**
 * Classes that give a control a 44x44 px box below 768 px only (Tailwind `max-md` is `width < 48rem`, 768 px).
 * A literal string so Tailwind finds it.
 */
export const TOUCH_TARGET = 'max-md:min-h-11 max-md:min-w-11'

/** What Tab can reach inside a drawer. */
export const DRAWER_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Where Tab must send the focus to stay inside a drawer: from the last control to the first (Shift+Tab: first to
 * last), and to an end when the focus is on the drawer itself or outside it (`active` not in `items`). Null when
 * the browser's own move stays inside, or when there is nothing to focus.
 */
export function nextTrapTarget<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  if (items.length === 0) return null
  const first = items[0]
  const last = items[items.length - 1]
  const at = active === null ? -1 : items.indexOf(active)
  if (at === -1) return shift ? last : first
  if (shift && at === 0) return last
  if (!shift && at === items.length - 1) return first
  return null
}
