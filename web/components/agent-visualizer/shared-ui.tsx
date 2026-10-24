'use client'

import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { shouldRestoreFocus } from '@/lib/chrome-utils'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useClickOutside } from '@/hooks/use-click-outside'
import {
  dockStore, dockServerSnapshot, placePopup, dockWidthBounds, dockWidthForDrag, clampDockWidth,
  SHEET_BREAKPOINT, bottom as rectBottom, type PanelId, type Rect, type DockSnapshot,
} from '@/lib/panel-layout'
import { isFocusInOtherDialog, stopPropagationHandlers, panelStopPropagationHandlers, createPanelFocusController, type PanelFocusController } from '@/lib/menu-utils'
import { FOCUS_RING } from '@/lib/focus-ring'
import { DRAWER_COMPANIONS, DRAWER_FOCUSABLE, PERMISSION_HEIGHT_VAR, TOUCH_TARGET, nextTrapTarget } from '@/lib/mobile-view'
import { useMobileView } from '@/hooks/use-mobile-view'
import { GlassCard } from './glass-card'
import { withHexAlpha } from '@/lib/color-alpha'

// ─── Stop Propagation Handlers ──────────────────────────────────────────────
// Prevents canvas drag/click events from firing when interacting with panels

export { stopPropagationHandlers, panelStopPropagationHandlers }

// ─── Close Button ───────────────────────────────────────────────────────────

interface CloseButtonProps {
  onClick: () => void
  className?: string
  /** Accessible name (translated by the caller when its panel is) */
  label?: string
}

