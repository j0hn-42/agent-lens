'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { TOOLTIP_CLOSE_DELAY_MS, TOPBAR_TOOLTIP } from '@/lib/chrome-utils'

/** Gap between the button and its tooltip, and the margin it keeps from the window edges (px). */
const GAP = 4
const MARGIN = 8

/**
 * Tooltip of a top bar button (#523): what a panel icon means (its name and shortcut; for some panels what it shows). It
 * is a role="tooltip", linked by the button's aria-describedby when it says more than the button's name. It is
 * drawn below the button on hover and on keyboard focus, stays open while the pointer is over the button or the tooltip
 * (the pointer has TOOLTIP_CLOSE_DELAY_MS to cross the gap), and Escape closes it wherever the focus is, without moving
 * the focus (WCAG 1.4.13); opened by hover, that Escape does nothing else. A click on the button hides it until the next
 * hover, so it never covers the panel the button opens nor takes the Escape that closes that panel. The native title is not used (it shows neither on
 * focus nor with Escape). `children` receives the id to put in the button's aria-describedby. `onOpen` is called with
 * +1 when it opens and -1 when it closes, so the bar can rise above the docked panels the tooltip is drawn over.
 */
export function TopBarTooltip({ text, lang, onOpen, children, sensitive = false, boxClassName = '' }: {
  text: string; lang?: string; onOpen?: (delta: 1 | -1) => void; children: (tooltipId: string) => ReactNode
  /** The text holds free text (a session name): blurred in presentation mode like the button that shows it (#245) */
  sensitive?: boolean
  /** Extra classes of the box around the button (it is the flex item of the bar) */
  boxClassName?: string
}) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // Escape hides it until the pointer leaves, or (with no pointer on it) until the focus leaves and comes back
  const [dismissed, setDismissed] = useState(false)
  const open = (hovered || focused) && !dismissed
  // Read in the native handlers: the focus coming back to the button (a panel closed) keeps it hidden under the pointer
  const hoveredRef = useRef(false)
  const boxRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)

  // Native listeners: the wrapper only reveals text, it is not a control with its own action (a11y lint)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    // A new hover (not the pointer coming back within the close delay) shows it again after a click or Escape hid it
    const enter = () => { clearTimeout(leaveTimer); if (!hoveredRef.current) setDismissed(false); hoveredRef.current = true; setHovered(true) }
    const leave = () => {
      clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => { hoveredRef.current = false; setHovered(false); setDismissed(false) }, TOOLTIP_CLOSE_DELAY_MS)
    }
    const focusIn = () => { setFocused(true); if (!hoveredRef.current) setDismissed(false) }
    const focusOut = () => { setFocused(false); if (!hoveredRef.current) setDismissed(false) }
    // A click (pointer or keyboard) hides it until the pointer leaves: the panel the button opens appears below, and the
    // tooltip would cover it and take the first Escape meant for that panel (#545 review)
    const press = () => setDismissed(true)
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    el.addEventListener('pointerdown', press)
    el.addEventListener('click', press)
    return () => {
      clearTimeout(leaveTimer)
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
      el.removeEventListener('pointerdown', press)
      el.removeEventListener('click', press)
    }
  }, [])

  // Open, Escape closes it wherever the focus is. Opened by the pointer, the Escape stops here (capture phase), so the
  // global Escape (close the latest panel, clear the selection) does not also run: the pointer user only wanted the
  // tooltip gone. Opened by the keyboard focus alone, the Escape also goes on to the page, so closing panels one by one
  // with Escape is not slowed by the tooltip of the button the focus comes back to
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (hoveredRef.current) e.stopPropagation()
      setDismissed(true)
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [open])

  useEffect(() => {
    if (!open || !onOpen) return
    onOpen(1)
    return () => onOpen(-1)
  }, [open, onOpen])

  // Below the button, its left edge on the button's, moved back inside the window (reflow, WCAG 1.4.10)
  useLayoutEffect(() => {
    const tip = tipRef.current
    const anchor = boxRef.current?.firstElementChild
    if (!open || !tip || !anchor) return
    const a = anchor.getBoundingClientRect()
    tip.style.top = `${a.bottom + GAP}px`
    tip.style.left = `${a.left}px`
    const over = tip.getBoundingClientRect().right - (window.innerWidth - MARGIN)
    if (over > 0) tip.style.left = `${Math.max(MARGIN, a.left - over)}px`
  }, [open])

  return (
    <span ref={boxRef} className={`relative inline-flex ${boxClassName}`}>
      {children(id)}
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        hidden={!open}
        lang={lang}
        {...(sensitive ? { 'data-sensitive': '' } : {})}
        className="fixed z-10 w-max max-w-[min(20rem,calc(100vw-16px))] whitespace-normal rounded px-2 py-1 text-2xs font-normal leading-snug"
        style={{
          background: COLORS[TOPBAR_TOOLTIP.ground],
          color: COLORS[TOPBAR_TOOLTIP.text],
          border: `1px solid ${COLORS.holoBorder06}`,
          boxShadow: 'var(--lens-bar-shadow)',
        }}
      >
        {text}
      </span>
    </span>
  )
}
