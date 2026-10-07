'use client'

import { useCallback, useRef } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/chrome-utils'
import type { ToastItem, PauseSource } from '@/hooks/use-toasts'

interface ToastRegionProps {
  toasts: ToastItem[]
  onAction: (id: number) => void
  onDismiss: (id: number) => void
  /** Pause/resume the auto-dismiss timers (hover and keyboard focus inside the region) */
  onPause: (source: PauseSource, paused: boolean) => void
  /** Key cap of the keyboard Undo shortcut, or null when single-key shortcuts are off */
  undoKey?: string | null
}

/**
 * Non-blocking notifications. The outer element is a persistent polite live region; the
 * toasts live in a focusable "Notifications" region that pauses their timers while it is
 * hovered or focused, so the Undo button can be reached by keyboard (Tab) before it expires.
 */
export function ToastRegion({ toasts, onAction, onDismiss, onPause, undoKey = null }: ToastRegionProps) {
  const regionRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  const hadFocus = () => !!regionRef.current && regionRef.current.contains(document.activeElement)

  /** After a toast disappears under the focus ring, hand focus back instead of dropping it on <body>. */
  const settleFocus = useCallback((hadIt: boolean) => {
    if (!hadIt) return
    requestAnimationFrame(() => {
      const region = regionRef.current
      if (region && region.isConnected) { region.focus({ preventScroll: true }); return }
      const prev = prevFocusRef.current
      prevFocusRef.current = null
      if (prev && prev.isConnected) prev.focus({ preventScroll: true })
    })
  }, [])

  const handleFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget as Node | null
    if (!from || !e.currentTarget.contains(from)) {
      if (from instanceof HTMLElement) prevFocusRef.current = from
      onPause('focus', true)
    }
  }
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null
    if (!to || !e.currentTarget.contains(to)) onPause('focus', false)
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute left-3 right-3 bottom-24 flex flex-col items-center pointer-events-none"
      style={{ zIndex: Z.controlBar + 5 }}
    >
      {toasts.length > 0 && (
        <div
          ref={regionRef}
          role="region"
          aria-label="Notifications"
          tabIndex={0}
          onMouseEnter={() => onPause('hover', true)}
          onMouseLeave={() => onPause('hover', false)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={`pointer-events-auto flex flex-col items-center gap-2 rounded max-w-full ${FOCUS_RING}`}
        >
          {toasts.map(t => (
            <div
              key={t.id}
              className="glass-card flex items-center gap-3 px-3 py-1.5 text-xs font-mono max-w-[calc(100vw-24px)]"
              style={{ color: COLORS.textPrimary }}
            >
              <span className="min-w-0 break-words">
                {t.message}
                {t.actionLabel && undoKey && <span className="sr-only">. Press {undoKey.toUpperCase()} to {t.actionLabel.toLowerCase()}.</span>}
              </span>
              {t.actionLabel && (
                <button
                  type="button"
                  onClick={() => { const had = hadFocus(); onAction(t.id); settleFocus(had) }}
                  aria-keyshortcuts={undoKey ?? undefined}
                  title={undoKey ? `${t.actionLabel} (${undoKey.toUpperCase()})` : undefined}
                  className={`min-h-6 min-w-6 px-2 rounded text-xs font-semibold underline shrink-0 ${FOCUS_RING}`}
                  style={{ color: COLORS.holoBright }}
                >
                  {t.actionLabel}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => { const had = hadFocus(); onDismiss(t.id); settleFocus(had) }}
                className={`min-h-6 min-w-6 rounded shrink-0 ${FOCUS_RING}`}
                style={{ color: COLORS.textMuted }}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
