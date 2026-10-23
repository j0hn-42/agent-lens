'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { COLORS } from '@/lib/colors'
import { CAMERA, TOOL_EXPIRY_CHOICES_S } from '@/lib/canvas-constants'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import type { CalmLayers, MotionLayer } from '@/lib/motion-layers'
import { translate, type Locale, type MessageKey } from '@/lib/messages'
import { Button, buttonClass, buttonStyle } from '@/components/ui/button'
import { NO_HIDDEN_NAMES, type HiddenNamesDisplay } from '@/lib/hidden-names-display'
import { GraphLegend } from './graph-legend'
import { MotionLayerControls } from './motion-layer-controls'
import { useDockSnapshot } from './shared-ui'
import { canvasControlsFit, useCanvasControlsSlot } from './canvas-controls-slot'
import { useTourBridge, CANVAS_CONTROLS_MENU_ID } from './guided-tour-context'

/** The look of the control buttons, for the one label that must match them */
const CONTROL_BUTTON_CLASS = buttonClass('control')

interface CanvasControlsProps {
  /** Teams of the accessible model (legend) */
  teams: ComponentProps<typeof GraphLegend>['teams']
  /** Legend entries proven on screen (the legend lists only these unless asked for the complete list) */
  present?: ComponentProps<typeof GraphLegend>['present']
  zoomBy: (factor: number) => void
  doZoomToFit: () => void
  animationsPaused: boolean
  /** The OS asks for reduced motion: the pause toggle is locked on */
  pausedBySystem: boolean
  locale: Locale
  calmLayers: CalmLayers
  onToggleCalmLayer: (layer: MotionLayer) => void
  neverHide: boolean
  toolExpiryS: number
  onToggleAnimationsPaused: () => void
  onToggleNeverHide: () => void
  onChangeToolExpiry: (e: ChangeEvent<HTMLSelectElement>) => void
  /**
   * The "names hidden" button (issue 594), from the stable readings of planOverlays().hiddenAgentNames
   * (useHiddenNamesDisplay): drawn or not, and its number (null = neutral label, no number). Absent = no button.
   */
  hiddenNames?: HiddenNamesDisplay
  /** Opens the Sessions and agents list (the L panel). Absent = no button, and no room reserved for it */
  onShowAgentList?: () => void
  /** The single key that opens that list, quoted in the tooltip; null when single-key shortcuts are off */
  agentListKey?: string | null
  /**
   * #372: a counter raised by Settings > General ("Open View controls"). Each new value opens the View popover (and the
   * folded "Canvas controls" block first when the controls are folded) and puts the focus on its first control that
   * can take it; Escape gives it back to View. A value already there when the controls mount is not replayed.
   */
  openViewRequest?: number
}

const ICON_PROPS = {
  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
} as const

function MagnifierIcon({ sign }: { sign: 'plus' | 'minus' }) {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
      <path d={sign === 'plus' ? 'M5 7h4M7 5v4' : 'M5 7h4'} />
    </svg>
  )
}

function FitIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 4h7M12 4h2M2 12h2M7 12h7" />
      <circle cx="10.5" cy="4" r="1.5" />
      <circle cx="5.5" cy="12" r="1.5" />
    </svg>
  )
}

const BUTTON_STYLE = buttonStyle('control')

/** A toggle of the View panel: a visible check mark (aria-hidden) says "on" besides the colour */
function PanelToggle({ pressed, disabled, title, onClick, children }: {
  pressed: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode
}) {
  return (
    <Button
      variant="control"
      active={pressed}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="justify-start gap-1"
    >
      <span aria-hidden="true" className="inline-block w-3">{pressed ? '\u2713' : ''}</span>
      {children}
    </Button>
  )
}

/**
 * Closes a popup on a press outside its block, Escape (focus back on its button) and Tab-out. Native listeners on the
 * block (no JSX handlers on a static element). Escape closes this popup only: the global Escape (close the latest
 * panel, clear the selection) must not also fire, and an inner popup handles it first.
 */
