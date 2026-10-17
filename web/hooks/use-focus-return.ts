import { useEffect, useRef, type RefObject } from 'react'
import { pickRestoreTarget, shouldRestoreFocus } from '@/lib/chrome-utils'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for a toggled panel: when it opens, move focus to its first
 * focusable control; when it closes, give focus back to the element that opened it.
 * `fallbackId` names an element (the panel's top-bar toggle) that receives focus on close when the
 * panel was opened with a keyboard shortcut, so keyboard users keep their place. A list is tried in order: under
 * 768 px the toggle may be folded behind More (#476), which then takes the focus.
 *
 * `panelRef` must point at an element that contains the panel (a `display: contents`
 * wrapper is enough).
 */
export function useFocusReturn(isOpen: boolean, panelRef: RefObject<HTMLElement | null>, fallbackId?: string | readonly string[]): void {
  const triggerRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  // Read on close only: a new list each render must not re-run the effect
  const fallbackRef = useRef(fallbackId)
  fallbackRef.current = fallbackId

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
    const f = fallbackRef.current
    const ids = f === undefined ? [] : typeof f === 'string' ? [f] : f
    const fallback = ids.map(id => document.getElementById(id)).find(el => el !== null) ?? null
    pickRestoreTarget(trigger, fallback)?.focus({ preventScroll: true })
  }, [isOpen, panelRef])
}
