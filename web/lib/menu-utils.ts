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

/**
 * True when `active` sits inside a role=dialog that is not (inside) `panel`.
 * A sliding panel must not steal focus from such a dialog (e.g. the agent detail card
 * focused on mount in the same commit that opens the chat panel).
 */
export function isFocusInOtherDialog(
  active: { closest?: (selector: string) => Element | null } | null,
  panel: { contains: (node: never) => boolean } | null,
): boolean {
  if (!active || typeof active.closest !== 'function') return false
  const dialog = active.closest('[role="dialog"]')
  if (!dialog) return false
  return !(panel && panel.contains(dialog as never))
}

export const stopPropagationHandlers = {
  onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onMouseUp: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
} as const

/**
 * Same as stopPropagationHandlers but lets mousedown bubble, so useClickOutside
 * (a document mousedown listener) still closes open popups/menus when the user
 * clicks inside a sliding panel.
 */
export const panelStopPropagationHandlers = {
  onMouseUp: stopPropagationHandlers.onMouseUp,
  onClick: stopPropagationHandlers.onClick,
} as const

