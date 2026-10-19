'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
  /** Reopened from the indicator (#567): Details starts expanded */
  initialOpen?: boolean
  /**
   * The user just asked for the notice (Show notice): the Details toggle takes the focus when the banner mounts, and
   * `onFocusTaken` tells the parent the request is spent. A later mount (leaving full screen, the banner coming back
   * after its total fell to 0) never moves the focus (#569 review).
   */
  takeFocus?: boolean
  onFocusTaken?: () => void
}

/**
 * Counters listed under Details, in this order; each has its own label in the catalog (truncation.reason.*). Losses
 * (what truncationTotal counts) and adjustments (fields shortened, duplicates skipped: nothing left out of the graph,
 * #567) are two lists under two headings, so an adjustment never reads as a loss.
 */
const LOSS_REASONS: ReadonlyArray<keyof NormalizationStats> = ['ignoredEvents', 'malformed', 'droppedByCap', 'missedUpdates']
const ADJUSTMENT_REASONS: ReadonlyArray<keyof NormalizationStats> = ['clampedFields', 'duplicateEvents']

/** A replay loss as the banner reads it: a positive safe integer, 0 otherwise */
const replayCount = (n: number | undefined) => (n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : 0)

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
export function TruncationBanner({ stats, replayLost = 0, onDismiss, returnFocusId, initialOpen = false, takeFocus = false, onFocusTaken }: TruncationBannerProps) {
  const [open, setOpen] = useState(initialOpen)
  const detailsId = useId()
  const lossesId = useId()
  const adjustmentsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const { locale } = useLocale()
  const lost = replayCount(replayLost)
  const truncated = truncationTotal(stats) > 0
  // Reopened from the indicator: the focus follows the user to the notice they asked for, once
  useEffect(() => {
    if (!takeFocus || !toggleRef.current) return
    toggleRef.current.focus({ preventScroll: true })
    onFocusTaken?.()
  }, [takeFocus, onFocusTaken])
  // Gone without the user's gesture (its total fell back to the one dismissed at, #605 review round 4): a focus left inside
  // would fall to the document body. It goes where a dismissal by the user sends it (WCAG 2.4.3). A dismissal by the user
  // has already moved it out, so this does nothing then.
  const unmountRef = useRef<{ node: HTMLDivElement | null; returnFocusId?: string }>({ node: null })
  useLayoutEffect(() => { unmountRef.current.returnFocusId = returnFocusId }, [returnFocusId])
  useLayoutEffect(() => {
    const box = unmountRef.current
    return () => {
      const id = box.returnFocusId
      if (!id || !box.node || !box.node.contains(document.activeElement)) return
      document.getElementById(id)?.focus({ preventScroll: true })
    }
  }, [])
  if (!truncated && lost === 0) return null
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)

  return (
    <div
      role="group"
      lang={locale}
      aria-label={t('truncation.group')}
      data-truncation-banner
      ref={node => { unmountRef.current.node = node }}
      className="glass-card flex flex-col gap-1 px-3 py-1.5 text-xs font-mono w-fit max-w-full"
      style={{ color: COLORS.textPrimary }}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words">
          <span aria-hidden="true">⚠ </span>
          {headline(locale, stats, truncated, lost)}
        </span>
        <button
          ref={toggleRef}
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
      <div id={detailsId} hidden={!open} role="group" aria-label={t('truncation.reasons')} className="flex flex-col gap-1">
        <div>
          <p id={lossesId} className="m-0 font-bold">{t('truncation.losses')}</p>
          <ul aria-labelledby={lossesId} className="list-none m-0 p-0">
            {lost > 0 && <li>{t('truncation.reason', { label: t('truncation.reason.replayLost'), n: lost })}</li>}
            {LOSS_REASONS.map(key => (
              <li key={key}>{t('truncation.reason', { label: t(`truncation.reason.${key}`), n: stats[key] })}</li>
            ))}
          </ul>
        </div>
        <div>
          <p id={adjustmentsId} className="m-0 font-bold">{t('truncation.adjustments')}</p>
          <ul aria-labelledby={adjustmentsId} className="list-none m-0 p-0">
            {ADJUSTMENT_REASONS.map(key => (
              <li key={key}>{t('truncation.reason', { label: t(`truncation.reason.${key}`), n: stats[key] })}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** The indicator's text: "at least N events not replayed" and/or the normalizer's "N events ignored, M nodes dropped". */
function indicatorText(locale: Locale, stats: NormalizationStats, lost: number): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const parts: string[] = []
  if (lost > 0) parts.push(t(`truncation.indicator.replay.${form(locale, lost)}`, { n: lost }))
  if (truncationTotal(stats) > 0) {
    const { events, nodes } = truncationHeadline(stats)
    let cut = `${t(`truncation.events.${form(locale, events)}`, { n: events })}, ${t(`truncation.nodes.${form(locale, nodes)}`, { n: nodes })}`
    if (stats.missedUpdates > 0) cut += `, ${t(`truncation.missed.${form(locale, stats.missedUpdates)}`, { n: stats.missedUpdates })}`
    parts.push(cut)
  }
  return parts.join('; ')
}

/**
 * Short, permanent trace of a loss (#567), drawn in the Sessions panel header: it stays when the banner is dismissed,
 * so nothing is hidden without the loss staying visible. Same numbers and the same "at least" as the banner; a native
 * button reopens the banner with its details. Nothing when nothing was lost (adjustments alone are no loss).
 */
export function TruncationIndicator({ stats, replayLost = 0, onShow }: { stats: NormalizationStats; replayLost?: number; onShow: () => void }) {
  const { locale } = useLocale()
  const lost = replayCount(replayLost)
  if (lost === 0 && truncationTotal(stats) === 0) return null
  return (
    <p
      data-testid="truncation-indicator"
      lang={locale}
      className="m-0 px-2 pb-1.5 flex flex-wrap items-center gap-x-2 text-[11px]"
      style={{ color: COLORS.textPrimary }}
    >
      <span className="min-w-0 break-words">
        <span aria-hidden="true">⚠ </span>
        {indicatorText(locale, stats, lost)}
      </span>
      <button
        type="button"
        onClick={onShow}
        className={`min-h-6 min-w-6 px-1 rounded underline shrink-0 ${FOCUS_RING}`}
        style={{ color: COLORS.holoBright }}
      >
        {translate(locale, 'truncation.indicator.show')}
      </button>
    </p>
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
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" lang={locale}>
      {shown ? translate(locale, 'truncation.announce') : ''}
    </div>
  )
}
