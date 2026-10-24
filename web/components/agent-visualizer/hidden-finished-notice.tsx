'use client'

import { SCENE } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { hiddenDoneText } from '@/lib/inactive-agents'

interface HiddenFinishedNoticeProps {
  /** Finished agents the filter hides (all of them, see emptiedByHidingCount) */
  count: number
  /** Turns 'Hide inactive agents' off */
  onShow: () => void
  /** Id of the element that takes the focus when the notice unmounts (the button would otherwise drop it on <body>) */
  focusTargetId: string
}

/** Canvas notice when every agent is finished and hidden (#369). */
export function HiddenFinishedNotice({ count, onShow, focusTargetId }: HiddenFinishedNoticeProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center z-(--z-info) p-3 pointer-events-none" data-testid="hidden-finished-notice">
      <div className="text-center text-xs pointer-events-auto" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", color: SCENE.textMuted }}>
        <span>{hiddenDoneText(count)}</span>
        <span aria-hidden="true"> · </span>
        <button
          type="button"
          onClick={() => {
            document.getElementById(focusTargetId)?.focus()
            onShow()
          }}
          aria-label="Show finished agents"
          className={`min-h-6 min-w-6 px-2 py-1 rounded font-semibold ${FOCUS_RING}`}
          style={{ background: SCENE.holoBg10, border: `1px solid ${SCENE.controlBorder}`, color: SCENE.textPrimary }}
        >
          Show
        </button>
      </div>
    </div>
  )
}
