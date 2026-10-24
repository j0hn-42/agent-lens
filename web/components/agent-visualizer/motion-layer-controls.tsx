'use client'

import { MOTION_LAYERS, type CalmLayers, type MotionLayer } from '@/lib/motion-layers'
import { translate, type Locale } from '@/lib/messages'
import { Button } from '@/components/ui/button'

interface MotionLayerControlsProps {
  locale: Locale
  calm: CalmLayers
  /** Why every layer is already calm and cannot be changed: the OS asks for reduced motion, or Freeze motion is on */
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
          <Button
            key={layer}
            variant="control"
            active={pressed}
            aria-pressed={pressed}
            disabled={lock !== null}
            title={lock ? translate(locale, lock === 'system' ? 'motion.lockedBySystem' : 'motion.lockedByPause') : undefined}
            onClick={() => onToggle(layer)}
          >
            {translate(locale, `motion.layer.${layer}`)}
          </Button>
        )
      })}
    </div>
  )
}
