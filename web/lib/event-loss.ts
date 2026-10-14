/**
 * `event-loss` SSE message of the relay (#366): how many events per session the relay can no longer replay
 * (evicted from its buffer, or left out by the replay cap), sent once per connection before the replay.
 * Pure (no React, no path aliases: node:test imports it). The message is untrusted: parsed field by field.
 *
 * It counts events the relay could not give back when this page connected, since the relay started.
 * It is a lower bound of what the view is missing, never an exact figure: `otherEvents` is the part the
 * relay folded away without naming the session.
 */

export interface EventLoss {
  /** Session id -> events the relay could not replay (positive safe integers only) */
  evicted: Record<string, number>
  /** Events of sessions the relay no longer names */
  otherEvents: number
}

/** The relay bounds its tally; the client bounds what it reads as well */
const MAX_SESSIONS = 1000

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** The message as a validated EventLoss; null when it is not an `event-loss` message. */
export function parseEventLoss(data: unknown): EventLoss | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { type?: unknown; evicted?: unknown; otherEvents?: unknown }
  if (d.type !== 'event-loss' || typeof d.evicted !== 'object' || d.evicted === null || Array.isArray(d.evicted)) return null
  const evicted: Record<string, number> = Object.create(null)
  let kept = 0
  for (const [sid, n] of Object.entries(d.evicted)) {
    if (kept >= MAX_SESSIONS) break
    if (sid === '__proto__' || sid === 'constructor' || sid === 'prototype' || !isCount(n)) continue
    evicted[sid] = n
    kept++
  }
  return { evicted: { ...evicted }, otherEvents: isCount(d.otherEvents) ? d.otherEvents : 0 }
}

/** Every event the message reports, as a lower bound. */
function replayLostTotal(loss: EventLoss | null): number {
  if (!loss) return 0
  let total = loss.otherEvents
  for (const n of Object.values(loss.evicted)) total = Math.min(total + n, Number.MAX_SAFE_INTEGER)
  return total
}

/**
 * Events missing from the selection. One session: only its own count (a session the tally does not name is
 * never claimed as lossy). A union view (All, team, project): every count, a lower bound.
 */
export function replayLostFor(loss: EventLoss | null, sessionId: string | null | undefined, union: boolean): number {
  if (!loss) return 0
  if (union || !sessionId) return replayLostTotal(loss)
  return Object.hasOwn(loss.evicted, sessionId) ? loss.evicted[sessionId] : 0
}
