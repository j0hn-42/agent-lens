'use client'

import type { ReactNode } from 'react'
import { SCENE } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { SHEET_NOTICE_H, TOPBAR_STACK_TOP, TOPBAR_STACK_GAP, BANNER_MIN_TOP } from '@/lib/panel-layout'
import { hiddenPanelsText } from '@/lib/ui-glossary'
import { useDockSnapshot } from './shared-ui'

/**
 * Says which open panels a one-at-a-time sheet hides (narrow viewport or no room, #410). The list comes from the
 * dock layout itself, so it names exactly the panels that are open and not drawn. Nothing when none is hidden.
 * `contextOpen`: Context and Files share one dock slot, so the slot is named after the one that is open.
 * The line sits in the column under the top bar ({@link UnderTopbarStack}); its height is measured (data attribute
 * read by the dock store), so a long list or a larger text size grows the band instead of being cut.
 */
function HiddenPanelsNotice({ contextOpen = false }: { contextOpen?: boolean }) {
  const { layout } = useDockSnapshot()
  const text = hiddenPanelsText(layout.hidden, { context: contextOpen })
  return (
    <div role="status" data-testid="hidden-panels-notice">
      {text && (
        <p
          data-hidden-panels-notice=""
          className="relative m-0 px-2 py-1 rounded text-xs leading-tight pointer-events-none"
          style={{
            minHeight: SHEET_NOTICE_H - 4, zIndex: Z.info, fontFamily: "'SF Mono', 'Fira Code', monospace",
            background: SCENE.void, border: `1px solid ${SCENE.controlBorder}`, color: SCENE.textPrimary,
          }}
        >
          {text}
        </p>
      )}
    </div>
  )
}

/**
 * The column under the top bar (#453): the hidden-panels notice, then the truncation banner right under it. One
 * container, so the banner can never cover the notice; a sheet keeps the measured height of both free (see
 * topbarStack in lib/panel-layout, which places the banner the same way). Without a notice the banner keeps its own
 * slot, under the history-loading indicator. The container sets no z-index: the notice stays at its level and the
 * banner at the level of the chrome above the side panels.
 */
export function UnderTopbarStack({ contextOpen = false, banner }: { contextOpen?: boolean; banner?: ReactNode }) {
  const { layout, env } = useDockSnapshot()
  const noticeShown = hiddenPanelsText(layout.hidden, { context: contextOpen }) !== ''
  return (
    <div data-topbar-stack="" className="absolute left-2 right-2 pointer-events-none" style={{ top: env.topbarH + TOPBAR_STACK_TOP }}>
      <HiddenPanelsNotice contextOpen={contextOpen} />
      {banner && (
        <div
          data-banner-slot=""
          className="relative flex justify-center"
          style={{ marginTop: noticeShown ? TOPBAR_STACK_GAP : BANNER_MIN_TOP - TOPBAR_STACK_TOP, zIndex: Z.controlBar + 5 }}
        >
          <div className="pointer-events-auto max-w-full">{banner}</div>
        </div>
      )}
    </div>
  )
}
