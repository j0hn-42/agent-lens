'use client'

import { useId, useState } from 'react'
import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { truncatePath } from '@/lib/utils'
import { wasteSummary, repeatsDisclosure, type WasteLedger } from '@/lib/waste'
import { useLocale } from '@/lib/locale'
import { DATA_EN, t as tr, pluralText, lostSentence, wasteDescribeText, wasteTokensText, wasteDisclosureText } from '@/lib/panel-text'

/** Rows drawn at once; the rest is counted, never silently dropped. */
export const WASTE_ROWS_SHOWN = 20

interface WasteSectionProps {
  waste: WasteLedger
  agents?: ReadonlyMap<string, Agent>
  onOpenFile?: (filePath: string) => void
  /** Events the relay could not replay for the selection (#366): repeats become a lower bound, the empty state is not a clean zero */
  replayLost?: number
  /** Unfolded when the panel opens (#518): the Files & repeats panel unfolds it only when it lists no file. Default: unfolded */
  defaultOpen?: boolean
}

/**
 * Repeated reads and identical calls, as facts: what was seen twice and what the repeats cost. It never
 * says "wasted" for a call that may be intended, and it names what it cannot see. A native disclosure (#518):
 * its summary keeps the count of the list with the same qualifiers, so folding it hides no number.
 */
export function WasteSection({ waste, agents, onOpenFile, replayLost = 0, defaultOpen = true }: WasteSectionProps) {
  const headingId = useId()
  // Chosen once when the panel opens; afterwards only the user folds or unfolds it (nothing moves under them, WCAG 3.2.2)
  const [open, setOpen] = useState(defaultOpen)
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const summary = wasteSummary(waste)
  const { items, uncompared, limitReached } = summary
  const shown = items.slice(0, WASTE_ROWS_SHOWN)
  const hidden = items.length - shown.length
  const note = { color: COLORS.textMuted }

  return (
    <section aria-labelledby={headingId} className="mb-2">
      {/* Outside the summary, whose children are presentational: heading navigation still finds the section (1.3.1, 2.4.6) */}
      <h3 id={headingId} className="sr-only">{t('waste.heading')}</h3>
      <details open={open} onToggle={e => setOpen(e.currentTarget.open)}>
        <summary
          className={`cursor-pointer min-h-6 rounded text-2xs font-mono hover:brightness-125 ${FOCUS_RING_INSET}`}
          style={{ color: COLORS.textPrimary }}
        >
          {wasteDisclosureText(locale, repeatsDisclosure(summary, replayLost))}
        </summary>
        <div className="mt-1">
          {items.length === 0 ? (
            <p className="m-0 text-2xs font-mono" style={note}>{replayLost > 0 ? t('waste.noneIncomplete') : t('waste.none')}</p>
          ) : (
            <ul className="space-y-1 list-none p-0 m-0">
              {shown.map((item) => {
                const canOpen = Boolean(onOpenFile && item.kind === 'reread' && item.target.startsWith('/'))
                const agentName = agents?.get(item.agentId)?.displayName ?? item.agentId
                const target = item.kind === 'reread' ? truncatePath(item.target) : item.target
                const label = (
                  <span {...DATA_EN} className="text-2xs font-mono truncate min-w-0 flex-1 text-left" style={{ color: COLORS.tool }}>
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
                    <div className="mt-1 text-2xs font-mono" style={note}>
                      <span>{t('waste.itemLine', { agent: agentName, text: wasteDescribeText(locale, item, replayLost) })}</span>
                    </div>
                    <div className="text-2xs font-mono" style={note}>{wasteTokensText(locale, item)}</div>
                  </li>
                )
              })}
            </ul>
          )}
          {hidden > 0 && <p className="m-0 mt-1 text-2xs font-mono" style={note}>{pluralText(locale, 'waste.more', hidden)}</p>}
          {uncompared > 0 && (
            <p className="m-0 mt-1 text-2xs font-mono" style={note}>
              {pluralText(locale, 'waste.uncompared', uncompared)}
            </p>
          )}
          {limitReached && (
            <p className="m-0 mt-1 text-2xs font-mono" style={note}>{t('waste.limit')}</p>
          )}
          {replayLost > 0 && <p className="m-0 mt-1 text-2xs font-mono" style={note}>{lostSentence(locale, replayLost)}</p>}
          <p className="m-0 mt-1 text-2xs font-mono" style={note}>
            {t('waste.bash')}
          </p>
        </div>
      </details>
    </section>
  )
}
