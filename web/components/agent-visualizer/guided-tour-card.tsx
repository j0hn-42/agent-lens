'use client'

import { useEffect, useRef } from 'react'
import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import { useFocusReturn } from '@/hooks/use-focus-return'
import type { GuidedStep } from '@/lib/guided-steps'

interface GuidedTourCardProps {
  steps: readonly GuidedStep[]
  index: number
  onNext: () => void
  onPrev: () => void
  onGoTo: (index: number) => void
  onExit: () => void
}

const BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-3 py-1 text-xs font-mono disabled:opacity-50 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lens-focus-ring)]'
const BUTTON_STYLE = { background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }

/**
 * The guided tour card: what the highlighted element is. A dialog without a focus trap, so the page stays
 * explorable (zoom, click an agent) while the tour is open. Arrow keys and Escape work only while the focus is
 * inside the card, so they never take the arrow keys away from the graph keyboard navigation.
 */
export function GuidedTourCard({ steps, index, onNext, onPrev, onGoTo, onExit }: GuidedTourCardProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusReturn(true, rootRef)

  // The card is unmounted when the tour ends, which useFocusReturn (open -> closed transition) does not see
  useEffect(() => {
    const active = document.activeElement
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])

  // Native listener: keeps the dialog element free of JSX key handlers (jsx-a11y/no-noninteractive-element-interactions)
  const dialogRef = useRef<HTMLElement>(null)
  const handlersRef = useRef({ onNext, onPrev, onExit })
  handlersRef.current = { onNext, onPrev, onExit }
  const hasStep = index in steps
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      const { onNext, onPrev, onExit } = handlersRef.current
      if (e.key === 'ArrowRight') { e.preventDefault(); onNext() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onExit() }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [hasStep])

  const step = steps[index]
  if (!step) return null

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-labelledby="guided-tour-title"
        aria-describedby="guided-tour-body"
        className="pointer-events-auto absolute left-1/2 w-[min(28rem,calc(100vw-24px))] -translate-x-1/2 rounded-md p-4 font-mono text-xs"
        style={{
          bottom: CONTROL_BAR_BOTTOM + DOCK_GAP + 64,
          zIndex: Z.detailCard,
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.glassBorder}`,
          color: COLORS.textPrimary,
        }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span style={{ color: COLORS.textMuted }}>{`Step ${index + 1} of ${steps.length}`}</span>
          <button type="button" onClick={onExit} className={BUTTON_CLASS} style={BUTTON_STYLE}>Exit tour</button>
        </div>
        <div aria-live="polite">
          <h2 id="guided-tour-title" className="mb-1 text-sm font-semibold">{step.title}</h2>
          <p id="guided-tour-body" className="leading-relaxed" style={{ color: COLORS.textPrimary }}>{step.body}</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onPrev} disabled={index === 0} className={BUTTON_CLASS} style={BUTTON_STYLE}>Previous</button>
          <button type="button" onClick={onNext} disabled={index === steps.length - 1} className={BUTTON_CLASS} style={BUTTON_STYLE}>Next</button>
          <select
            aria-label="Go to step"
            value={index}
            onChange={e => onGoTo(Number(e.target.value))}
            className="ml-auto max-w-[12rem] bg-transparent font-mono text-xs"
            style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}`, borderRadius: 6, minHeight: 24 }}
          >
            {steps.map((s, i) => (
              <option key={s.id} value={i} style={{ color: COLORS.textPrimary, background: 'var(--lens-surface)' }}>{`${i + 1}. ${s.title}`}</option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}
