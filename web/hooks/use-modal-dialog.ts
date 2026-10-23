import { useCallback, useEffect, useRef, type RefObject } from 'react'

/** What a modal dialog's Tab trap looks for; `modalTabStops` then keeps only what Tab can reach */
const MODAL_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])'

/** The Tab stops of a dialog, in document order: not the tabindex -1 ones (unselected tabs) nor the controls of hidden panels */
export function modalTabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE)).filter(n => n.tabIndex >= 0 && !n.closest('[hidden]'))
}

/** The part of a keydown the trap reads: a native KeyboardEvent and a React one both fit */
export type ModalKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>

export interface ModalDialogOptions {
  /** Whether the dialog is shown (a dialog mounted only while open passes true once it has rendered) */
  open: boolean
  /** The role="dialog" element (tabIndex -1): the trap's bounds, and the initial focus when `initialFocus` gives nothing */
  dialogRef: RefObject<HTMLElement | null>
  /** Escape closes the dialog through this */
  onClose: () => void
  /** The element focused on open; read once per opening. The dialog container itself by default. */
  initialFocus?: () => HTMLElement | null | undefined
  /**
   * 'wrap' (default): Tab on the last stop goes to the first, Shift+Tab on the first (or on the container) to the last.
   * 'hold': the dialog has a single stop (the command palette's search field, its options are reached with the arrows), so
   * Tab never moves the focus, wherever it is in the dialog.
   */
  tab?: 'wrap' | 'hold'
  /**
   * Called on Escape before closing; returns true when it used the key for something else (the launch dialog cancels a
   * pending stop confirmation instead of closing). Escape is consumed either way.
   */
  onEscape?: () => boolean
  /** Read on close: false leaves the focus where it is (a palette command that moved it itself). Restores by default. */
  shouldRestoreFocus?: () => boolean
  /**
   * Where the keys are listened to. 'dialog': the hook adds a native keydown listener on the dialog element (settings,
   * launch: jsx-a11y rejects a handler on that non-interactive container). 'caller': the caller binds the returned
   * `onKeyDown` itself (shortcuts, palette: on their role="presentation" scrim, as a React handler). Each dialog keeps the
   * listener it had, so the order in which its other key handlers run is unchanged.
   */
  listen?: 'dialog' | 'caller'
}

/**
 * Focus management of a modal dialog (#507): focus moves into it on open and goes back on close to the element that had
 * it, if that element is still in the page; Tab is trapped inside; Escape closes it and is consumed (default prevented,
 * propagation stopped, so the global Escape handler that closes panels never sees it).
 *
 * Returns `onKeyDown`, which handles Escape and Tab and returns true when it did (the caller then stops), for
 * `listen: 'caller'`.
 */
export function useModalDialog(options: ModalDialogOptions): { onKeyDown: (e: ModalKeyEvent) => boolean } {
  const { open, dialogRef, listen = 'caller' } = options
  // Read when used: callers pass new closures on each render, which must not re-run the effects
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    ;(optionsRef.current.initialFocus?.() ?? dialogRef.current)?.focus({ preventScroll: true })
    return () => {
      if (optionsRef.current.shouldRestoreFocus?.() === false) return
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open, dialogRef])

  const onKeyDown = useCallback((e: ModalKeyEvent): boolean => {
    const { onClose, onEscape, tab = 'wrap' } = optionsRef.current
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (onEscape?.()) return true
      onClose()
      return true
    }
    if (e.key !== 'Tab') return false
    if (tab === 'hold') {
      e.preventDefault()
      return true
    }
    const dialog = dialogRef.current
    if (!dialog) return false
    const nodes = modalTabStops(dialog)
    if (nodes.length === 0) {
      e.preventDefault()
      return true
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
    return true
  }, [dialogRef])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || listen !== 'dialog' || !dialog) return
    const listener = (e: KeyboardEvent) => { onKeyDown(e) }
    dialog.addEventListener('keydown', listener)
    return () => dialog.removeEventListener('keydown', listener)
  }, [open, listen, dialogRef, onKeyDown])

  return { onKeyDown }
}
