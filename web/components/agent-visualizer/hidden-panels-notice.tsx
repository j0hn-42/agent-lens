'use client'

import { SCENE } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { SHEET_NOTICE_H } from '@/lib/panel-layout'
import { hiddenPanelsText } from '@/lib/ui-glossary'
import { useDockSnapshot } from './shared-ui'

/**
 * Says which open panels a one-at-a-time sheet hides (narrow viewport or no room, #410). The list comes from the
 * dock layout itself, so it names exactly the panels that are open and not drawn. Nothing when none is hidden.
 * `contextOpen`: Context and Files share one dock slot, so the slot is named after the one that is open.
 * The line sits in the band the layout keeps free under the top bar; its height is measured (data attribute read by
 * the dock store), so a long list or a larger text size grows the band instead of being cut.
 */
export function HiddenPanelsNotice({ contextOpen = false }: { contextOpen?: boolean }) {
  const { layout, env } = useDockSnapshot()
  const text = hiddenPanelsText(layout.hidden, { context: contextOpen })
  return (
    <div role="status" data-testid="hidden-panels-notice">
      {text && (
        <p
          data-hidden-panels-notice=""
          className="absolute left-2 right-2 m-0 px-2 py-1 rounded text-xs leading-tight pointer-events-none"
          style={{
            top: env.topbarH + 2, minHeight: SHEET_NOTICE_H - 4, zIndex: Z.info, fontFamily: "'SF Mono', 'Fira Code', monospace",
            background: SCENE.void, border: `1px solid ${SCENE.controlBorder}`, color: SCENE.textPrimary,
          }}
        >
          {text}
        </p>
      )}
    </div>
  )
}
