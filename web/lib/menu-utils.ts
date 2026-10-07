/** Pure helpers shared by dialogs, menus and panels (kept DOM-free so they can be unit-tested). */

/**
 * Focus-trap decision for a Tab keypress inside a modal dialog.
 * `activeIndex` is the index of the focused element among the dialog's focusables
 * (-1 when focus is on the container itself or outside). Returns which end to wrap to,
 * or null when the browser's default Tab behaviour is correct.
 */
export function nextTrapTarget(
  activeIndex: number,
  count: number,
  shiftKey: boolean,
): 'first' | 'last' | null {
  if (count <= 0) return 'first' // nothing focusable: keep focus on the container
  if (activeIndex < 0) return shiftKey ? 'last' : 'first'
  if (shiftKey && activeIndex === 0) return 'last'
  if (!shiftKey && activeIndex === count - 1) return 'first'
  return null
}

/** Messages the user has not seen yet; `seen` is clamped so a shrinking list never goes negative. */
export function unseenCount(total: number, seen: number): number {
  return Math.max(0, total - Math.min(seen, total))
}

/** Seen counter after the list length changes (resets down when the conversation shrinks). */
export function clampSeen(seen: number, total: number): number {
  return Math.min(seen, Math.max(0, total))
}