export function CloseButton({ onClick, className = '', label = 'Close' }: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-panel-close
      className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center justify-center rounded text-xs transition-colors hover:bg-[color:var(--lens-hover)] ${FOCUS_RING} ${className}`}
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
  /** Accessible name of the close button, in the language of the panel (default: Close) */
  closeLabel?: string
}

export function PanelHeader({ children, onClose, className = 'mb-2', actions, titleId, closeLabel }: PanelHeaderProps) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <h2 id={titleId} className="m-0 flex min-w-0 items-center gap-2 text-inherit font-normal">
        {children}
      </h2>
      <div className="flex items-center gap-1">
        {actions}
        <CloseButton onClick={onClose} label={closeLabel} />
      </div>
    </div>
  )
}

// ─── Dialog behaviour ───────────────────────────────────────────────────────
// Focus the container on open, restore focus on close, close on Escape (non-modal
// popups). Moving focus outside closes only when a caller opts in (closeOnFocusOutside);
// every current dialog opts out, since focus moving is not a request to close (WCAG 3.2.2 / 2.4.3).
// The one exception is DetailPopup's own focusin listener: it closes when focus enters a permission card the popup
// covers, because the focused button would be hidden (WCAG 2.4.7, #536).

/**
 * Marks the controls tied to the inspector (Sessions button and panel, #115). Since #380 nothing closes the
 * inspector on focus-out, so no code reads this attribute any more; it is kept as an inert marker and can be
 * removed with its call sites.
 */
export const INSPECTOR_KEEP_ATTR = 'data-keeps-inspector'

export function useDialogBehavior(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { closeOnFocusOutside?: boolean; focusOnOpen?: boolean } = {},
): void {
  const { closeOnFocusOutside = true, focusOnOpen = true } = options
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
      onCloseRef.current()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [ref, closeOnFocusOutside])
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
  /** Free text of the session: blurred in presentation mode (#245) */
  sensitive?: boolean
  children: ReactNode
}

export function DetailPopup({ position, width, estimatedHeight, onClose, titleId, children, sensitive }: DetailPopupProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { env } = useDockSnapshot()
  // Between the top bar and the control bar, inside the viewport (never over either bar)
  const placed = placePopup(position, { w: width, h: estimatedHeight }, env)

  useClickOutside(ref, onClose)
  // Tabbing away is not a request to close (WCAG 3.2.2, 2.4.3): Escape, Close and a click outside still do. The only
  // exception is below: focus entering a permission card that this popup covers.
  useDialogBehavior(ref, onClose, { closeOnFocusOutside: false })
  // Over the lower part of the permission cards (the height floor, only when there is no room under nor beside them,
  // #558), the popup would hide a button that takes focus: it closes when focus enters a card (WCAG 2.4.7, #536).
  // Elsewhere, tabbing away stays harmless.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const covers = placed.coversCards
  useEffect(() => {
    if (!covers) return
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-permission-requests]')) onCloseRef.current()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [covers])

  return (
    // Event boundary of the popup (Escape, and pointer events kept from the scene): a box-less
    // presentational wrapper, so the dialog itself carries no handler (display: contents).
    <div role="presentation" style={{ display: 'contents' }} onKeyDown={dialogEscapeHandler(onClose)} {...stopPropagationHandlers}>
      <div
        ref={ref}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-sensitive={sensitive ? '' : undefined}
        className="outline-none"
        style={{ position: 'absolute', left: placed.left, top: placed.top, width: placed.width, zIndex: Z.detailCard }}
      >
        <GlassCard visible={true} style={{ maxHeight: placed.maxHeight, overflowY: 'auto' }}>
          {children}
        </GlassCard>
      </div>
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
  /** Edge of the panel the handle hugs: 'left' for a panel anchored right (default), 'right' for one anchored left. */
  edge?: 'left' | 'right'
  /** Range of the width, when it depends on more than the viewport (free room beside the panel). */
  bounds?: { min: number; max: number }
  /** Spoken value of the width, in the language of the panel (default: "<n> pixels wide") */
  valueText?: (px: number) => string
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
export function DockResizer({ width, onWidthChange, label = 'Resize panel', controls, edge = 'left', bounds, valueText }: DockResizerProps) {
  const onRight = edge === 'right'
  const side = onRight ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'
  const { layout, env } = useDockSnapshot()
  const vw = env.viewport.w
  const current = Math.round(width ?? layout.rightWidth)
  const { min, max } = bounds ?? dockWidthBounds(vw)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const apply = (w: number) => {
    const next = bounds ? Math.round(Math.min(Math.max(w, min), max)) : clampDockWidth(w, vw)
    if (onWidthChange) { onWidthChange(next); return }
    dockStore.setRightWidth(next)
    userResizeListeners.forEach(l => l(next))
  }
  if (vw < SHEET_BREAKPOINT) return null
  // The step divides the range exactly, so End lands on the real maximum (a fixed step from `min` can
  // miss `max` by up to step-1 px at some viewport widths and then input and layout disagree)
  const step = dockResizerStep(min, max)

  return (
    <div data-dock-resizer className={`absolute inset-y-0 z-10 w-0 ${onRight ? 'right-0' : 'left-0'}`}>
      <input
        type="range"
        aria-label={label}
        aria-controls={controls}
        aria-orientation="horizontal"
        aria-valuetext={valueText ? valueText(current) : `${current} pixels wide`}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, current))}
        onChange={(e) => apply(Number(e.currentTarget.value))}
        onKeyDown={(e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation() }}
        className={`peer absolute top-1/2 m-0 h-12 w-6 -translate-y-1/2 opacity-0 pointer-events-none ${side}`}
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
          if (d) apply(onRight ? d.startW + (e.clientX - d.startX) : dockWidthForDrag(d.startW, d.startX, e.clientX, vw))
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* already released */ }
        }}
        onPointerCancel={() => { dragRef.current = null }}
        className={`group absolute inset-y-0 flex w-6 cursor-col-resize touch-none items-stretch justify-center peer-focus-visible:[&>span]:bg-[color:var(--lens-focus)] peer-focus-visible:[&>span]:outline peer-focus-visible:[&>span]:outline-2 peer-focus-visible:[&>span]:outline-offset-2 peer-focus-visible:[&>span]:outline-[color:var(--lens-focus)] ${side}`}
      >
        <span
          className="my-auto h-12 w-1 rounded-full bg-[color:var(--lens-grip)] transition-colors group-hover:bg-[color:var(--lens-grip-hover)]"
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
  /** Accessible name of the mobile drawer when no heading id is given (`labelledBy` wins) */
  label?: string
  /**
   * Language of `label`. An aria-label cannot declare its language (WCAG 3.1.2), so with this the drawer is named by a
   * visually hidden element carrying lang instead. The drawer itself gets no lang: its body may still be in another language.
   */
  labelLang?: string
  children: ReactNode
}

/**
 * Below 768 px (#476) an open SlidingPanel is a drawer: a dialog the full width of the viewport that keeps Tab inside
 * it (and the permission cards and truncation notice drawn above it, so it is not aria-modal) and closes on Escape
 * through its own Close button. Opening and closing move the focus as
 * on desktop (createPanelFocusController). Native listeners: no JSX handler on a static element.
 */
function useDrawerKeys(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    // Only what Tab can reach: a roving-tabindex row (tabindex -1) or a control that is not drawn (display: none,
    // visibility: hidden) is skipped by the browser, so it must not count as the first or last one
    // (checkVisibility is missing in jsdom: kept there)
    const tabbable = (root: Element) => Array.from(root.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE)).filter(n => n.tabIndex >= 0 && !n.closest('[inert]') && !n.closest('[hidden]')
      && (typeof n.checkVisibility !== 'function' || n.checkVisibility({ visibilityProperty: true })))
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      // The permission cards and the truncation notice stay drawn above the drawer (#410, #453): they share its Tab
      // cycle, first (they sit above it). Focus elsewhere (a tap on the top bar) is left alone: a soft trap.
      const companions = Array.from(document.querySelectorAll(DRAWER_COMPANIONS)).filter(c => !c.closest('[aria-hidden="true"]') && !c.closest('[inert]'))
      const inCycle = (n: Node | null) => !!n && (el.contains(n) || companions.some(c => c.contains(n)))
      if (!inCycle(e.target as Node | null)) return
      const segments = [...companions.map(tabbable), tabbable(el)]
      const active = document.activeElement instanceof HTMLElement && inCycle(document.activeElement) ? document.activeElement : null
      const target = nextTrapTarget(segments, active, e.shiftKey)
      if (!target) return
      e.preventDefault()
      target.focus({ preventScroll: true })
      // A card or a drawer that scrolls (permission card open, #548) must show the control that took the focus:
      // the page itself never scrolls, so only the nearest scroll containers move. Missing in jsdom.
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
    // On window, after React's handlers: an Escape a control inside already took (stopPropagation) never gets here
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !(e.target instanceof Element) || !el.contains(e.target)) return
      if (e.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      const close = el.querySelector<HTMLElement>('[data-panel-close]')
      if (!close) return
      e.preventDefault()
      close.click()
    }
    window.addEventListener('keydown', onTab, true)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onTab, true)
      window.removeEventListener('keydown', onEscape)
    }
  }, [ref, active])
}

/**
 * With a permission card shown, a drawer starts under it (margin-top, see drawerStyle) and scrolls in the room left
 * above the bottom control bar (7.5rem), so it never reaches under that bar (#548). A scroll container clips what
 * is painted outside its padding box: the 5 px of padding (and of scroll-padding, so that a focused control scrolled
 * into view stops 5 px from the edge) hold the focus ring of a control at its edge (2 px outline, 2 px offset).
 */
const DRAWER_BELOW_CARD = '[html[data-permission-open]_&]:max-h-[calc(100dvh-var(--topbar-h,60px)-16px-var(--permission-h,0px)-7.5rem)] [html[data-permission-open]_&]:overflow-y-auto [html[data-permission-open]_&]:p-[5px] [html[data-permission-open]_&]:scroll-p-[5px]'

export function SlidingPanel({
  visible, position, axis = 'X', offset = 20,
  zIndex, width, className = '', style, labelledBy, autoFocus = true, attrs, label, labelLang, children,
}: SlidingPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<PanelFocusController | null>(null)
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  const drawer = useMobileView() && visible
  const labelId = useId()
  const langLabel = drawer && !labelledBy && label && labelLang ? label : undefined
  useDrawerKeys(ref, drawer)

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

  // Mobile drawer: a named dialog spanning the viewport width (8 px gutters, like a sheet of the dock layout)
  const drawerProps = drawer
    ? { role: 'dialog', 'aria-labelledby': labelledBy ?? (langLabel ? labelId : undefined), 'aria-label': labelledBy || langLabel ? undefined : label, 'data-mobile-drawer': '' }
    : { role: labelledBy ? 'region' : undefined, 'aria-labelledby': labelledBy }
  const drawerStyle: React.CSSProperties | undefined = drawer
    ? { left: 8, right: 'auto', marginTop: `var(${PERMISSION_HEIGHT_VAR}, 0px)`, width: 'calc(100vw - 16px)', maxWidth: 'calc(100vw - 16px)' }
    : undefined

  return (
    <div
      ref={ref}
      {...drawerProps}
      aria-hidden={!visible}
      inert={!visible}
      tabIndex={-1}
      {...attrs}
      {...panelStopPropagationHandlers}
      className={`absolute max-w-[calc(100vw-24px)] outline-none transition-[transform,opacity] duration-300 motion-reduce:transition-none ${drawer ? DRAWER_BELOW_CARD : ''} ${className}`}
      style={{
        ...position,
        opacity: visible ? 1 : 0,
        transform: `translate${axis}(${visible ? 0 : offset}px)`,
        pointerEvents: visible ? 'auto' : 'none',
        zIndex,
        width,
        ...style,
        ...drawerStyle,
      }}
    >
      {langLabel && <span id={labelId} lang={labelLang} className="sr-only">{langLabel}</span>}
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
          boxShadow: `0 0 6px ${withHexAlpha(color, '40')}`,
        }}
      />
    </div>
  )
}
