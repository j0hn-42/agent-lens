'use client'

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { SUMMARY_CLOSE_DELAY_MS, SUMMARY_KEY, SUMMARY_POPOVER, spokenCompactSummary } from '@/lib/chrome-utils'
import { COST_LABELS } from '@/lib/ui-glossary'

/** Gap between the bottom of the bar and the popover, and the margin it keeps from the window edges (px). */
const POPOVER_GAP = 4
const POPOVER_MARGIN = 12

/**
 * The summary of the top bar on one line (#497): `compact` is what is drawn (counts, tokens in context, cost, with the
 * qualifiers as symbols), `children` is the full wording. The full wording is always in the page for assistive
 * technology; on hover and on keyboard focus it is drawn as a popover below the whole bar, so it never covers the rows
 * of panel buttons under the summary. It stays open while the pointer is over the summary or the popover (the pointer has
 * SUMMARY_CLOSE_DELAY_MS to cross the rows between them) and Escape closes it wherever the focus is, without moving the
 * focus (WCAG 1.4.13). Folded (`focusable` false) the whole block is already visually hidden, so it is not a Tab stop.
 * `onOpenChange` lets the bar rise above the docked panels while the popover is open.
 */
export function TopBarSummary({ compact, focusable, onOpenChange, children }: {
  compact: string; focusable: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // Escape hides the popover until the pointer or the focus leaves and comes back
  const [dismissed, setDismissed] = useState(false)
  const open = focusable && (hovered || focused) && !dismissed
  const ref = useRef<HTMLSpanElement>(null)
  const [place, setPlace] = useState<CSSProperties | null>(null)

  // Native listeners: the block is a labelled group that only reveals text, not a control with its own action
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    const enter = () => { clearTimeout(leaveTimer); setHovered(true) }
    const leave = () => {
      clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => { setHovered(false); setDismissed(false) }, SUMMARY_CLOSE_DELAY_MS)
    }
    const focusIn = () => { setFocused(true); setDismissed(false) }
    const focusOut = () => { setFocused(false); setDismissed(false) }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    return () => {
      clearTimeout(leaveTimer)
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
    }
  }, [])

  // Open, Escape closes it wherever the focus is (a popover opened by hover too). Capture phase, stopped only while open,
  // so the global Escape (close the latest panel, clear the selection) does not also run (as the View panel does)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDismissed(true)
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [open])

  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])

  // Below the whole bar, right edge on the summary's, inside the window
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) { setPlace(null); return }
    const s = el.getBoundingClientRect()
    const bar = el.closest('header')?.getBoundingClientRect() ?? s
    const width = window.innerWidth
    setPlace({
      top: bar.bottom + POPOVER_GAP,
      right: Math.max(POPOVER_MARGIN, width - s.right),
      maxWidth: `min(34rem, ${Math.max(0, width - 2 * POPOVER_MARGIN)}px)`,
    })
  }, [open])

  return (
    <span
      ref={ref}
      data-testid="topbar-summary"
      data-open={open ? 'true' : 'false'}
      role="group"
      aria-label={spokenCompactSummary(compact)}
      tabIndex={focusable ? 0 : undefined}
      className={`relative min-w-0 md:whitespace-nowrap rounded ${focusable ? FOCUS_RING : ''}`}
    >
      <span data-testid="topbar-summary-compact" aria-hidden="true">{compact}</span>
      <span
        data-testid="topbar-summary-full"
        className={open ? 'fixed block w-max whitespace-normal rounded-md px-3 py-2 leading-relaxed' : 'sr-only'}
        style={open ? {
          ...place,
          background: COLORS[SUMMARY_POPOVER.ground],
          color: COLORS[SUMMARY_POPOVER.text],
          boxShadow: 'var(--lens-bar-shadow)',
          border: `1px solid ${COLORS.holoBorder06}`,
        } : undefined}
      >
        {children}
        {/* Drawn only: the spoken cost already says "context cost estimate", and the symbols are not read */}
        {open && <span data-testid="topbar-summary-method" aria-hidden="true" className="block">{COST_LABELS.method}</span>}
        <span data-testid="topbar-summary-key" aria-hidden="true" className="block">{SUMMARY_KEY}</span>
      </span>
    </span>
  )
}
