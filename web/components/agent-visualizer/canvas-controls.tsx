'use client'

import type { ChangeEvent, ComponentProps } from 'react'
import { COLORS } from '@/lib/colors'
import { CAMERA, TOOL_EXPIRY_CHOICES_S } from '@/lib/canvas-constants'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import { GraphLegend } from './graph-legend'
import { useDockSnapshot } from './shared-ui'

const CONTROL_BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 py-1 text-[11px] font-mono '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lens-focus)] disabled:opacity-60'

interface CanvasControlsProps {
  /** Teams of the accessible model (legend) */
  teams: ComponentProps<typeof GraphLegend>['teams']
  zoomBy: (factor: number) => void
  doZoomToFit: () => void
  animationsPaused: boolean
  /** The OS asks for reduced motion: the pause toggle is locked on */
  pausedBySystem: boolean
  neverHide: boolean
  toolExpiryS: number
  onToggleAnimationsPaused: () => void
  onToggleNeverHide: () => void
  onChangeToolExpiry: (e: ChangeEvent<HTMLSelectElement>) => void
}

/** Legend + camera / comfort controls: one block above the (wrapping) control bar, stacked when narrow so they never overlap */
export function CanvasControls({
  teams, zoomBy, doZoomToFit, animationsPaused, pausedBySystem, neverHide, toolExpiryS,
  onToggleAnimationsPaused, onToggleNeverHide, onChangeToolExpiry,
}: CanvasControlsProps) {
  const { controlBarH } = useDockSnapshot().env
  return (
    <div
      className="pointer-events-none absolute inset-x-3 z-10 flex flex-col items-start gap-2 sm:flex-row sm:items-end sm:justify-between"
      style={{ bottom: CONTROL_BAR_BOTTOM + controlBarH + DOCK_GAP }}
    >
      <GraphLegend teams={teams} />
      <div className="pointer-events-auto flex max-w-full flex-col items-end gap-1 self-end">
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(CAMERA.keyboardZoomStep)}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / CAMERA.keyboardZoomStep)}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            <span aria-hidden="true">{'−'}</span>
          </button>
          <button
            type="button"
            aria-label="Fit graph to view"
            onClick={doZoomToFit}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            Fit
          </button>
        </div>
        <button
          type="button"
          aria-pressed={animationsPaused || pausedBySystem}
          disabled={pausedBySystem}
          title={pausedBySystem ? 'Animations are reduced by your system settings' : undefined}
          onClick={onToggleAnimationsPaused}
          className={CONTROL_BUTTON_CLASS}
          style={{
            background: animationsPaused || pausedBySystem ? COLORS.toggleActive : COLORS.panelBg,
            border: `1px solid ${COLORS.controlBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          Pause animations
        </button>
        <button
          type="button"
          aria-pressed={neverHide}
          onClick={onToggleNeverHide}
          className={CONTROL_BUTTON_CLASS}
          style={{
            background: neverHide ? COLORS.toggleActive : COLORS.panelBg,
            border: `1px solid ${COLORS.controlBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          Keep cards visible
        </button>
        <label className={`${CONTROL_BUTTON_CLASS} gap-1`} style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}>
          Expire unanswered calls after
          <select value={toolExpiryS} onChange={onChangeToolExpiry} className="bg-transparent font-mono text-[11px]" style={{ color: COLORS.textPrimary }}>
            {TOOL_EXPIRY_CHOICES_S.map(n => (
              <option key={n} value={n} style={{ color: COLORS.textPrimary, background: 'var(--lens-surface)' }}>{n >= 60 ? `${n / 60} min` : `${n} s`}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