function usePopupDismiss(open: boolean, wrapRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLButtonElement | null>, close: () => void) {
  useEffect(() => {
    const wrap = wrapRef.current
    if (!open || !wrap) return
    const onDown = (e: MouseEvent) => {
      if (wrap.contains(e.target as Node)) return
      const hadFocus = wrap.contains(document.activeElement)
      close()
      // A press on a spot that takes no focus (the canvas, the page): the focused control of the popup goes away and the
      // focus would fall to <body>; it goes back to the popup's button, as with Escape (WCAG 2.4.3, #613). A press on a
      // control that takes the focus keeps it there: checked once the browser has moved it.
      if (hadFocus) setTimeout(() => {
        const active = document.activeElement
        if ((!active || active === document.body) && buttonRef.current?.isConnected) buttonRef.current.focus({ preventScroll: true })
      }, 0)
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
      buttonRef.current?.focus()
    }
    // relatedTarget is null for a click on a non-focusable spot: the mousedown handler deals with it
    const onFocusOut = (e: globalThis.FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && !wrap.contains(next)) close()
    }
    document.addEventListener('mousedown', onDown)
    wrap.addEventListener('keydown', onKeyDown)
    wrap.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('mousedown', onDown)
      wrap.removeEventListener('keydown', onKeyDown)
      wrap.removeEventListener('focusout', onFocusOut)
    }
  }, [open, wrapRef, buttonRef, close])
}

/**
 * Legend, guided tour, zoom block (three icon buttons) and one "View" button that opens the comfort settings in a small
 * panel under it. When they do not fit between the two bars (#515) they fold into one "Canvas controls" button at the
 * end of the playback bar, which opens them above the bar, in the same order.
 */
