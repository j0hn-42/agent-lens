/**
 * `event-loss` SSE message of the relay (#366): how many events per session the relay can no longer replay
 * (evicted from its buffer, or left out by the replay cap), sent once per connection before the replay.
 * Pure (no React, no path aliases: node:test imports it). The message is untrusted: parsed field by field.
 *
 * The relay's figure is a total since the relay started, not what a given client is missing. It is a lower
 * bound of what the view lacks only for the FIRST connection of a graph (the graph was empty, so none of
 * those events had been received). A later connection that keeps the graph says nothing about it: the client
 * already received most of those events live. See {@link acceptEventLoss}.
 */
import { truncationTotal, shouldShowTruncationBanner, type NormalizationStats } from './event-normalize'
import { ALL_SESSIONS_ID, parseTeamSelection } from './bridge-types'

export interface EventLoss {
  /** Session id -> events the relay could not replay (positive safe integers only) */
  evicted: Record<string, number>
  /** Events of sessions the relay no longer names */
  otherEvents: number
}

/** The relay bounds its tally; the client bounds what it reads as well */
const MAX_SESSIONS = 1000
/** Entries looked at before giving up, junk included: a hostile object cannot make the loop long */
const MAX_SCANNED = MAX_SESSIONS * 4
/** A session id is far shorter than this */
const MAX_KEY_LENGTH = 256

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** The message as a validated EventLoss; null when it is not an `event-loss` message. */
export function parseEventLoss(data: unknown): EventLoss | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { type?: unknown; evicted?: unknown; otherEvents?: unknown }
  if (d.type !== 'event-loss' || typeof d.evicted !== 'object' || d.evicted === null || Array.isArray(d.evicted)) return null
  const source = d.evicted as Record<string, unknown>
  const evicted: Record<string, number> = Object.create(null)
  let kept = 0
  let scanned = 0
  for (const sid in source) {
    if (kept >= MAX_SESSIONS || ++scanned > MAX_SCANNED) break
    if (!Object.hasOwn(source, sid) || sid.length > MAX_KEY_LENGTH) continue
    if (sid === '__proto__' || sid === 'constructor' || sid === 'prototype') continue
    const n = source[sid]
    if (!isCount(n)) continue
    evicted[sid] = n
    kept++
  }
  return { evicted: { ...evicted }, otherEvents: isCount(d.otherEvents) ? d.otherEvents : 0 }
}

const add = (a: number, b: number) => Math.min(a + b, Number.MAX_SAFE_INTEGER)

/**
 * Events the relay could not replay for the selection. One session: only its own count (a session the tally
 * does not name is never claimed as lossy). All, or no selection: the whole tally, `otherEvents` included.
 * A team: only the sessions that belong to it (`teamSessionIds`), never `otherEvents`, which names no session;
 * an unknown membership claims nothing.
 */
export function replayLostFor(loss: EventLoss | null, selectedId: string | null | undefined, teamSessionIds: ReadonlySet<string> | null = null): number {
  if (!loss) return 0
  if (!selectedId || selectedId === ALL_SESSIONS_ID) {
    let total = loss.otherEvents
    for (const n of Object.values(loss.evicted)) total = add(total, n)
    return total
  }
  const count = (sid: string) => (Object.hasOwn(loss.evicted, sid) ? loss.evicted[sid] : 0)
  if (parseTeamSelection(selectedId) !== null) {
    let total = 0
    if (teamSessionIds) for (const sid of teamSessionIds) total = add(total, count(sid))
    return total
  }
  return count(selectedId)
}

/**
 * Which figure the view keeps. `connections` is how many times the link has been up since the graph was
 * last emptied (a scope change reloads it). Only the first connection's message counts: it was received
 * while the graph was empty. A later one is the relay's cumulative total, not what this graph lacks, so it
 * is ignored and the first figure stays (the hole it described is still in the graph). A message that did
 * not parse never clears a figure.
 */
export function acceptEventLoss(connections: number, current: EventLoss | null, incoming: EventLoss | null): EventLoss | null {
  return connections <= 1 && incoming !== null ? incoming : current
}

/** Whether the truncation banner shows, and the total it was computed on (what a dismissal stores). */
export function truncationBannerState(stats: NormalizationStats, replayLost: number, dismissedAt: number | undefined): { show: boolean; total: number } {
  const lost = Number.isSafeInteger(replayLost) && replayLost > 0 ? replayLost : 0
  const total = add(truncationTotal(stats), lost)
  // The normalizer's own rule, with the replay loss added to the total a dismissal is compared with
  const show = lost === 0 ? shouldShowTruncationBanner(stats, dismissedAt) : total > 0 && (dismissedAt === undefined || total > dismissedAt)
  return { show, total }
}

