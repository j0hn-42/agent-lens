'use client'

import { useId } from 'react'
import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { truncatePath } from '@/lib/utils'
import { wasteSummary, type WasteLedger } from '@/lib/waste'
import { useLocale } from '@/lib/locale'
import { DATA_EN, t as tr, pluralText, lostSentence, wasteDescribeText, wasteTokensText } from '@/lib/panel-text'

/** Rows drawn at once; the rest is counted, never silently dropped. */
export const WASTE_ROWS_SHOWN = 20

interface WasteSectionProps {
  waste: WasteLedger
  agents?: ReadonlyMap<string, Agent>
  onOpenFile?: (filePath: string) => void
  /** Events the relay could not replay for the selection (#366): repeats become a lower bound, the empty state is not a clean zero */
  replayLost?: number
}

/**
 * Repeated reads and identical calls, as facts: what was seen twice and what the repeats cost. It never
 * says "wasted" for a call that may be intended, and it names what it cannot see.
 */
export function WasteSection({ waste, agents, onOpenFile, replayLost = 0 }: WasteSectionProps) {
  const headingId = useId()
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const { items, uncompared, limitReached } = wasteSummary(waste)
  const shown = items.slice(0, WASTE_ROWS_SHOWN)
  const hidden = items.length - shown.length
  const note = { color: COLORS.textMuted }

  return (
    <section aria-labelledby={headingId} className="mb-2">
      <h3 id={headingId} className="m-0 mb-1 text-[11px] font-mono font-normal uppercase tracking-wider" style={{ color: COLORS.textPrimary }}>
        {t('waste.heading')}
      </h3>
      {items.length === 0 ? (
        <p className="m-0 text-[11px] font-mono" style={note}>{replayLost > 0 ? t('waste.noneIncomplete') : t('waste.none')}</p>
      ) : (
        <ul className="space-y-1 list-none p-0 m-0">
          {shown.map((item) => {
            const canOpen = Boolean(onOpenFile && item.kind === 'reread' && item.target.startsWith('/'))
            const agentName = agents?.get(item.agentId)?.displayName ?? item.agentId
            const target = item.kind === 'reread' ? truncatePath(item.target) : item.target
            const label = (
              <span {...DATA_EN} className="text-[11px] font-mono truncate min-w-0 flex-1 text-left" style={{ color: COLORS.tool }}>
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
                    aria-label={t('waste.open', { label: `${item.toolName} ${target}` })}
                    className={`flex items-center gap-2 w-full min-h-6 rounded hover:brightness-125 ${FOCUS_RING_INSET}`}
                  >
                    {label}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 min-h-6" title={item.target}>{label}</div>
                )}
                <div className="mt-1 text-[11px] font-mono" style={note}>
                  <span>{t('waste.itemLine', { agent: agentName, text: wasteDescribeText(locale, item, replayLost) })}</span>
                </div>
                <div className="text-[11px] font-mono" style={note}>{wasteTokensText(locale, item)}</div>
              </li>
            )
          })}
        </ul>
      )}
      {hidden > 0 && <p className="m-0 mt-1 text-[11px] font-mono" style={note}>{pluralText(locale, 'waste.more', hidden)}</p>}
      {uncompared > 0 && (
        <p className="m-0 mt-1 text-[11px] font-mono" style={note}>
          {pluralText(locale, 'waste.uncompared', uncompared)}
        </p>
      )}
      {limitReached && (
        <p className="m-0 mt-1 text-[11px] font-mono" style={note}>{t('waste.limit')}</p>
      )}
      {replayLost > 0 && <p className="m-0 mt-1 text-[11px] font-mono" style={note}>{lostSentence(locale, replayLost)}</p>}
      <p className="m-0 mt-1 text-[11px] font-mono" style={note}>
        {t('waste.bash')}
      </p>
    </section>
  )
}
