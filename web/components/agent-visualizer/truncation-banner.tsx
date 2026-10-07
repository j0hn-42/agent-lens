'use client'

import { useId, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/chrome-utils'
import { truncationHeadline, truncationTotal, type NormalizationStats } from '@/lib/event-normalize'

/**
 * Props contract of {@link TruncationBanner}.
 *
 * Wiring (to do in index.tsx, not done here):
 *  1. Keep `statsBySession: Map<string, NormalizationStats>` and update it from every
 *     `normalization_stats` event (`parseNormalizationStats(event.payload)`, keyed by event.sessionId).
 *  2. Keep `dismissedAt: Map<string, number>`; show the banner for the selected session when
 *     `shouldShowTruncationBanner(stats, dismissedAt.get(sessionId))`. `onDismiss` stores
 *     `truncationTotal(stats)` for that session, so the banner comes back if more is dropped later.
 *  3. Render `<TruncationBanner key={sessionId} stats={stats} onDismiss={...} />` for the selected
 *     session (the key resets the details disclosure when the session changes).
 */
export interface TruncationBannerProps {
  /** Counters of the selected session (untrusted values must go through parseNormalizationStats). */
  stats: NormalizationStats
  /** The user dismissed the banner for this session. */
  onDismiss: () => void
}

const REASONS: ReadonlyArray<{ key: keyof NormalizationStats; label: string }> = [
  { key: 'ignoredEvents', label: 'Events ignored (unsupported or belonging to a dropped node)' },
  { key: 'malformed', label: 'Malformed inputs (invalid JSON or shape)' },
  { key: 'droppedByCap', label: 'Nodes dropped (node or children cap reached)' },
  { key: 'clampedFields', label: 'Fields shortened or clamped' },
  { key: 'duplicateEvents', label: 'Duplicate events skipped' },
]

/**
 * "Graph truncated" notice: rendered only when events or nodes were actually discarded. The
 * state is carried by words and a symbol, never by color alone. Details are a native disclosure
 * button; dismissal is reported to the parent, which owns the per-session memory.
 */
export function TruncationBanner({ stats, onDismiss }: TruncationBannerProps) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  if (truncationTotal(stats) <= 0) return null
  const { events, nodes } = truncationHeadline(stats)

  return (
    <div
      role="status"
      className="glass-card flex flex-col gap-1 px-3 py-1.5 text-xs font-mono max-w-[calc(100vw-24px)]"
      style={{ color: COLORS.textPrimary }}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words">
          <span aria-hidden="true">⚠ </span>
          {`Graph truncated: ${events} ${events === 1 ? 'event' : 'events'} ignored, ${nodes} ${nodes === 1 ? 'node' : 'nodes'} dropped`}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(o => !o)}
          className={`min-h-6 min-w-6 px-2 rounded text-xs underline shrink-0 ${FOCUS_RING}`}
          style={{ color: COLORS.holoBright }}
        >
          Details
        </button>
        <button
          type="button"
          aria-label="Dismiss truncation warning"
          onClick={onDismiss}
          className={`min-h-6 min-w-6 rounded shrink-0 ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <ul id={detailsId} hidden={!open} aria-label="Counters by reason" className="list-none m-0 p-0">
        {REASONS.map(r => (
          <li key={r.key}>{`${r.label}: ${stats[r.key]}`}</li>
        ))}
      </ul>
    </div>
  )
}
