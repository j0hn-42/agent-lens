'use client'

import { useEffect, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { LEGEND_OPEN_KEY } from '@/lib/canvas-constants'
import type { A11yTeamItem } from './canvas/a11y-model'
import type { LegendEntryId } from '@/lib/legend-entries'
import { FOCUS_RING } from '@/lib/focus-ring'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { useTourBridge, GUIDED_TOUR_BUTTON_ID } from './guided-tour-context'
import { translate, type Locale, type MessageKey } from '@/lib/messages'
import { LegendPanel } from './lazy-panels'

/**
 * Collapsible legend of everything the canvas encodes: states, shapes, edges,
 * context segments, discovery types and runtimes. Lives in the DOM (not the canvas)
 * so it is readable at any zoom and by assistive technology (WCAG 1.4.1, 1.3.3).
 */
export function GraphLegend({ teams = [], present, locale = 'en' }: { teams?: A11yTeamItem[]; present?: readonly LegendEntryId[]; locale?: Locale }) {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const [open, setOpen] = useState(false)
  // Complete reference on demand (not saved): the list otherwise holds the symbols that are on screen
  const [showAll, setShowAll] = useState(false)
  // The guided tour can show the legend without touching the saved preference (only toggle writes it)
  const { legendOpen: tourWantsOpen, legendShowAll, startTour, startTourLabel } = useTourBridge()
  const shown = open || tourWantsOpen
  // Not computed (no scene), asked for, or held complete by the guided demo: every entry
  const filtered = present !== undefined && !legendShowAll

  // Restore the preference after mount (keeps server and first client render identical)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LEGEND_OPEN_KEY) === '1') setOpen(true)
    } catch { /* storage unavailable (private window, blocked data) */ }
  }, [])

  const toggle = () => {
    // Held open by the tour only: a click could not collapse it, so it saves nothing either
    if (tourWantsOpen && !open) return
    setOpen(prev => {
      const next = !prev
      try { window.localStorage.setItem(LEGEND_OPEN_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div
      lang={locale}
      className="pointer-events-auto max-w-[calc(100vw-24px)] font-mono text-xs"
      style={{ color: COLORS.textPrimary }}
    >
      {shown && (
        <div
          id="graph-legend-panel"
          role="region"
          aria-label={t('legend.region')}
          className="mb-1 max-h-[40vh] w-64 sm:max-h-[60vh] max-w-full overflow-y-auto rounded-md p-3"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}` }}
        >
          {/* The entries are a chunk loaded the first time the legend opens (#662); the region is here at once */}
          <LegendPanel teams={teams} present={present} locale={locale} filtered={filtered} showAll={showAll} onToggleShowAll={() => setShowAll(v => !v)} />
        </div>
      )}
      {/* Sits on the playback bar: "Fit to view" keeps the content above it (issue 378) */}
      <div data-canvas-inset="bottom" className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={shown}
          aria-controls={shown ? "graph-legend-panel" : undefined}
          className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center gap-1 rounded-md px-2 py-1 text-[11px] ${FOCUS_RING}`}
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
          {t('legend.name')}
        </button>
        {startTour && (
          <button
            id={GUIDED_TOUR_BUTTON_ID}
            lang={locale}
            type="button"
            onClick={startTour}
            className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center rounded-md px-2 py-1 text-[11px] ${FOCUS_RING}`}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            {startTourLabel ?? t('tour.button.demo')}
          </button>
        )}
      </div>
    </div>
  )
}
