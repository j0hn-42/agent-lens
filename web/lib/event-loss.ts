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
import { truncationTotal, type NormalizationStats } from './event-normalize'
import { ALL_SESSIONS_ID, parseTeamSelection } from './bridge-types'
import type { UsageTotal } from './usage'

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
 * does not name is never claimed as lossy). All, or no selection: the sessions All shows (`allViewSessionIds`,
 * #453: finished sessions are hidden by default and a project scope narrows it), never `otherEvents` then; only
 * when All shows every session (null) is it the whole tally, `otherEvents` included.
 * A team: only the sessions that belong to it (`teamSessionIds`), never `otherEvents`, which names no session;
 * an unknown membership claims nothing.
 */
export function replayLostFor(
  loss: EventLoss | null,
  selectedId: string | null | undefined,
  teamSessionIds: ReadonlySet<string> | null = null,
  allViewSessionIds: ReadonlySet<string> | null = null,
): number {
  if (!loss) return 0
  if (!selectedId || selectedId === ALL_SESSIONS_ID) {
    if (allViewSessionIds) {
      let shown = 0
      for (const sid of allViewSessionIds) shown = add(shown, replayLostForSession(loss, sid))
      return shown
    }
    let total = loss.otherEvents
    for (const n of Object.values(loss.evicted)) total = add(total, n)
    return total
  }
  if (parseTeamSelection(selectedId) !== null) {
    let total = 0
    if (teamSessionIds) for (const sid of teamSessionIds) total = add(total, replayLostForSession(loss, sid))
    return total
  }
  return replayLostForSession(loss, selectedId)
}

/**
 * Events the relay could not replay for ONE session (what an agent card reads for its agent's session): its
 * own count only, 0 when the tally does not name it. Unlike replayLostFor, no session claims nothing (never
 * the whole tally, never `otherEvents`).
 */
export function replayLostForSession(loss: EventLoss | null, sessionId: string | null | undefined): number {
  if (!loss || !sessionId) return 0
  return Object.hasOwn(loss.evicted, sessionId) ? loss.evicted[sessionId] : 0
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
  // A dismissal holds only at the total it was made at (#569 review). More lost: back. LESS than that total is a new loss
  // too, never a smaller part of the old one: the relay restarted (its figure starts again from 0) or the graph was
  // reloaded, so a dismissal stored for the tab before that no longer describes what the view lacks.
  const show = total > 0 && (dismissedAt === undefined || total !== dismissedAt)
  return { show, total }
}

// ─── Dismissal of the truncation banner, for the tab (#567) ──────────────────

/** sessionStorage key: a dismissal lasts as long as the tab, a new tab shows the banner again */
const TRUNCATION_DISMISS_STORAGE_KEY = 'agent-lens:truncation-dismissed'
/** Views remembered at most: the newest dismissals are kept */
const MAX_DISMISSALS = 100
/** A key is a prefix and a session id (MAX_KEY_LENGTH) */
const MAX_DISMISS_KEY_LENGTH = MAX_KEY_LENGTH + 8

/** What the dismissal helpers need of a Storage */
export type DismissStore = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The view a dismissal belongs to: the All view (no selection, or the All pseudo id) has one key, each other selection
 * (a session, a team) its own. Prefixed, so a session id never names the All view.
 */
export function truncationDismissKey(selectedId: string | null | undefined): string {
  return !selectedId || selectedId === ALL_SESSIONS_ID ? 'view:all' : `sel:${selectedId}`
}

/** The tab's sessionStorage, or null when it cannot be reached (reading it throws when site data is blocked). */
export function tabStorage(): DismissStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage ?? null
  } catch { return null }
}

/** Dismissals stored for the tab, view key -> total dismissed at. Untrusted: parsed entry by entry; never throws. */
export function readTruncationDismissals(storage: DismissStore | null): Map<string, number> {
  const out = new Map<string, number>()
  if (!storage) return out
  let parsed: unknown
  try { parsed = JSON.parse(storage.getItem(TRUNCATION_DISMISS_STORAGE_KEY) ?? 'null') } catch { return out }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  let scanned = 0
  for (const key of Object.keys(parsed)) {
    if (out.size >= MAX_DISMISSALS || ++scanned > MAX_DISMISSALS * 4) break
    if (key.length > MAX_DISMISS_KEY_LENGTH || key === '__proto__') continue
    const n = (parsed as Record<string, unknown>)[key]
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out.set(key, n)
  }
  return out
}

