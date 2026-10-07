import { useEffect, useRef, type RefObject } from 'react'
import { shouldRestoreFocus } from '@/lib/chrome-utils'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for a toggled panel: when it opens, move focus to its first
 * focusable control; when it closes, give focus back to the element that opened it.
 *
 * `panelRef` must point at an element that contains the panel (a `display: contents`
 * wrapper is enough). If the panel was opened with a keyboard shortcut (no trigger
 * focused), focus moves in but there is nothing to return to.
 */
export function useFocusReturn(isOpen: boolean, panelRef: RefObject<HTMLElement | null>): void {
  const triggerRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = isOpen
    if (isOpen === wasOpen) return

    if (isOpen) {
      const active = document.activeElement
      triggerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      // Wait one frame so slide-in panels are laid out before we focus into them.
      const raf = requestAnimationFrame(() => {
        const target = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
        target?.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(raf)
    }

    const trigger = triggerRef.current
    triggerRef.current = null
    if (trigger && trigger.isConnected && shouldRestoreFocus(document.activeElement, panelRef.current, document.body)) {
      trigger.focus({ preventScroll: true })
    }
  }, [isOpen, panelRef])
}
