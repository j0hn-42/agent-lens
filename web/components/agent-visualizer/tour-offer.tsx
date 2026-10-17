'use client'

import { useEffect, useId, useRef } from 'react'
import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import { FOCUS_RING } from '@/lib/focus-ring'
import { GUIDED_TOUR_BUTTON_ID } from './guided-tour-context'
import { useDockSnapshot } from './shared-ui'

const TITLE = 'New to Agent Lens?'
/** Room kept for the row of canvas controls (legend button, zoom, View) that sits right above the control bar */
const CANVAS_CONTROLS_ROW = 40
const BUTTON_CLASS = `inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-3 py-1 text-xs font-mono ${FOCUS_RING}`

interface TourOfferProps {
  open: boolean
  /** Name of the tour button of the legend ("Tour this session"): the offer says where the tour stays available */
  label: string
  onStart: () => void
  onDismiss: () => void
}

/**
 * Tour offered on the first launch (#377). Not a dialog: it never takes the focus, and the page stays usable.
 * Its text goes to a polite live region mounted before it opens, so a screen reader hears the offer. Escape inside
 * it, or Not now, closes it; the focus then goes to the tour button of the legend, where the tour stays available.
 */
export function TourOffer({ open, label, onStart, onDismiss }: TourOfferProps) {
  const titleId = useId()
  const bodyId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  // Above the canvas controls, which sit above the control bar: the card never covers them
  const { controlBarH } = useDockSnapshot().env
  const body = `A short tour explains what is on screen. It stays available from ${label} next to the Legend, and from Commands (Ctrl+K).`

  const dismiss = () => {
    const hadFocus = sectionRef.current?.contains(document.activeElement) ?? false
    onDismiss()
    if (!hadFocus) return
    const target = document.getElementById(GUIDED_TOUR_BUTTON_ID) ?? document.getElementById('visualizer-main')
    target?.focus({ preventScroll: true })
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  // Native listener: keeps the region free of JSX key handlers (jsx-a11y/no-noninteractive-element-interactions)
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dismissRef.current()
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <>
      <div role="status" className="sr-only">{open ? `${TITLE} ${body}` : ''}</div>
      {open && (
        <section
          ref={sectionRef}
          data-tour-offer=""
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          className="pointer-events-auto absolute left-1/2 w-[min(26rem,calc(100vw-24px))] -translate-x-1/2 rounded-md p-3 font-mono text-xs"
          style={{
            bottom: CONTROL_BAR_BOTTOM + controlBarH + DOCK_GAP + CANVAS_CONTROLS_ROW + DOCK_GAP,
            zIndex: Z.detailCard,
            background: COLORS.panelBg,
            border: `1px solid ${COLORS.glassBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          <h2 id={titleId} className="mb-1 text-sm font-semibold">{TITLE}</h2>
          <p id={bodyId} className="m-0 leading-relaxed">{body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onStart}
              className={BUTTON_CLASS}
              style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            >
              Start the tour
            </button>
            <button
              type="button"
              onClick={dismiss}
              className={BUTTON_CLASS}
              style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            >
              Not now
            </button>
          </div>
        </section>
      )}
    </>
  )
}
