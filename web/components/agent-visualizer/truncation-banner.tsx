'use client'

import { useId, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { truncationHeadline, truncationTotal, type NormalizationStats } from '@/lib/event-normalize'
import { useLocale } from '@/lib/locale'
import { translate, type Locale, type MessageKey } from '@/lib/messages'

/**
 * Props contract of {@link TruncationBanner}.
 *
 * Wired in index.tsx: the counters come from the `normalization_stats` events of the selection (summed
 * for a union view), `replayLost` from the relay's `event-loss` message. The parent owns the per-selection
 * dismissal (it stores the total shown, so the banner comes back if more is lost later) and keys the
 * banner by selection so the details disclosure resets.
 */
export interface TruncationBannerProps {
  /** Counters of the selected session (untrusted values must go through parseNormalizationStats). */
  stats: NormalizationStats
  /** Events the relay could not replay when the page connected (lower bound, see lib/event-loss); 0 or invalid = none. */
  replayLost?: number
  /** The user dismissed the banner for this session. */
  onDismiss: () => void
  /** DOM id of a stable element that receives the focus when the banner is dismissed (the banner unmounts with its own button) */
  returnFocusId?: string
}

/** Counters listed under Details, in this order; each has its own label in the catalog (truncation.reason.*). */
const REASONS: ReadonlyArray<keyof NormalizationStats> = [
  'ignoredEvents', 'malformed', 'droppedByCap', 'missedUpdates', 'clampedFields', 'duplicateEvents',
]

/** Singular form for one (French: also zero), plural otherwise. */
function form(locale: Locale, n: number): 'one' | 'other' {
  return (locale === 'fr' ? n < 2 : n === 1) ? 'one' : 'other'
}

/** "N events ignored, M nodes dropped[, at least K updates not read]" and the replay loss, in the interface language. */
function headline(locale: Locale, stats: NormalizationStats, truncated: boolean, lost: number): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const { events, nodes } = truncationHeadline(stats)
  const missed = stats.missedUpdates
  let text = ''
  if (truncated) {
    text = t('truncation.truncated', {
      events: t(`truncation.events.${form(locale, events)}`, { n: events }),
      nodes: t(`truncation.nodes.${form(locale, nodes)}`, { n: nodes }),
    })
    // Not events ignored: rows the source changed after the reader stopped following them (#420)
    if (missed > 0) text += `, ${t(`truncation.missed.${form(locale, missed)}`, { n: missed })}`
  }
  if (lost > 0) {
    const replay = t(`truncation.replay.${form(locale, lost)}`, { n: lost })
    text += truncated ? `; ${replay}` : t('truncation.incomplete', { lost: replay })
  }
  return text
}

/**
 * "Graph truncated" notice: rendered only when events or nodes were actually discarded. The
 * state is carried by words and a symbol, never by color alone. Details are a native disclosure
 * button; dismissal is reported to the parent, which owns the per-session memory.
 */
export function TruncationBanner({ stats, replayLost = 0, onDismiss, returnFocusId }: TruncationBannerProps) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const { locale } = useLocale()
  const lost = Number.isSafeInteger(replayLost) && replayLost > 0 ? replayLost : 0
  const truncated = truncationTotal(stats) > 0
  if (!truncated && lost === 0) return null
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)

  return (
    <div
      role="group"
      aria-label={t('truncation.group')}
      data-truncation-banner
      className="glass-card flex flex-col gap-1 px-3 py-1.5 text-xs font-mono w-fit max-w-full"
      style={{ color: COLORS.textPrimary }}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words">
          <span aria-hidden="true">⚠ </span>
          {headline(locale, stats, truncated, lost)}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(o => !o)}
          className={`min-h-6 min-w-6 px-2 rounded text-xs underline shrink-0 ${FOCUS_RING}`}
          style={{ color: COLORS.holoBright }}
        >
          {t('truncation.details')}
        </button>
        <button
          type="button"
          aria-label={t('truncation.dismiss')}
          onClick={() => {
            // The banner unmounts with this button: hand the focus over first (WCAG 2.4.3)
            if (returnFocusId) document.getElementById(returnFocusId)?.focus({ preventScroll: true })
            onDismiss()
          }}
          className={`min-h-6 min-w-6 rounded shrink-0 ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <ul id={detailsId} hidden={!open} aria-label={t('truncation.reasons')} className="list-none m-0 p-0">
        {REASONS.map(key => (
          <li key={key}>{t('truncation.reason', { label: t(`truncation.reason.${key}`), n: stats[key] })}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Stable polite live region for the banner. The banner itself is not a live region (it would be announced
 * already filled when it mounts, and again at every counter change): this one says one fixed sentence when
 * the banner appears and goes quiet when it goes away.
 */
export function TruncationAnnouncer({ shown }: { shown: boolean }) {
  const { locale } = useLocale()
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {shown ? translate(locale, 'truncation.announce') : ''}
    </div>
  )
}
