'use client'

import { FOCUS_RING } from '@/lib/focus-ring'
import { Z } from '@/lib/agent-types'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

/**
 * Visually hidden until a button inside takes focus, then shown under the Room titles button: it hangs from the
 * burrow's control column (`top-full right-0`), which sits below the top bar, so no focused row is drawn under the
 * bar. It stays `position: absolute` in both states: `sr-only focus-within:not-sr-only` would reset it to `static`,
 * make it a flex child beside the stage and shrink the scene while the list has focus.
 */
const LIST_CLASS = [
  'absolute right-0 top-full mt-1 m-0 flex max-h-[calc(100dvh-var(--topbar-h,60px)-6rem)] w-max max-w-[min(24rem,calc(100vw-2rem))] list-none flex-col gap-1 p-0 text-2xs font-mono',
  'size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]',
  'focus-within:h-auto focus-within:w-auto focus-within:overflow-y-auto focus-within:whitespace-normal focus-within:[clip-path:none]',
].join(' ')

export interface BurrowAgentListProps {
  label: string
  rows: BurrowRow[]
  selectedAgentId: string | null
  rowLabel: (row: BurrowRow) => string
  onAgentClick: (agentId: string) => void
  onAgentHover: (agentId: string | null) => void
}

/** The keyboard and screen reader path: one button per agent, the same pick as a click on its animal */
export function BurrowAgentList({ label, rows, selectedAgentId, rowLabel, onAgentClick, onAgentHover }: BurrowAgentListProps) {
  return (
    <ul aria-label={label} className={LIST_CLASS} style={{ color: 'var(--lens-ink)', zIndex: Z.info }}>
      {rows.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            aria-current={r.id === selectedAgentId ? 'true' : undefined}
            onClick={() => onAgentClick(r.id)}
            onFocus={() => onAgentHover(r.id)}
            onBlur={() => onAgentHover(null)}
            className={`w-full cursor-pointer rounded px-1.5 py-0.5 text-left ${FOCUS_RING}`}
            style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
          >
            {rowLabel(r)}
          </button>
        </li>
      ))}
    </ul>
  )
}
