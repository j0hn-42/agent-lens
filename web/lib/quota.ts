import type { GaugeView, QuotaSnapshotView } from './bridge-types'

export type { GaugeView, QuotaSnapshotView }

/** Same ceiling as the relay: resetsAt is epoch seconds, 8.64e12 is the largest valid JS date */
const MAX_RESETS_AT = 8.64e12
const MIN_MS = 60_000
/** Up to this age the figures are shown without an age */
const FRESH_MS = 5 * MIN_MS
/** Past this age without an update the figures are not shown any more: unknown */
const STALE_MS = 30 * MIN_MS
/** A reset further away than the longest window (7 days) plus a margin is not credible */
const MAX_AHEAD_MS = 8 * 24 * 60 * MIN_MS

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function gauge(v: unknown): GaugeView | null {
  if (!isRecord(v)) return null
  const used = v.usedPercentage, resetsAt = v.resetsAt
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt < 0 || resetsAt > MAX_RESETS_AT) return null
  return { remainingPercent: 100 - used, resetsAt }
}

/** `data` is the value of an SSE `quota` message's `quota` field: network data, anything out of range becomes null
 *  (a window, or the whole snapshot), nothing is clamped into a plausible figure. */
export function parseQuotaMessage(data: unknown): QuotaSnapshotView | null {
  if (!isRecord(data)) return null
  const receivedAt = data.receivedAt
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt < 0) return null
  return { fiveHour: gauge(data.fiveHour), sevenDay: gauge(data.sevenDay), receivedAt }
}

/** A valid message always replaces the current snapshot (the stream of one connection is ordered and the relay is the only
 *  source: comparing receivedAt would freeze the gauge if the relay host's clock stepped back); an invalid one keeps it. */
export function acceptQuota(prev: QuotaSnapshotView | null, next: QuotaSnapshotView | null): QuotaSnapshotView | null {
  return next ?? prev
}

export type QuotaGaugeState =
  | { kind: 'claude'; fiveHour: GaugeView | null; sevenDay: GaugeView | null; ageMinutes: number | null }
  | { kind: 'unknown' }
  | { kind: 'unavailable'; runtime: 'copilot' }
  | { kind: 'no-subscription'; runtime: 'opencode' }
  | { kind: 'hidden' }

/** A window whose reset has passed shows the previous period's figure; one too far ahead cannot be right. Both are unknown. */
function liveWindow(w: GaugeView | null, now: number): GaugeView | null {
  if (!w) return null
  const resetMs = w.resetsAt * 1000
  return resetMs <= now || resetMs > now + MAX_AHEAD_MS ? null : w
}

/** What the quota gauge shows. `now` and `snapshot.receivedAt` are in milliseconds.
 *  `runtime` is the selected session's runtime. The relay tags every Claude session 'claude', so `undefined` means
 *  no session is selected: the account-wide Claude quota still applies, but with no snapshot there is nothing to show
 *  (a Claude session without any snapshot shows nothing either, #467).
 *  Copilot and OpenCode never read the snapshot. */
export function quotaGaugeState(runtime: string | undefined, snapshot: QuotaSnapshotView | null, now: number): QuotaGaugeState {
  if (runtime === 'copilot') return { kind: 'unavailable', runtime: 'copilot' }
  if (runtime === 'opencode') return { kind: 'no-subscription', runtime: 'opencode' }
  if (runtime !== undefined && runtime !== 'claude') return { kind: 'hidden' }
  // No snapshot was ever received: with Claude Code that is the normal case until the status line is wrapped, not a problem
  // to report in the bar (the way to enable it is in Settings). 'unknown' is only for a figure we had and can no longer trust.
  if (!snapshot) return { kind: 'hidden' }
  // A clock behind receivedAt gives a negative age: treated as fresh, never as a negative figure
  const age = Math.max(0, now - snapshot.receivedAt)
  if (age > STALE_MS) return { kind: 'unknown' }
  const fiveHour = liveWindow(snapshot.fiveHour, now), sevenDay = liveWindow(snapshot.sevenDay, now)
  if (!fiveHour && !sevenDay) return { kind: 'unknown' }
  return { kind: 'claude', fiveHour, sevenDay, ageMinutes: age <= FRESH_MS ? null : Math.floor(age / MIN_MS) }
}

/** The quota only ever comes from the relay stream: VS Code, the demo and the guided tour (mock data) have no source, so nothing
 *  quota-related is shown there (an "unknown" with a setup hint would send the user after something that cannot work).
 *  `relayOrigin` is null when there is no relay link, '' for a relay on the page's own origin. */
export function quotaStreamActive(s: { relayOrigin: string | null; isVSCode: boolean; useMockData: boolean; tourActive?: boolean }): boolean {
  return s.relayOrigin !== null && !s.isVSCode && !s.useMockData && !s.tourActive
}
