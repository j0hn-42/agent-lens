'use client'

import { useEffect, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { historyLoadedText, historyLoadingText, type HistoryProgress } from '@/lib/history-loading'

/**
 * Progress of a history catch-up (#210): a switch to 'All', a relay replay or any burst processed over
 * several frames. Visible chip with a progress bar while events are waiting; a polite live region announces
 * the start and the end only (never every step), with the real counts.
 */
export function HistoryLoadingIndicator({ progress }: { progress: HistoryProgress | null }) {
  const [announcement, setAnnouncement] = useState('')
  /** Total of the catch-up in progress, null when none is */
  const totalRef = useRef<number | null>(null)

  useEffect(() => {
    if (progress) {
      if (totalRef.current === null) setAnnouncement(historyLoadingText(progress))
      totalRef.current = progress.total
    } else if (totalRef.current !== null) {
      setAnnouncement(historyLoadedText(totalRef.current))
      totalRef.current = null
    }
  }, [progress])

  const ratio = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {progress && (
        <div
          className="glass-card absolute left-1/2 -translate-x-1/2 flex items-center gap-3 px-3 py-1.5 text-xs font-mono pointer-events-none max-w-[calc(100vw-24px)]"
          style={{ top: 'calc(var(--topbar-h, 60px) + 8px)', zIndex: Z.controlBar + 5, color: COLORS.textPrimary }}
        >
          <span data-testid="history-loading">{historyLoadingText(progress)}</span>
          <div
            role="progressbar"
            aria-label="Loading history"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            className="h-1.5 w-24 rounded-full overflow-hidden shrink-0"
            style={{ border: `1px solid ${COLORS.textMuted}` }}
          >
            <div className="h-full" style={{ width: `${(ratio * 100).toFixed(1)}%`, background: COLORS.holoBright }} />
          </div>
        </div>
      )}
    </>
  )
}
