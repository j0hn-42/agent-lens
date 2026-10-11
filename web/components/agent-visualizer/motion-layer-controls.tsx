'use client'

import { COLORS } from '@/lib/colors'
import { MOTION_LAYERS, type CalmLayers, type MotionLayer } from '@/lib/motion-layers'
import { translate, type Locale } from '@/lib/messages'

const BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 py-1 text-[11px] font-mono '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lens-focus)] disabled:opacity-60'

interface MotionLayerControlsProps {
  locale: Locale
  calm: CalmLayers
  /** The OS asks for reduced motion: every layer is calm and cannot be changed */
  lockedBySystem: boolean
  onToggle: (layer: MotionLayer) => void
}

/** One toggle per canvas layer: pressed = this layer's ambient motion is off. */
export function MotionLayerControls({ locale, calm, lockedBySystem, onToggle }: MotionLayerControlsProps) {
  return (
    <div role="group" lang={locale} aria-label={translate(locale, 'motion.group')} className="flex flex-wrap justify-end gap-1">
      {MOTION_LAYERS.map(layer => {
        const pressed = lockedBySystem || calm[layer]
        return (
          <button
            key={layer}
            type="button"
            aria-pressed={pressed}
            disabled={lockedBySystem}
            title={lockedBySystem ? translate(locale, 'motion.lockedBySystem') : undefined}
            onClick={() => onToggle(layer)}
            className={BUTTON_CLASS}
            style={{
              background: pressed ? COLORS.toggleActive : COLORS.panelBg,
              border: `1px solid ${COLORS.controlBorder}`,
              color: COLORS.textPrimary,
            }}
          >
            {translate(locale, `motion.layer.${layer}`)}
          </button>
        )
      })}
    </div>
  )
}
