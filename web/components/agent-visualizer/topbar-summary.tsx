'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { SUMMARY_KEY } from '@/lib/chrome-utils'

/**
 * The summary of the top bar on one line (#497): `compact` is what is drawn (counts, tokens in context, cost, with the
 * qualifiers as symbols), `children` is the full wording. The full wording is always in the page for assistive
 * technology; on hover and on keyboard focus it is drawn as a popover under the bar, which stays open while the pointer
 * is over it and closes with Escape without moving the focus (WCAG 1.4.13). Folded (`focusable` false) the whole block is
 * already visually hidden, so it is not a Tab stop.
 */
export function TopBarSummary({ compact, focusable, children }: { compact: string; focusable: boolean; children: ReactNode }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // Escape hides the popover until the pointer or the focus leaves and comes back
  const [dismissed, setDismissed] = useState(false)
  const open = focusable && (hovered || focused) && !dismissed
  const ref = useRef<HTMLSpanElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  // Native listeners: the block is a labelled group that only reveals text, not a control with its own action
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const enter = () => { setHovered(true); setDismissed(false) }
    const leave = () => { setHovered(false); setDismissed(false) }
    const focusIn = () => { setFocused(true); setDismissed(false) }
    const focusOut = () => { setFocused(false); setDismissed(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && openRef.current) { e.stopPropagation(); setDismissed(true) } }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focusin', focusIn)
    el.addEventListener('focusout', focusOut)
    el.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('focusin', focusIn)
      el.removeEventListener('focusout', focusOut)
      el.removeEventListener('keydown', key)
    }
  }, [])
  return (
    <span
      ref={ref}
      data-testid="topbar-summary"
      data-open={open ? 'true' : 'false'}
      role="group"
      aria-label="Agents, tokens in context and cost"
      tabIndex={focusable ? 0 : undefined}
      className={`relative min-w-0 whitespace-nowrap rounded ${focusable ? FOCUS_RING : ''}`}
    >
      <span data-testid="topbar-summary-compact" aria-hidden="true">{compact}</span>
      <span
        data-testid="topbar-summary-full"
        className={open ? 'absolute left-0 top-full z-10 block w-max max-w-[min(34rem,90vw)] whitespace-normal rounded-md px-3 py-2 leading-relaxed' : 'sr-only'}
        style={open ? { background: 'var(--lens-bar-bg)', boxShadow: 'var(--lens-bar-shadow)', border: `1px solid ${COLORS.holoBorder06}` } : undefined}
      >
        {children}
        <span className="block opacity-80">{SUMMARY_KEY}</span>
      </span>
    </span>
  )
}
