import type { ToolCallNode, ToolCallState } from './agent-types'

/** User-facing label of each lifecycle state (never show the raw identifier). */
export const TOOL_STATE_LABELS: Record<ToolCallState, string> = {
  running: 'Running',
  complete: 'Completed',
  error: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** Shown wherever a result or outcome rests on an end that was never observed. */
export const END_NOT_OBSERVED = 'fin non observée'

/** Warning attached to an expired call: the goal is not known to have been reached. */
export const EXPIRED_WARNING = 'Expiré, fin non observée : le résultat est inconnu, pas un succès.'

/** Terminal outcomes a producer can report on tool_call_end. */
export type ReportedOutcome = 'complete' | 'error' | 'cancelled'

export function isRunning(state: ToolCallState): boolean {
  return state === 'running'
}

/** Reads the outcome of a tool_call_end payload; an unknown `outcome` falls back to `isError`. */
export function readToolOutcome(payload: { outcome?: unknown; isError?: unknown }): ReportedOutcome {
  if (payload.outcome === 'cancelled') return 'cancelled'
  if (payload.outcome === 'failed' || payload.isError === true) return 'error'
  return 'complete'
}

/** True once a running call has outlived the orphan delay. */
export function isOrphan(tc: Pick<ToolCallNode, 'state' | 'startTime'>, now: number, expiryS: number): boolean {
  return tc.state === 'running' && now - tc.startTime > expiryS
}

/** Closes a call whose end was not seen: `expired`, stamped at `at`, with no result invented. */
export function expireToolCall(tc: ToolCallNode, at: number): ToolCallNode {
  return { ...tc, state: 'expired', endObserved: false, completeTime: at }
}

/** The call as it must be at `now`: an orphan is expired at its deadline (start + delay), anything else is untouched. */
export function settleToolCall(tc: ToolCallNode, now: number, expiryS: number): ToolCallNode {
  return isOrphan(tc, now, expiryS) ? expireToolCall(tc, tc.startTime + expiryS) : tc
}

/** Caveat to show next to the outcome / result of a call, or null when its end was observed. */
export function toolEndWarning(tc: Pick<ToolCallNode, 'state' | 'endObserved'>): string | null {
  if (tc.state === 'expired') return EXPIRED_WARNING
  if (tc.endObserved === false) return `Résultat rapporté, ${END_NOT_OBSERVED}.`
  return null
}

/** A finished card grows to two lines when it has something to add: a token figure or a non-success outcome. */
export function toolCardExpanded(tc: Pick<ToolCallNode, 'state' | 'tokenCost'>): boolean {
  return tc.state !== 'running' && (!!tc.tokenCost || tc.state !== 'complete')
}

/** Lowercase outcome for assistive text ("completed", "failed", "expired, end not observed"). */
export function toolStateText(tc: Pick<ToolCallNode, 'state' | 'endObserved'>): string {
  const label = TOOL_STATE_LABELS[tc.state].toLowerCase()
  return tc.state === 'expired' ? `${label}, ${END_NOT_OBSERVED}` : label
}
