import { useEffect, useRef, type RefObject } from 'react'
import { pickRestoreTarget, shouldRestoreFocus } from '@/lib/chrome-utils'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for a toggled panel: when it opens, move focus to its first
 * focusable control; when it closes, give focus back to the element that opened it.
 * `fallbackId` names an element (the panel's top-bar toggle) that receives focus on close when the
 * panel was opened with a keyboard shortcut, so keyboard users keep their place.
 *
 * `panelRef` must point at an element that contains the panel (a `display: contents`
 * wrapper is enough).
 */
export function useFocusReturn(isOpen: boolean, panelRef: RefObject<HTMLElement | null>, fallbackId?: string): void {
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
    if (!shouldRestoreFocus(document.activeElement, panelRef.current, document.body)) return
    const fallback = fallbackId ? document.getElementById(fallbackId) : null
    pickRestoreTarget(trigger, fallback)?.focus({ preventScroll: true })
  }, [isOpen, panelRef, fallbackId])
}
