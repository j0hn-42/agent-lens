/**
 * Per-session counters of the bridge's 'All' buffer (#613). The buffer is trimmed from its front (oldest events first,
 * see pushBounded) and its base counts the events dropped from all sessions together; a union view (All, a team) shows
 * only some sessions, so the events it lost are counted per session: those each session put into the buffer and those
 * the trims dropped. A session's dropped events are its oldest ones, so the ones a view had not drawn yet are exactly
 * its drops beyond the events it had before its cursor. One number of each kind per session seen (like the session
 * buffers' base), cleared with the buffer.
 */
import type { SimulationEvent } from '@/lib/agent-types'

export interface AllBufferCounts {
  /** Events of each session put into the 'All' buffer */
  arrived: Map<string, number>
  /** Events of each session the trims of the 'All' buffer dropped */
  dropped: Map<string, number>
}

/** Key of an event without a session id */
const NO_SESSION = ''
const keyOf = (sessionId: string | undefined) => sessionId ?? NO_SESSION

export function createAllBufferCounts(): AllBufferCounts {
  return { arrived: new Map(), dropped: new Map() }
}

export function clearAllBufferCounts(c: AllBufferCounts): void {
  c.arrived.clear()
  c.dropped.clear()
}

export function countAllArrival(c: AllBufferCounts, sessionId: string | undefined): void {
  const k = keyOf(sessionId)
  c.arrived.set(k, (c.arrived.get(k) ?? 0) + 1)
}

export function countAllDrops(c: AllBufferCounts, dropped: readonly SimulationEvent[]): void {
  for (const e of dropped) {
    const k = keyOf(e.sessionId)
    c.dropped.set(k, (c.dropped.get(k) ?? 0) + 1)
  }
}

/**
 * Per session, the events placed before a union view's cursor: every event the session put into the buffer, minus
 * those still queued for the view (the queue holds every event of the view's sessions from the cursor on).
 */
export function unionMark(c: AllBufferCounts, queued: readonly SimulationEvent[]): Map<string, number> {
  const mark = new Map(c.arrived)
  for (const e of queued) {
    const k = keyOf(e.sessionId)
    mark.set(k, (mark.get(k) ?? 0) - 1)
  }
  return mark
}

/**
 * Events of the sessions `matches` keeps that the trims dropped past `mark` (from unionMark), or all their dropped
 * events without a mark (a view rebuilt from the buffer).
 */
export function unionDroppedSince(
  c: AllBufferCounts, matches: (sessionId: string | undefined) => boolean, mark?: ReadonlyMap<string, number>,
): number {
  let n = 0
  for (const [k, dropped] of c.dropped) {
    if (!matches(k === NO_SESSION ? undefined : k)) continue
    n += Math.max(0, dropped - (mark?.get(k) ?? 0))
  }
  return n
}
