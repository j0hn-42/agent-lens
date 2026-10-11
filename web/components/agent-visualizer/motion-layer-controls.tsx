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
  /** Why every layer is already calm and cannot be changed: the OS asks for reduced motion, or Pause animations is on */
  lock: 'system' | 'pause' | null
  onToggle: (layer: MotionLayer) => void
}

/** One toggle per canvas layer: pressed = this layer's ambient motion is off. */
export function MotionLayerControls({ locale, calm, lock, onToggle }: MotionLayerControlsProps) {
  return (
    <div role="group" lang={locale} aria-label={translate(locale, 'motion.group')} className="flex flex-wrap justify-end gap-1">
      {MOTION_LAYERS.map(layer => {
        const pressed = lock !== null || calm[layer]
        return (
          <button
            key={layer}
            type="button"
            aria-pressed={pressed}
            disabled={lock !== null}
            title={lock ? translate(locale, lock === 'system' ? 'motion.lockedBySystem' : 'motion.lockedByPause') : undefined}
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
