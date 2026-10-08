'use client'

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { shouldRestoreFocus } from '@/lib/chrome-utils'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useClickOutside } from '@/hooks/use-click-outside'
import {
  dockStore, dockServerSnapshot, placePopup, dockWidthBounds, dockWidthForDrag, clampDockWidth,
  SHEET_BREAKPOINT, bottom as rectBottom, type PanelId, type Rect, type DockSnapshot,
} from '@/lib/panel-layout'
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

/**
 * Controls the inspector card must survive focus moving to: the Sessions button and panel (#115). Choosing
 * another session there is how an agent leaves the view; closing the card first would clear the selection and
 * the "no longer listed" card could never appear.
 */
export const INSPECTOR_KEEP_ATTR = 'data-keeps-inspector'
export const INSPECTOR_IGNORE_SELECTOR = `[data-companion-panel], [${INSPECTOR_KEEP_ATTR}]`

export function useDialogBehavior(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { closeOnFocusOutside?: boolean; ignoreSelector?: string; focusOnOpen?: boolean } = {},
): void {
  const { closeOnFocusOutside = true, ignoreSelector, focusOnOpen = true } = options
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = ref.current
    if (focusOnOpen) node?.focus({ preventScroll: true })
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
  const { env } = useDockSnapshot()
  // Between the top bar and the control bar, inside the viewport (never over either bar)
  const placed = placePopup(position, { w: width, h: estimatedHeight }, env)

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
      className="outline-none"
      style={{ position: 'absolute', left: placed.left, top: placed.top, width: placed.width, zIndex: Z.detailCard }}
    >
      <GlassCard visible={true} style={{ maxHeight: placed.maxHeight, overflowY: 'auto' }}>
        {children}
      </GlassCard>
    </div>
  )
}

// ─── Dock layout ────────────────────────────────────────────────────────────
// Docked panels (agent card, link, files, timeline, conversation) get their rectangle from the shared
// layout in lib/panel-layout.ts, so no two panels overlap and none covers the bars.

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const serverSnapshot = () => dockServerSnapshot

/** The current dock layout and measured environment (viewport, bars, foreign panels). */
export function useDockSnapshot(): DockSnapshot {
  return useSyncExternalStore(dockStore.subscribe, dockStore.getSnapshot, serverSnapshot)
}

export interface DockPlacement {
  /** Rectangle assigned to this panel; null until the layout has run (use a CSS fallback then). */
  rect: Rect | null
  /** True when a sheet is showing another panel: render nothing for this one. */
  hidden: boolean
  /** True when panels are full-width sheets (narrow viewport or no room). */
  sheet: boolean
  /** Distance from the viewport bottom to the bottom of `rect` (for bottom-anchored panels). */
  bottomOffset: number
  /** Current right dock width (resizable). */
  rightWidth: number
}

/**
 * Register a panel in a dock while `open` is true and read its placement. A panel that mounts only
 * while open passes `true`; one that stays mounted passes its visibility.
 */
export function useDockPanel(id: PanelId, open: boolean): DockPlacement {
  useIsoLayoutEffect(() => {
    dockStore.setOpen(id, open)
    return () => dockStore.setOpen(id, false)
  }, [id, open])
  const { layout, env } = useDockSnapshot()
  const rect = open ? layout.rects[id] ?? null : null
  return {
    rect,
    hidden: open && layout.hidden.includes(id),
    sheet: layout.mode === 'sheet',
    bottomOffset: rect ? Math.max(0, env.viewport.h - rectBottom(rect)) : 0,
    rightWidth: layout.rightWidth,
  }
}

/** DOM id of a docked panel's root (target of the resizer's aria-controls). */
export const dockPanelDomId = (id: PanelId) => `dock-panel-${id}`

/** data-* attributes every docked panel carries: the dock it lives in (for the camera-fit reader). */
export function dockAttrs(id: PanelId, edge: 'left' | 'right' | 'bottom', placement: Pick<DockPlacement, 'sheet'>, visible = true) {
  return {
    id: dockPanelDomId(id),
    'data-dock-panel': id,
    'data-canvas-inset': visible && !placement.sheet ? edge : 'auto',
  }
}

export function useRightDockWidth(): [number, (w: number) => void] {
  const { layout } = useDockSnapshot()
  return [layout.rightWidth, (w: number) => dockStore.setRightWidth(w)]
}