export function CanvasControls({
  teams, present, zoomBy, doZoomToFit, animationsPaused, pausedBySystem, locale, calmLayers, onToggleCalmLayer, neverHide, toolExpiryS,
  onToggleAnimationsPaused, onToggleNeverHide, onChangeToolExpiry, hiddenNames = NO_HIDDEN_NAMES, onShowAgentList, agentListKey = null,
  openViewRequest = 0,
}: CanvasControlsProps) {
  const { env } = useDockSnapshot()
  const { controlBarH } = env
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const closeView = useCallback(() => setOpen(false), [])
  usePopupDismiss(open, wrapRef, viewRef, closeView)

  // Folded only into a slot that is drawn (the control bar is hidden in full screen)
  const slot = useCanvasControlsSlot()
  const slotDrawn = slot !== null && (slot.parentElement?.getClientRects().length ?? 0) > 0
  const showHiddenNames = hiddenNames.shown && !!onShowAgentList
  // The room of the "names hidden" button is reserved whenever it can be shown, so folding never follows the zoom (#594)
  const folded = slotDrawn && !canvasControlsFit(env, !!onShowAgentList)
  const [menuOpen, setMenuOpen] = useState(false)
  // The guided tour can show the legend: the folded block opens with it. Escape or a press outside still closes it
  // (until the tour stops showing the legend), so the block never stays open with the focus sent back to its button
  const { legendOpen: tourWantsLegend } = useTourBridge()
  const [tourLegendDismissed, setTourLegendDismissed] = useState(false)
  if (!tourWantsLegend && tourLegendDismissed) setTourLegendDismissed(false)
  const menuShown = folded && (menuOpen || (tourWantsLegend && !tourLegendDismissed))
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    if (tourWantsLegend) setTourLegendDismissed(true)
  }, [tourWantsLegend])
  usePopupDismiss(menuShown, menuRef, menuButtonRef, closeMenu)

  // #372: opened from Settings. The request is taken once (its value changed); the focus waits for the render that
  // draws the popover, after the Settings dialog gave the focus back to its opener
  const panelRef = useRef<HTMLDivElement>(null)
  const takenRequest = useRef(openViewRequest)
  const focusPanelNext = useRef(false)
  // The request is also state: with the popover already open, setOpen(true) changes nothing, and the focus effect
  // below must still run for it
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    if (openViewRequest === takenRequest.current) return
    takenRequest.current = openViewRequest
    focusPanelNext.current = true
    setOpen(true)
    if (folded) setMenuOpen(true)
    setFocusRequest(n => n + 1)
  }, [openViewRequest, folded])
  // A pending focus does not survive the popover closing: a later opening by hand must not move the focus
  useEffect(() => { if (!open) focusPanelNext.current = false }, [open])
  useEffect(() => {
    if (!focusPanelNext.current || !open) return
    const first = panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled])')
    if (!first) return
    focusPanelNext.current = false
    first.focus()
  }, [open, menuShown, focusRequest])

  // Folding or unfolding with the focus on a control removes that control: the focus goes to the one that replaces it,
  // not to <body> (2.4.3). Same when the "names hidden" button goes with the focus on it (#594)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusWasInside = useRef(false)
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!(rootRef.current?.contains(target) || menuRef.current?.contains(target))
    const onFocusIn = (e: globalThis.FocusEvent) => { focusWasInside.current = inside(e.target) }
    // A press on a spot that cannot take the focus sends it to <body> without any focusin: the focus has left
    const onPointerDown = (e: PointerEvent) => { if (!inside(e.target)) focusWasInside.current = false }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])
  useLayoutEffect(() => {
    if (!focusWasInside.current) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const next = folded ? menuButtonRef.current : viewRef.current
    next?.focus()
  }, [folded, showHiddenNames])

  const legend = <GraphLegend teams={teams} present={present} locale={locale} />
  const hiddenNamesButton = showHiddenNames && (
    // Its text is its name (2.5.3); no live region: the count follows the zoom and must not chatter (issue 594). With no
    // stable count to show (it is changing), the neutral label names the list it opens: never a stale number
    <Button
      variant="control"
      data-hidden-names={hiddenNames.count ?? ''}
      title={t('controls.hiddenNames.title', { panel: agentListKey ? `${t('sessions.title')} (${agentListKey})` : t('sessions.title') })}
      onClick={onShowAgentList}
    >
      {hiddenNames.count === null
        ? t('sessions.title')
        : t(new Intl.PluralRules(locale).select(hiddenNames.count) === 'one' ? 'controls.hiddenNames.one' : 'controls.hiddenNames.other', { n: hiddenNames.count })}
    </Button>
  )
  const zoomAndView = (
    <div ref={wrapRef} className="pointer-events-auto flex max-w-full flex-col items-end gap-1 self-end">
      {/* Issue 594: the "names hidden" button comes BEFORE the zoom buttons, on the side the row is not anchored to, so
          its coming, going or width never moves Zoom, Fit or View under the pointer. Under the width where it does not
          fit beside them it wraps onto the line above (normal wrap, the row grows upwards from the playback bar). It
          reserves no edge (only the zoom row carries data-canvas-inset): the count does not change the safe area it is
          computed in. Folded, the block scrolls from its top: the button goes last, under the zoom buttons */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!folded && hiddenNamesButton}
        {/* Sits on the playback bar: "Fit to view" keeps the content above it (issue 378). Folded, the bar holds it */}
        <div data-canvas-inset={folded ? undefined : 'bottom'} className="flex flex-wrap items-center justify-end gap-2">
          <div role="group" aria-label={t('controls.zoomGroup')} className="flex gap-1">
            <Button
              variant="control"
              aria-label={t('controls.zoomIn')}
              title={`${t('controls.zoomIn')} (+)`}
              onClick={() => zoomBy(CAMERA.keyboardZoomStep)}
            >
              <MagnifierIcon sign="plus" />
            </Button>
            <Button
              variant="control"
              aria-label={t('controls.zoomOut')}
              title={`${t('controls.zoomOut')} (-)`}
              onClick={() => zoomBy(1 / CAMERA.keyboardZoomStep)}
            >
              <MagnifierIcon sign="minus" />
            </Button>
            <Button
              variant="control"
              aria-label={t('controls.fit')}
              title={`${t('controls.fit')} (0)`}
              onClick={doZoomToFit}
            >
              <FitIcon />
            </Button>
          </div>
          <Button
            ref={viewRef}
            variant="control"
            active={open}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(o => !o)}
          >
            {t('controls.view')}
          </Button>
        </div>
        {folded && hiddenNamesButton}
      </div>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('controls.viewSettings')}
          className="flex max-w-full flex-col items-stretch gap-1 rounded-md p-2"
          style={{ ...BUTTON_STYLE }}
        >
          <PanelToggle
            pressed={animationsPaused || pausedBySystem}
            disabled={pausedBySystem}
            title={pausedBySystem ? t('motion.lockedBySystem') : undefined}
            onClick={onToggleAnimationsPaused}
          >
            {t('controls.pause')}
          </PanelToggle>
          <MotionLayerControls locale={locale} calm={calmLayers} lock={pausedBySystem ? 'system' : animationsPaused ? 'pause' : null} onToggle={onToggleCalmLayer} />
          <PanelToggle pressed={neverHide} onClick={onToggleNeverHide}>{t('controls.keepCards')}</PanelToggle>
          <label className={`${CONTROL_BUTTON_CLASS} flex-wrap justify-between gap-1`} style={BUTTON_STYLE}>
            {t('controls.expireAfter')}
            <select value={toolExpiryS} onChange={onChangeToolExpiry} className="bg-transparent font-mono text-[11px]" style={{ color: COLORS.textPrimary }}>
              {TOOL_EXPIRY_CHOICES_S.map(n => (
                <option key={n} value={n} style={{ color: COLORS.textPrimary, background: 'var(--lens-surface)' }}>{n >= 60 ? t('controls.minutes', { n: n / 60 }) : t('controls.seconds', { n })}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )

  if (folded && slot) {
    // Opens above the playback bar (its glass card is the containing block) and over the top bar while open (the
    // playback bar is above it), never past the window: it scrolls instead
    const maxHeight = Math.max(0, env.viewport.h - CONTROL_BAR_BOTTOM - controlBarH - 2 * DOCK_GAP)
    return createPortal(
      <div ref={menuRef} lang={locale} className="ml-auto shrink-0">
        <Button
          ref={menuButtonRef}
          id={CANVAS_CONTROLS_MENU_ID}
          variant="control"
          active={menuShown}
          aria-label={t('controls.canvasMenu')}
          title={t('controls.canvasMenu')}
          aria-expanded={menuShown}
          aria-controls={menuShown ? menuId : undefined}
          onClick={() => { if (menuShown) closeMenu(); else setMenuOpen(true) }}
        >
          <SlidersIcon />
        </Button>
        {menuShown && (
          <div
            id={menuId}
            role="group"
            aria-label={t('controls.canvasMenu')}
            className="absolute bottom-full right-0 mb-2 flex w-max max-w-full flex-wrap items-end gap-2 overflow-y-auto rounded-md p-2 scroll-p-2"
            style={{ ...BUTTON_STYLE, maxHeight }}
          >
            {legend}
            {zoomAndView}
          </div>
        )}
      </div>,
      slot,
    )
  }

  return (
    <div
      ref={rootRef}
      lang={locale}
      className="pointer-events-none absolute inset-x-3 z-10 flex flex-col items-start gap-2 sm:flex-row sm:items-end sm:justify-between"
      style={{ bottom: CONTROL_BAR_BOTTOM + controlBarH + DOCK_GAP }}
    >
      {legend}
      {zoomAndView}
    </div>
  )
}
