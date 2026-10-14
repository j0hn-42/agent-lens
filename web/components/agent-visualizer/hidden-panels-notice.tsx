'use client'

import { SCENE } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { SHEET_NOTICE_H } from '@/lib/panel-layout'
import { hiddenPanelsText } from '@/lib/ui-glossary'
import { useDockSnapshot } from './shared-ui'

/**
 * Says which open panels a one-at-a-time sheet hides (narrow viewport or no room, #410). The list comes from the
 * dock layout itself, so it names exactly the panels that are open and not drawn. Nothing when none is hidden.
 */
export function HiddenPanelsNotice() {
  const { layout, env } = useDockSnapshot()
  const text = hiddenPanelsText(layout.hidden)
  return (
    <div role="status" data-testid="hidden-panels-notice">
      {text && (
        <p
          className="absolute left-2 right-2 m-0 px-2 py-1 rounded text-xs leading-tight pointer-events-none"
          style={{
            top: env.topbarH + 2, height: SHEET_NOTICE_H - 4, overflow: 'hidden', zIndex: Z.detailCard, fontFamily: "'SF Mono', 'Fira Code', monospace",
            background: SCENE.holoBg10, border: `1px solid ${SCENE.controlBorder}`, color: SCENE.textPrimary,
          }}
        >
          {text}
        </p>
      )}
    </div>
  )
}