// Listeners told when the USER resized the right dock (drag or keyboard), so the width can be persisted
// without persisting widths that were only clamped by a narrow viewport.
const userResizeListeners = new Set<(width: number) => void>()
export function subscribeDockUserResize(listener: (width: number) => void): () => void {
  userResizeListeners.add(listener)
  return () => { userResizeListeners.delete(listener) }
}

/** Keyboard step of the range input (px); 380, the default width, and 720, the largest, sit on its grid. */
export const RESIZER_STEP = 10

/** Native range step close to RESIZER_STEP that divides [min, max] into equal notches (max is reachable). */
export function dockResizerStep(min: number, max: number): number {
  const span = max - min
  if (!(span > 0)) return RESIZER_STEP
  return span / Math.max(1, Math.ceil(span / RESIZER_STEP))
}

interface DockResizerProps {
  /** Current width of the dock; defaults to the shared right dock width. */
  width?: number
  /** Called with the new (already clamped) width; defaults to updating the shared right dock width. */
  onWidthChange?: (width: number) => void
  /** Accessible name of the control. */
  label?: string
  /** id of the panel it resizes (aria-controls). */
  controls?: string
}

/**
 * Resizer for the right dock. Mount it as the FIRST child of the panel's positioned root (it hugs the
 * panel's left edge).
 * - Keyboard / assistive technology: a native <input type="range"> (width in px) laid over the handle with
 *   opacity 0, so it keeps its native semantics and keys: ArrowRight/ArrowUp widen, ArrowLeft/ArrowDown
 *   narrow, PageUp/PageDown take big steps, Home/End jump to the bounds. Its focus ring is drawn on the
 *   visible handle (peer-focus-visible).
 * - Pointer: the visible handle is aria-hidden and pointer-only (drag left to widen).
 * Renders nothing in sheet mode (narrow viewports have no resizable dock).
 */
export function DockResizer({ width, onWidthChange, label = 'Resize panel', controls }: DockResizerProps) {
  const { layout, env } = useDockSnapshot()
  const vw = env.viewport.w
  const current = Math.round(width ?? layout.rightWidth)
  const { min, max } = dockWidthBounds(vw)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const apply = (w: number) => {
    const next = clampDockWidth(w, vw)
    if (onWidthChange) { onWidthChange(next); return }
    dockStore.setRightWidth(next)
    userResizeListeners.forEach(l => l(next))
  }
  if (vw < SHEET_BREAKPOINT) return null
  // The step divides the range exactly, so End lands on the real maximum (a fixed step from `min` can
  // miss `max` by up to step-1 px at some viewport widths and then input and layout disagree)
  const step = dockResizerStep(min, max)

  return (
    <div data-dock-resizer className="absolute inset-y-0 left-0 z-10 w-0">
      <input
        type="range"
        aria-label={label}
        aria-controls={controls}
        aria-orientation="horizontal"
        aria-valuetext={`${current} pixels wide`}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, current))}
        onChange={(e) => apply(Number(e.currentTarget.value))}
        onKeyDown={(e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation() }}
        className="peer absolute left-0 top-1/2 m-0 h-12 w-6 -translate-x-1/2 -translate-y-1/2 opacity-0 pointer-events-none"
      />
      <div
        aria-hidden="true"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          dragRef.current = { startX: e.clientX, startW: current }
          try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* not capturable */ }
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (d) apply(dockWidthForDrag(d.startW, d.startX, e.clientX, vw))
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* already released */ }
        }}
        onPointerCancel={() => { dragRef.current = null }}
        className="group absolute inset-y-0 left-0 flex w-6 -translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center peer-focus-visible:[&>span]:bg-[#99e0ff] peer-focus-visible:[&>span]:outline peer-focus-visible:[&>span]:outline-2 peer-focus-visible:[&>span]:outline-offset-2 peer-focus-visible:[&>span]:outline-[#99e0ff]"
      >
        <span
          className="my-auto h-12 w-1 rounded-full bg-white/30 transition-colors group-hover:bg-white/60"
        />
      </div>
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
  /** Extra attributes on the root, e.g. dockAttrs(...) */
  attrs?: Record<string, string>
  children: ReactNode
}

export function SlidingPanel({
  visible, position, axis = 'X', offset = 20,
  zIndex, width, className = '', style, labelledBy, autoFocus = true, attrs, children,
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
      {...attrs}
      {...panelStopPropagationHandlers}
      className={`absolute max-w-[calc(100vw-24px)] outline-none transition-[transform,opacity] duration-300 motion-reduce:transition-none ${className}`}
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
