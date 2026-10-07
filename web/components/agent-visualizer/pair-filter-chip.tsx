'use client'

import { useEffect, useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import {
  isPairSet, pairAnnouncement, pairChipLabel, pairSpokenLabel, type PairState,
} from '@/lib/pair-filter'

/**
 * Visible, removable chip for the active Pair filter ("orchestrator <-> audit-ux") plus a polite live
 * region that announces changes and the number of messages shown. Shared by the feed and the transcript.
 */
export function PairFilterChip({ pair, nameOf, count, onClear }: {
  pair: PairState
  nameOf: (key: string) => string
  /** Messages currently shown for the pair */
  count: number
  onClear: () => void
}) {
  const set = isPairSet(pair)
  const [announcement, setAnnouncement] = useState('')
  const first = useRef(true)
  const text = pairAnnouncement(pair, nameOf, count)
  useEffect(() => {
    if (first.current) { first.current = false; if (!set) return }
    setAnnouncement(text)
  }, [text, set])

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
      {set && (
        <span
          role="group"
          aria-label={`Pair filter: ${pairSpokenLabel(pair, nameOf)}`}
          className="inline-flex items-center gap-0.5 rounded-full pl-2 text-[11px] font-mono max-w-full"
          style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span className="truncate" title={pairSpokenLabel(pair, nameOf)}>{pairChipLabel(pair, nameOf)}</span>
          <button
            type="button"
            aria-label="Clear pair filter"
            title="Clear pair filter"
            onClick={onClear}
            className={`min-h-6 min-w-6 inline-flex items-center justify-center rounded-full ${FOCUS_RING}`}
            style={{ color: COLORS.textMuted }}
          >
            <span aria-hidden="true">{'×'}</span>
          </button>
        </span>
      )}
    </>
  )
}
