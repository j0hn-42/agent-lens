'use client'

import { useId, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { truncationHeadline, truncationTotal, type NormalizationStats } from '@/lib/event-normalize'

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
export function TruncationBanner({ stats, replayLost = 0, onDismiss }: TruncationBannerProps) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const lost = Number.isSafeInteger(replayLost) && replayLost > 0 ? replayLost : 0
  const truncated = truncationTotal(stats) > 0
  if (!truncated && lost === 0) return null
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
          {truncated && `Graph truncated: ${events} ${events === 1 ? 'event' : 'events'} ignored, ${nodes} ${nodes === 1 ? 'node' : 'nodes'} dropped`}
          {lost > 0 && `${truncated ? '; ' : 'Graph incomplete: '}at least ${lost} earlier ${lost === 1 ? 'event was' : 'events were'} not replayed by the relay`}
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
