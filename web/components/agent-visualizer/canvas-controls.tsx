'use client'

import { useEffect, useId, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { CAMERA, TOOL_EXPIRY_CHOICES_S } from '@/lib/canvas-constants'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import type { CalmLayers, MotionLayer } from '@/lib/motion-layers'
import { translate, type Locale, type MessageKey } from '@/lib/messages'
import { FOCUS_RING } from '@/lib/focus-ring'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { GraphLegend } from './graph-legend'
import { MotionLayerControls } from './motion-layer-controls'
import { useDockSnapshot } from './shared-ui'

const CONTROL_BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 py-1 text-[11px] font-mono '
  + `${TOUCH_TARGET} ${FOCUS_RING} disabled:opacity-60`

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

const BUTTON_STYLE = { background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }

/** A toggle of the View panel: a visible check mark (aria-hidden) says "on" besides the colour */
function PanelToggle({ pressed, disabled, title, onClick, children }: {
  pressed: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`${CONTROL_BUTTON_CLASS} justify-start gap-1`}
      style={{ ...BUTTON_STYLE, background: pressed ? COLORS.toggleActive : COLORS.panelBg }}
    >
      <span aria-hidden="true" className="inline-block w-3">{pressed ? '\u2713' : ''}</span>
      {children}
    </button>
  )
}

/** Zoom block (three icon buttons) and one "View" button that opens the comfort settings in a small panel under it */
export function CanvasControls({
  teams, present, zoomBy, doZoomToFit, animationsPaused, pausedBySystem, locale, calmLayers, onToggleCalmLayer, neverHide, toolExpiryS,
  onToggleAnimationsPaused, onToggleNeverHide, onChangeToolExpiry,
}: CanvasControlsProps) {
  const { controlBarH } = useDockSnapshot().env
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // Native listeners on the block (no JSX handlers on a static element): a press outside it, Escape and Tab-out all close the panel
  useEffect(() => {
    const wrap = wrapRef.current
    if (!open || !wrap) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Closes this panel only: the global Escape (close the latest panel, clear the selection) must not also fire
      e.stopPropagation()
      setOpen(false)
      viewRef.current?.focus()
    }
    // relatedTarget is null for a click on a non-focusable spot: the mousedown handler deals with it
    const onFocusOut = (e: globalThis.FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && !wrap.contains(next)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    wrap.addEventListener('keydown', onKeyDown)
    wrap.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('mousedown', onDown)
      wrap.removeEventListener('keydown', onKeyDown)
      wrap.removeEventListener('focusout', onFocusOut)
    }
  }, [open])

  return (
    <div
      lang={locale}
      className="pointer-events-none absolute inset-x-3 z-10 flex flex-col items-start gap-2 sm:flex-row sm:items-end sm:justify-between"
      style={{ bottom: CONTROL_BAR_BOTTOM + controlBarH + DOCK_GAP }}
    >
      <GraphLegend teams={teams} present={present} />
      <div ref={wrapRef} className="pointer-events-auto flex max-w-full flex-col items-end gap-1 self-end">
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t('controls.zoomGroup')} className="flex gap-1">
            <button
              type="button"
              aria-label={t('controls.zoomIn')}
              title={`${t('controls.zoomIn')} (+)`}
              onClick={() => zoomBy(CAMERA.keyboardZoomStep)}
              className={CONTROL_BUTTON_CLASS}
              style={BUTTON_STYLE}
            >
              <MagnifierIcon sign="plus" />
            </button>
            <button
              type="button"
              aria-label={t('controls.zoomOut')}
              title={`${t('controls.zoomOut')} (-)`}
              onClick={() => zoomBy(1 / CAMERA.keyboardZoomStep)}
              className={CONTROL_BUTTON_CLASS}
              style={BUTTON_STYLE}
            >
              <MagnifierIcon sign="minus" />
            </button>
            <button
              type="button"
              aria-label={t('controls.fit')}
              title={`${t('controls.fit')} (0)`}
              onClick={doZoomToFit}
              className={CONTROL_BUTTON_CLASS}
              style={BUTTON_STYLE}
            >
              <FitIcon />
            </button>
          </div>
          <button
            ref={viewRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(o => !o)}
            className={CONTROL_BUTTON_CLASS}
            style={{ ...BUTTON_STYLE, background: open ? COLORS.toggleActive : COLORS.panelBg }}
          >
            {t('controls.view')}
          </button>
        </div>
        {open && (
          <div
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
    </div>
  )
}