/** Store the dismissals for the tab (the newest MAX_DISMISSALS); false when the storage is missing or refuses. */
export function writeTruncationDismissals(storage: DismissStore | null, dismissals: ReadonlyMap<string, number>): boolean {
  if (!storage) return false
  const entries = [...dismissals].slice(-MAX_DISMISSALS)
  try {
    storage.setItem(TRUNCATION_DISMISS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    return true
  } catch { return false }
}

/**
 * What the All view counted for each session: its normalizer counters, plus its replay loss when All shows it
 * (`allViewSessionIds`, as replayLostFor; null = every session the tally names). Sessions with nothing lost are left out.
 */
export function allViewSessionTotals(
  statsBySession: ReadonlyMap<string, NormalizationStats>,
  loss: EventLoss | null,
  allViewSessionIds: ReadonlySet<string> | null,
): Map<string, number> {
  const totals = new Map<string, number>()
  const bump = (sid: string, n: number) => { if (n > 0) totals.set(sid, add(totals.get(sid) ?? 0, n)) }
  for (const [sid, stats] of statsBySession) bump(sid, truncationTotal(stats))
  if (loss) for (const sid of allViewSessionIds ?? Object.keys(loss.evicted)) bump(sid, replayLostForSession(loss, sid))
  return totals
}

/**
 * The dismissals after the user closed the banner of view `key` at `total` (a new map, the newest entry last).
 * Dismissing the All view also covers each session it counted (`covered`, session id -> what All counted for it):
 * opening one of them right after shows no banner at the same total. A higher total stored for a session is kept only
 * while that session's own view still counts at least that much (`own`, allViewSessionTotals with every session): it is
 * an earlier dismissal of a loss All does not show. Above what the session counts now, it is stale (the relay
 * restarted) and is replaced, or the session would open on a banner the user just closed.
 */
export function dismissTruncation(
  prev: ReadonlyMap<string, number>,
  key: string,
  total: number,
  covered: ReadonlyMap<string, number> = new Map(),
  own: ReadonlyMap<string, number> = covered,
): Map<string, number> {
  const next = new Map(prev)
  const put = (sid: string, n: number) => {
    const k = truncationDismissKey(sid)
    const was = next.get(k)
    next.delete(k)
    next.set(k, was !== undefined && was > n && was <= (own.get(sid) ?? 0) ? was : n)
  }
  if (key === truncationDismissKey(ALL_SESSIONS_ID)) for (const [sid, n] of covered) put(sid, n)
  next.delete(key)
  next.set(key, total)
  return next
}

/**
 * A count over a graph that may be incomplete (#366). `lost` is replayLostFor() for the scope of the figure.
 * Nothing lost: the plain count. Lost: "at least N", and a zero is "no X observed (incomplete)", never a clean zero.
 */
export function boundedCount(n: number, lost: number, singular: string, plural = `${singular}s`): string {
  if (!(lost > 0)) return `${n} ${n === 1 ? singular : plural}`
  if (n === 0) return `no ${singular} observed (incomplete)`
  return `at least ${n} ${n === 1 ? singular : plural}`
}

/** What is missing, as a lower bound (the figure of the graph's first connection, never an exact one); empty when nothing is. */
export function replayLostSentence(lost: number): string {
  if (!(lost > 0)) return ''
  return lost === 1 ? 'at least 1 earlier event was not replayed by the relay' : `at least ${lost} earlier events were not replayed by the relay`
}

/** Events the relay could not replay for the sessions of these agents, each session counted once (0 when none is named). */
export function replayLostForAgents(lost: ReadonlyMap<string, number> | null | undefined, agents: Iterable<{ sessionId?: string }>): number {
  if (!lost || lost.size === 0) return 0
  const seen = new Set<string>()
  let total = 0
  for (const a of agents) {
    if (!a.sessionId || seen.has(a.sessionId)) continue
    seen.add(a.sessionId)
    const n = lost.get(a.sessionId)
    if (n !== undefined && n > 0) total = add(total, n)
  }
  return total
}

/**
 * A token or cost total over a graph that may be incomplete (#366): with lost events a complete figure becomes a lower
 * bound, which every surface already words "at least". Nothing lost, or nothing known (null stays "not reported"): unchanged.
 */
export function usageUnderLoss(usage: UsageTotal, lost: number): UsageTotal {
  return lost > 0 && usage.status === 'available' && usage.value !== null ? { ...usage, status: 'partial' } : usage
}
