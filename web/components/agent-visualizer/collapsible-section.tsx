'use client'

import type { ReactNode } from 'react'

/**
 * Foldable block animated through grid-template-rows (0fr / 1fr). The content stays mounted, so it is
 * made inert when closed: no tab stop, no click, and hidden from screen readers. The animation itself
 * lives in the stylesheet ([data-collapsible]) where reduced motion switches it off.
 * Open, the wrapper clips with a margin wider than the focus ring (2px outline + 2px offset) so the
 * ring of the first, last and full-width rows stays visible; closed, it clips hard.
 */
export function CollapsibleSection({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      data-collapsible
      aria-hidden={!open || undefined}
      inert={!open}
      style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div className={open ? 'min-h-0 overflow-clip [overflow-clip-margin:6px]' : 'min-h-0 overflow-hidden'}>{children}</div>
    </div>
  )
}
