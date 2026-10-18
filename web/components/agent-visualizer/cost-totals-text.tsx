"use client"

import { topBarContextText } from "@/lib/chrome-utils"
import { formatCost } from "@/lib/utils"
import { translate } from "@/lib/messages"
import { useLocale } from "@/lib/locale"
import type { UsageTotal } from "@/lib/usage"

/**
 * The totals the Cost panel draws on the canvas (cost, tokens in context), as text for screen readers (#555). The panel is
 * a canvas: without this, its numbers have no equivalent in the DOM. Same function and same figures as the top bar's spoken
 * totals (`topBarContextText`, usage already qualified under event loss), so "at least", "estimated" and "not reported"
 * are worded once, in the active language. Rendered only while the panel is open, like the panel itself.
 */
export function CostTotalsText({ tokens, cost, unattributedCost, isAllMode }: { tokens: UsageTotal; cost: UsageTotal; unattributedCost: number; isAllMode: boolean }) {
  const { locale } = useLocale()
  const t = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)
  const text = topBarContextText(tokens, cost, locale)
  const costReported = cost.value !== null && cost.status !== 'unavailable'
  const parts = [
    text.spoken,
    !isAllMode && unattributedCost > 0 && costReported ? t('topbar.context.unattributed', { cost: formatCost(unattributedCost) }) : null,
    text.tokens,
  ].filter((p): p is string => p !== null)
  return (
    <section data-testid="cost-panel-totals" role="region" aria-label={t('cost.totals.region')} lang={locale} className="sr-only">
      {parts.join(', ')}
    </section>
  )
}
