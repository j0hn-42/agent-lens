'use client'

import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/chrome-utils'
import type { ToastItem } from '@/hooks/use-toasts'

interface ToastRegionProps {
  toasts: ToastItem[]
  onAction: (id: number) => void
  onDismiss: (id: number) => void
}

/** Non-blocking notifications, announced politely to screen readers. */
export function ToastRegion({ toasts, onAction, onDismiss }: ToastRegionProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute left-3 right-3 bottom-24 flex flex-col items-center gap-2 pointer-events-none"
      style={{ zIndex: Z.controlBar + 5 }}
    >
      {toasts.map(t => (
        <div
          key={t.id}
          className="glass-card pointer-events-auto flex items-center gap-3 px-3 py-1.5 text-xs font-mono max-w-[calc(100vw-24px)]"
          style={{ color: COLORS.textPrimary }}
        >
          <span className="min-w-0 break-words">{t.message}</span>
          {t.actionLabel && (
            <button
              type="button"
              onClick={() => onAction(t.id)}
              className={`min-h-6 min-w-6 px-2 rounded text-xs font-semibold underline shrink-0 ${FOCUS_RING}`}
              style={{ color: COLORS.holoBright }}
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            className={`min-h-6 min-w-6 rounded shrink-0 ${FOCUS_RING}`}
            style={{ color: COLORS.textMuted }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  )
}
