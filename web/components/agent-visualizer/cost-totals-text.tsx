"use client"

import { topBarContextText, unattributedRestText } from "@/lib/chrome-utils"
import { translate } from "@/lib/messages"
import { useLocale } from "@/lib/locale"
import { agentCostUsage } from "@/lib/cost"
import { summarizeCosts } from "@/lib/attribution"
import type { UsageStatus, UsageTotal } from "@/lib/usage"

type CostAgent = { tokensUsed: number; model?: string; tokenStatus?: UsageStatus; tokensEstimated?: boolean }

/**
 * The totals the Cost panel draws on the canvas (cost, tokens in context, the unattributed row), as text for screen readers
 * (#555). The panel is a canvas: without this, its numbers have no equivalent in the DOM. The header totals use the same
 * function and figures as the top bar's spoken totals (`topBarContextText`, usage already qualified under event loss), so
 * "at least", "estimated" and "not reported" are worded once, in the active language.
 *
 * It follows the rules of `drawCostSummaryPanel` (draw-cost.ts), so the DOM never says more or less than the drawing:
 * - nothing is rendered when the drawing draws nothing (no agent with a figure, no unattributed usage): never a "$0.00";
 * - the unattributed row is given in every mode, with its tokens and the qualifiers of the drawing: "~" (priced at the
 *   default rate, the model is unknown) read as "about", plus "estimated" when one part of it is an estimate.
 * Rendered only while the panel is open, in full screen too: the canvas draws the panel there as well.
 */
export function CostTotalsText({ tokens, cost, agents, unattributed }: {
  tokens: UsageTotal
  cost: UsageTotal
  /** The agents and the usage tied to no agent that the drawing totals (costScope) */
  agents: Iterable<CostAgent>
  unattributed: Iterable<{ tokens: number; estimated?: boolean }>
}) {
  const { locale } = useLocale()
  const t = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)
  // Same emptiness rule as the drawing: only agents with a known figure count, and the remainder when it has tokens
  const withFigure = Array.from(agents).filter(a => agentCostUsage(a).value !== null)
  const rest = Array.from(unattributed)
  const summary = summarizeCosts(withFigure, rest)
  const hasRest = summary.unattributedTokens > 0
  if (withFigure.length === 0 && !hasRest) return null

  const text = topBarContextText(tokens, cost, locale)
  const parts = [
    text.spoken,
    text.tokens,
    hasRest ? unattributedRestText(summary.unattributedTokens, summary.unattributedCost, rest.some(u => u.estimated === true), locale) : null,
  ].filter((p): p is string => p !== null)
  return (
    <section data-testid="cost-panel-totals" aria-label={t('cost.totals.region')} lang={locale} className="sr-only">
      {parts.join(', ')}
    </section>
  )
}
