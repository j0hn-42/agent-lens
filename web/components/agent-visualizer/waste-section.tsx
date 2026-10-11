'use client'

import { useId } from 'react'
import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import { pluralize, truncatePath } from '@/lib/utils'
import { describeWaste, formatWasteTokens, wasteSummary, type WasteLedger } from '@/lib/waste'

/** Rows drawn at once; the rest is counted, never silently dropped. */
export const WASTE_ROWS_SHOWN = 20

interface WasteSectionProps {
  waste: WasteLedger
  agents?: ReadonlyMap<string, Agent>
  onOpenFile?: (filePath: string) => void
}

/**
 * Repeated reads and identical calls, as facts: what was seen twice and what the repeats cost. It never
 * says "wasted" for a call that may be intended, and it names what it cannot see.
 */
export function WasteSection({ waste, agents, onOpenFile }: WasteSectionProps) {
  const headingId = useId()
  const { items, uncompared, limitReached } = wasteSummary(waste)
  const shown = items.slice(0, WASTE_ROWS_SHOWN)
  const hidden = items.length - shown.length
  const note = { color: COLORS.textMuted }

  return (
    <section aria-labelledby={headingId} className="mb-2">
      <h3 id={headingId} className="m-0 mb-1 text-[11px] font-mono font-normal uppercase tracking-wider" style={{ color: COLORS.textPrimary }}>
        Repeated reads and calls
      </h3>
      {items.length === 0 ? (
        <p className="m-0 text-[11px] font-mono" style={note}>No repeat observed</p>
      ) : (
        <ul className="space-y-1 list-none p-0 m-0">
          {shown.map((item) => {
            const canOpen = Boolean(onOpenFile && item.kind === 'reread' && item.target.startsWith('/'))
            const agentName = agents?.get(item.agentId)?.displayName ?? item.agentId
            const target = item.kind === 'reread' ? truncatePath(item.target) : item.target
            const label = (
              <span className="text-[11px] font-mono truncate min-w-0 flex-1 text-left" style={{ color: COLORS.tool }}>
                {item.toolName} {target}
              </span>
            )
            return (
              <li
                key={`${item.agentId}\0${item.kind}\0${item.toolName}\0${item.target}`}
                className="rounded px-2 py-1.5"
                style={{ background: COLORS.fileCardBg, border: `1px solid ${COLORS.tool}30` }}
              >
                {canOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(item.target)}
                    title={item.target}
                    aria-label={`Open ${item.target}`}
                    className={`flex items-center gap-2 w-full min-h-6 rounded hover:brightness-125 ${FOCUS_RING}`}
                  >
                    {label}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 min-h-6" title={item.target}>{label}</div>
                )}
                <div className="mt-1 text-[11px] font-mono" style={note}>
                  <span>{agentName}</span>: <span>{describeWaste(item)}</span>
                </div>
                <div className="text-[11px] font-mono" style={note}>{formatWasteTokens(item)}</div>
              </li>
            )
          })}
        </ul>
      )}
      {hidden > 0 && <p className="m-0 mt-1 text-[11px] font-mono" style={note}>{hidden} more not shown</p>}
      {uncompared > 0 && (
        <p className="m-0 mt-1 text-[11px] font-mono" style={note}>
          {pluralize(uncompared, 'call')} had no input details and {uncompared === 1 ? 'was' : 'were'} not compared
        </p>
      )}
      {limitReached && (
        <p className="m-0 mt-1 text-[11px] font-mono" style={note}>Tracking limit reached: this list is a lower bound</p>
      )}
      <p className="m-0 mt-1 text-[11px] font-mono" style={note}>
        Edits made through Bash are not seen; a repeat may be intended.
      </p>
    </section>
  )
}
