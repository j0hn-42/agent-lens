import { useEffect, useRef } from "react"
import { UNDO_SHORTCUT_KEY } from "../lib/chrome-utils"

const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]'
const ACTIVATABLE_SELECTOR = 'button, a, [role="tab"]'

/** Minimal structural view of a keyboard event, so the filter is testable without a DOM. */
export interface ShortcutEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  target: unknown
}

interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/**
 * Pure decision: should this keydown trigger a shortcut?
 * - Ctrl/Meta/Alt combos are never ours (browser/OS shortcuts, WCAG 2.1.4).
 * - Text fields, selects, editable regions and dialogs are never ours.
 * - Buttons, links and tabs let letters through: Escape gives the focus back to the button that
 *   opened a panel, and shortcuts must keep working from there (#376). Space and Enter stay with
 *   the focused control (they activate it); Space is only ours on <body> (or nothing).
 * - Every shortcut but Escape, including `?`, follows the single-key preference (WCAG 2.1.4).
 */
export function shouldHandleShortcut(
  e: ShortcutEventLike,
  singleKeyEnabled: boolean,
  _opts: { undoAvailable?: boolean } = {},
): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  const t = (e.target ?? null) as TargetLike | null
  if (t) {
    if (t.isContentEditable) return false
    if (typeof t.closest === 'function') {
      if (t.closest(TEXT_ENTRY_SELECTOR)) return false
      if ((e.key === ' ' || e.key === 'Enter') && t.closest(ACTIVATABLE_SELECTOR)) return false
    }
    if (e.key === ' ' && t.tagName !== undefined && t.tagName !== 'BODY') return false
  }
  if (e.key === 'Escape') return true
  return singleKeyEnabled
}

/**
 * Ctrl+K / Cmd+K opens the command palette (#243). It is a modifier combo, so it is not a single-key
 * shortcut (WCAG 2.1.4) and works whatever that preference says. It is offered from text fields and
 * buttons (the usual place to be when reaching for it) but not from inside another dialog, whose focus
 * trap the palette would break.
 */
export function isPaletteShortcut(e: ShortcutEventLike & { shiftKey: boolean }): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || (!e.ctrlKey && !e.metaKey)) return false
  const t = (e.target ?? null) as TargetLike | null
  return !(t && typeof t.closest === 'function' && t.closest('[role="dialog"]'))
}

export function useKeyboardShortcuts(actions: {
  togglePlayPause: () => void
  toggleFilePanel: () => void
  toggleSessionList: () => void
  toggleConversation: () => void
  toggleTimeline: () => void
  toggleHexGrid: () => void
  toggleStats: () => void
  toggleContext: () => void
  toggleSystem: () => void
  toggleCostOverlay: () => void
  zoomToFit: () => void
  /** Enter / leave immersive full screen (`Z`) */
  toggleFullscreen: () => void
  /** Start / stop presentation mode (`V`) */
  togglePresentation: () => void
  /** Close the most recently opened panel; returns true if one was closed. */
  closeTopPanel: () => boolean
  clearSelection: () => void
  toggleMute: () => void
  setSpeed: (speed: number) => void
  /** Open the keyboard shortcuts dialog (`?`) */
  openShortcuts: () => void
  /** Open the command palette (`Ctrl+K` / `Cmd+K`) */
  openPalette?: () => void
  /** Run the action of the newest toast (Undo); returns true if one ran */
  undoLast: () => boolean
  /** True while a visible toast has an Undo action (lets U fire from buttons and tabs) */
  canUndo?: () => boolean
  singleKeyEnabled: boolean
}): void {
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const a = actionsRef.current
      if (a.openPalette && isPaletteShortcut(e)) {
        e.preventDefault()
        a.openPalette()
        return
      }
      if (!shouldHandleShortcut(e, a.singleKeyEnabled, { undoAvailable: a.canUndo?.() ?? false })) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          a.togglePlayPause()
          break
        case 'f':
        case 'F':
          // Caps Lock flips the case of `key` but not shiftKey: Shift decides, not the letter's case.
          if (e.shiftKey) a.zoomToFit()
          else a.toggleFilePanel()
          break
        case 'l':
        case 'L':
          a.toggleSessionList()
          break
        case 'z':
        case 'Z':
          a.toggleFullscreen()
          break
        case 'v':
        case 'V':
          a.togglePresentation()
          break
        case 't':
        case 'T':
          a.toggleTimeline()
          break
        case 'Escape':
          if (!a.closeTopPanel()) a.clearSelection()
          break
        case 'c':
        case 'C':
          a.toggleConversation()
          break
        case 'g':
        case 'G':
          a.toggleHexGrid()
          break
        case 'p':
        case 'P':
          a.toggleContext()
          break
        case 's':
        case 'S':
          a.toggleStats()
          break
        case 'y':
        case 'Y':
          a.toggleSystem()
          break
        case '$':
          a.toggleCostOverlay()
          break
        case 'm':
        case 'M':
          a.toggleMute()
          break
        case '?':
          e.preventDefault()
          a.openShortcuts()
          break
        case UNDO_SHORTCUT_KEY:
        case UNDO_SHORTCUT_KEY.toUpperCase():
          a.undoLast()
          break
        case '1': a.setSpeed(0.5); break
        case '2': a.setSpeed(1); break
        case '3': a.setSpeed(2); break
        case '4': a.setSpeed(4); break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
