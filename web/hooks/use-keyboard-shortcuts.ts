import { useEffect, useRef } from "react"
import { UNDO_SHORTCUT_KEY } from "../lib/chrome-utils"

const IGNORED_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], button, a, [role="tab"]'
const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]'

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
 * - Events from interactive widgets are left alone (Space on a button only activates the button).
 * - Space is only handled when focus is on <body> (or nothing).
 * - Single-key shortcuts require the user preference; Escape and `?` always work.
 *   Both may also fire from buttons/links/tabs (so they work after Tab navigation) but never
 *   from text fields or dialogs.
 */
export function shouldHandleShortcut(e: ShortcutEventLike, singleKeyEnabled: boolean): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  const t = (e.target ?? null) as TargetLike | null
  const isEscape = e.key === 'Escape'
  const isAlways = isEscape || e.key === '?'
  if (t) {
    if (t.isContentEditable) return false
    if (typeof t.closest === 'function' && t.closest(IGNORED_TARGET_SELECTOR)) {
      // Escape and ? may still work from buttons/links/tabs, but never from text fields or dialogs.
      if (!isAlways || t.closest(TEXT_ENTRY_SELECTOR)) return false
    }
    if (e.key === ' ' && t.tagName !== undefined && t.tagName !== 'BODY') return false
  }
  if (isAlways) return true
  return singleKeyEnabled
}

export function useKeyboardShortcuts(actions: {
  togglePlayPause: () => void
  toggleFilePanel: () => void
  toggleTranscript: () => void
  toggleTimeline: () => void
  toggleHexGrid: () => void
  toggleStats: () => void
  toggleCostOverlay: () => void
  zoomToFit: () => void
  /** Close the most recently opened panel; returns true if one was closed. */
  closeTopPanel: () => boolean
  clearSelection: () => void
  toggleMute: () => void
  setSpeed: (speed: number) => void
  /** Open the keyboard shortcuts dialog (`?`) */
  openShortcuts: () => void
  /** Run the action of the newest toast (Undo); returns true if one ran */
  undoLast: () => boolean
  singleKeyEnabled: boolean
}): void {
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const a = actionsRef.current
      if (!shouldHandleShortcut(e, a.singleKeyEnabled)) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          a.togglePlayPause()
          break
        case 'f':
          a.toggleFilePanel()
          break
        case 'F':
          a.zoomToFit()
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
          a.toggleTranscript()
          break
        case 'g':
        case 'G':
          a.toggleHexGrid()
          break
        case 's':
        case 'S':
          a.toggleStats()
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
