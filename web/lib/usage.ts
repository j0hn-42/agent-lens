import { USAGE_LABELS } from './ui-glossary'
import { formatTokens, formatCost } from './utils'

/** How complete a total is: every part known, some parts known (lower bound), or nothing known. */
export type UsageStatus = 'available' | 'partial' | 'unavailable'

/** Where a token figure comes from: announced by the runtime, or estimated by Agent Lens. */
export type TokenSource = 'reported' | 'estimated'

/** A total that never lies: `value` is null (not 0) when nothing is known, and a lower bound when partial. */
export interface UsageTotal {
  value: number | null
  status: UsageStatus
  estimated: boolean
}

export { USAGE_LABELS }

function unavailable(): UsageTotal {
  return { value: null, status: 'unavailable', estimated: false }
}

/** A finite, non-negative number is a value; anything else is absent. */
export function isValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** Sums values where null/undefined/invalid mean "absent": an absent part makes the total partial, never 0. */
export function sumUsage(values: Iterable<number | null | undefined>, estimated = false): UsageTotal {
  let sum = 0
  let known = 0
  let missing = 0
  for (const v of values) {
    if (isValue(v)) { sum += v; known++ } else missing++
  }
  if (known === 0) return unavailable()
  return { value: sum, status: missing > 0 ? 'partial' : 'available', estimated }
}

/** Adds up already-qualified totals (e.g. one per agent). */
export function combineUsage(parts: Iterable<UsageTotal>): UsageTotal {
  let sum = 0
  let known = 0
  let degraded = false
  let estimated = false
  for (const p of parts) {
    if (p.value === null || p.status === 'unavailable') { degraded = true; continue }
    sum += p.value
    known++
    if (p.status === 'partial') degraded = true
    if (p.estimated) estimated = true
  }
  if (known === 0) return unavailable()
  return { value: sum, status: degraded ? 'partial' : 'available', estimated }
}

/** An agent's token status; without an explicit one (legacy) it is inferred from the counter. */
export function effectiveTokenStatus(a: { tokensUsed: number; tokenStatus?: UsageStatus }): UsageStatus {
  return a.tokenStatus ?? (a.tokensUsed > 0 ? 'available' : 'unavailable')
}

/** Reads an agent's token counter; agents without an explicit status infer it from the counter (legacy). */
export function usageFromAgent(a: { tokensUsed: number; tokenStatus?: UsageStatus; tokensEstimated?: boolean }): UsageTotal {
  const status = effectiveTokenStatus(a)
  if (status === 'unavailable') return unavailable()
  return { value: a.tokensUsed, status, estimated: a.tokensEstimated === true }
}

/** Same qualification (status, estimate) with another value, e.g. a cost priced from a token total. */
export function withValue(usage: UsageTotal, value: number | null): UsageTotal {
  return usage.value === null || value === null ? unavailable() : { ...usage, value }
}

/** Qualifies any figure derived from a usage total (a percentage, a ratio) the way the total itself is. */
export function qualify(usage: UsageTotal, text: string): string {
  if (usage.value === null || usage.status === 'unavailable') return USAGE_LABELS.unavailable
  const lead = usage.status === 'partial' ? `${USAGE_LABELS.atLeast} ` : ''
  const tail = usage.estimated ? ` ${USAGE_LABELS.estimated}` : ''
  return `${lead}${text}${tail}`
}

export function formatTokenUsage(usage: UsageTotal): string {
  return qualify(usage, usage.value === null ? '' : formatTokens(usage.value))
}

export function formatCostUsage(usage: UsageTotal): string {
  return qualify(usage, usage.value === null ? '' : formatCost(usage.value))
}

/** A payload token figure: a finite non-negative number is a value, anything else is absent (null, never 0). */
export function readTokenCost(v: unknown): number | null {
  return isValue(v) ? v : null
}

/** Only an explicit 'reported' counts as announced; the rest is treated as estimated. */
export function readTokenSource(v: unknown): TokenSource {
  return v === 'reported' ? 'reported' : 'estimated'
}
