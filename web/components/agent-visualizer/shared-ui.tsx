'use client'

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { shouldRestoreFocus } from '@/lib/chrome-utils'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useClickOutside } from '@/hooks/use-click-outside'
import { clampPopupPosition } from '@/lib/clamp-popup-position'
import { isFocusInOtherDialog, stopPropagationHandlers, panelStopPropagationHandlers, createPanelFocusController, type PanelFocusController } from '@/lib/menu-utils'
import { GlassCard } from './glass-card'

// ─── Stop Propagation Handlers ──────────────────────────────────────────────
// Prevents canvas drag/click events from firing when interacting with panels

export { stopPropagationHandlers, panelStopPropagationHandlers }

// ─── Close Button ───────────────────────────────────────────────────────────

interface CloseButtonProps {
  onClick: () => void
  className?: string
}

export function CloseButton({ onClick, className = '' }: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      data-panel-close
      className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded text-xs transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99e0ff] ${className}`}
      style={{ color: COLORS.scrollBtnText }}
    >
      <span aria-hidden="true">✕</span>
    </button>
  )
}

// ─── Panel Header ───────────────────────────────────────────────────────────

interface PanelHeaderProps {
  children: ReactNode
  onClose: () => void
  className?: string
  actions?: ReactNode
  /** id for the heading so the surrounding dialog/region can reference it via aria-labelledby */
  titleId?: string
}

export function PanelHeader({ children, onClose, className = 'mb-2', actions, titleId }: PanelHeaderProps) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <h2 id={titleId} className="m-0 flex min-w-0 items-center gap-2 text-inherit font-normal">
        {children}
      </h2>
      <div className="flex items-center gap-1">
        {actions}
        <CloseButton onClick={onClose} />
      </div>
    </div>
  )
}

// ─── Dialog behaviour ───────────────────────────────────────────────────────
// Focus the container on open, restore focus on close, close on Escape and when
// focus moves outside (non-modal popups).

export function useDialogBehavior(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { closeOnFocusOutside?: boolean; ignoreSelector?: string } = {},
): void {
  const { closeOnFocusOutside = true, ignoreSelector } = options
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = ref.current
    node?.focus({ preventScroll: true })
    return () => {
      // Restore only when focus was dropped (Escape/Close unmount) or is still inside the
      // dialog; never pull it back from a control the user moved to.
      if (previous && previous !== document.body && previous.isConnected
        && shouldRestoreFocus(document.activeElement, node, document.body)) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [ref])

  useEffect(() => {
    if (!closeOnFocusOutside) return
    const onFocusIn = (e: FocusEvent) => {
      const el = ref.current
      if (!el || !(e.target instanceof Element) || el.contains(e.target)) return
      if (ignoreSelector && e.target.closest(ignoreSelector)) return
      onCloseRef.current()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [ref, closeOnFocusOutside, ignoreSelector])
}

/**
 * Escape arbitration (see use-keyboard-shortcuts.ts):
 * - The global handler is a window keydown listener (bubble phase). It ignores
 *   Escape coming from text fields and from inside role="dialog" elements
 *   (shouldHandleShortcut), and otherwise runs closeTopPanel() (LIFO stack of
 *   panels) and falls back to clearSelection().
 * - Dialogs and menus handle Escape locally on their own container and call
 *   stopPropagation(). React's synthetic stopPropagation also stops the native
 *   event before it reaches window, so one Escape closes exactly one layer:
 *   topmost menu/popup first, then panels (LIFO), then the selection.
 * - Panels (SlidingPanel) deliberately do NOT handle Escape themselves; they
 *   rely on the global LIFO stack.
 *
 * Escape handler for the dialog container; stops propagation so one Esc closes one thing. */
export function dialogEscapeHandler(onClose: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
  }
}

// ─── Detail Popup ──────────────────────────────────────────────────────────
// Shared wrapper for popup detail cards (tool detail, discovery detail, etc.)

interface DetailPopupProps {
  position: { x: number; y: number }
  width: number
  estimatedHeight: number
  onClose: () => void
  /** id of the heading element (PanelHeader titleId) labelling the dialog */
  titleId: string
  children: ReactNode
}

export function DetailPopup({ position, width, estimatedHeight, onClose, titleId, children }: DetailPopupProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { left, top } = clampPopupPosition(position, width, estimatedHeight)

  useClickOutside(ref, onClose)
  useDialogBehavior(ref, onClose)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={dialogEscapeHandler(onClose)}
      {...stopPropagationHandlers}
      className="max-w-[calc(100vw-24px)] outline-none"
      style={{ position: 'absolute', left, top, width, zIndex: Z.detailCard }}
    >
      <GlassCard visible={true}>
        {children}
      </GlassCard>
    </div>
  )
}

// ─── Sliding Panel ──────────────────────────────────────────────────────────
// Shared wrapper for panels that slide in/out with a visibility transition.

interface SlidingPanelProps {
  visible: boolean
  /** CSS positioning — e.g. { top: 12, right: 3 } */
  position: React.CSSProperties
  /** Slide direction: 'X' slides horizontally, 'Y' slides vertically */
  axis?: 'X' | 'Y'
  /** Pixel offset when hidden (default 20) */
  offset?: number
  zIndex: number
  width?: number | string
  className?: string
  style?: React.CSSProperties
  /** id of the heading labelling this region */
  labelledBy?: string
  /** Move focus to the panel (Close button) when it opens. Skipped automatically when a
   *  dialog elsewhere already owns focus (e.g. the agent detail card on agent selection). */
  autoFocus?: boolean
  children: ReactNode
}

export function SlidingPanel({
  visible, position, axis = 'X', offset = 20,
  zIndex, width, className = '', style, labelledBy, autoFocus = true, children,
}: SlidingPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<PanelFocusController | null>(null)
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus

  // Focus management lives here (not in the parent) so it works for every panel and does
  // not depend on wrapper elements such as display:contents divs. The decision logic is the
  // pure createPanelFocusController (two-frame delay, single focus owner, trigger restore).
  useEffect(() => {
    const controller = createPanelFocusController<HTMLElement>({
      captureTrigger: () => {
        const active = document.activeElement
        const el = ref.current
        return active instanceof HTMLElement && active !== document.body && !el?.contains(active) && !isFocusInOtherDialog(active, el) ? active : null
      },
      isConnected: (t) => t.isConnected,
      focus: (t) => t.focus({ preventScroll: true }),
      isFocusInOtherDialog: () => isFocusInOtherDialog(document.activeElement, ref.current),
      // `inert` has already dropped focus to <body> by now; never steal it from something the user moved to.
      canRestoreFocus: () => shouldRestoreFocus(document.activeElement, ref.current, document.body),
      focusPanel: () => {
        const el = ref.current
        if (!el) return
        const target = el.querySelector<HTMLElement>('[data-panel-close]')
          ?? el.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')
          ?? el
        target.focus({ preventScroll: true })
      },
    }, { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) },
    { get autoFocus() { return autoFocusRef.current } })
    controllerRef.current = controller
    return () => { controller.dispose(); controllerRef.current = null }
  }, [])

  useEffect(() => {
    controllerRef.current?.setVisible(visible)
  }, [visible])

  return (
    <div
      ref={ref}
      role={labelledBy ? 'region' : undefined}
      aria-labelledby={labelledBy}
      aria-hidden={!visible}
      inert={!visible}
      tabIndex={-1}
      {...panelStopPropagationHandlers}
      className={`absolute max-w-[calc(100vw-24px)] outline-none transition-all duration-300 motion-reduce:transition-none ${className}`}
      style={{
        ...position,
        opacity: visible ? 1 : 0,
        transform: `translate${axis}(${visible ? 0 : offset}px)`,
        pointerEvents: visible ? 'auto' : 'none',
        zIndex,
        width,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ─── Progress Bar ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  percent: number
  color: string
  trackColor?: string
  /** Accessible name; when omitted the bar is decorative (hidden from assistive tech) */
  label?: string
}

export function ProgressBar({ percent, color, trackColor = COLORS.holoBg10, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  const a11y = label
    ? { role: 'progressbar' as const, 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': clamped }
    : { 'aria-hidden': true as const }
  return (
    <div className="h-1 rounded-full overflow-hidden" style={{ background: trackColor }} {...a11y}>
      <div
        className="h-full rounded-full transition-all duration-500 motion-reduce:transition-none"
        style={{
          width: `${clamped}%`,
          background: color,
          boxShadow: `0 0 6px ${color}40`,
        }}
      />
    </div>
  )
}
