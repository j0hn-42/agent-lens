/**
 * Freshness of an agent's status (issue #48): a status is only displayed as current while something
 * proves it. Pure (no React, no DOM, no clock of its own): `now` is always passed in.
 *
 *   fresh          a live event arrived within STALE_AFTER_MS (or a history status within its expiry)
 *   stale          the status is older than that: it is only the "last known state"
 *   interrupted    the agent was paused/interrupted (terminal status, shown TERMINAL_STATUS_VISIBLE_MS)
 *   error          the agent failed (terminal status, shown TERMINAL_STATUS_VISIBLE_MS)
 *   closed         the agent completed, or a terminal status is older than TERMINAL_STATUS_VISIBLE_MS
 *   never-observed no event was ever received for the agent in this app run
 */
import type { Agent } from '../../lib/agent-types'
import {
  STALE_AFTER_MS, HISTORY_STATUS_EXPIRY_MS, TERMINAL_STATUS_VISIBLE_MS, FRESHNESS_ANNOUNCE_MAX_NAMES,
} from '../../lib/canvas-constants'
import { getStateLabel } from '../../lib/state-labels'

export type Freshness = 'fresh' | 'stale' | 'interrupted' | 'error' | 'closed' | 'never-observed'

export interface FreshnessThresholds {
  staleAfterMs: number
  historyExpiryMs: number
  terminalVisibleMs: number
}

export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  staleAfterMs: STALE_AFTER_MS,
  historyExpiryMs: HISTORY_STATUS_EXPIRY_MS,
  terminalVisibleMs: TERMINAL_STATUS_VISIBLE_MS,
}

/** The slice of an Agent the derivation reads. */
export type FreshnessInput = { state: string } & Partial<Pick<Agent, 'lastEventAt' | 'freshnessSource'>>

/**
 * Derived freshness of one agent at `now` (ms). Boundaries are inclusive on the fresh side: an age of
 * exactly staleAfterMs is still fresh, one millisecond more is stale (same for the other thresholds).
 */
export function deriveFreshness(
  agent: FreshnessInput,
  now: number,
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
): Freshness {
  const at = agent.lastEventAt
  if (typeof at !== 'number' || !Number.isFinite(at) || !Number.isFinite(now)) return 'never-observed'
  const age = Math.max(0, now - at)

  if (agent.state === 'complete') return 'closed'
  if (agent.state === 'error' || agent.state === 'paused') {
    if (age > thresholds.terminalVisibleMs) return 'closed'
    return agent.state === 'error' ? 'error' : 'interrupted'
  }
  const limit = agent.freshnessSource === 'history' ? thresholds.historyExpiryMs : thresholds.staleAfterMs
  return age > limit ? 'stale' : 'fresh'
}

/** Text of a stale node: the state is explicitly the last known one (never colour alone). */
export function lastKnownStateText(state: string): string {
  return `last known state: ${getStateLabel(state)}`
}

/** `agent` heard from at `nowMs` by a live event. */
export function heardFrom(agent: Agent, nowMs: number): Agent {
  return { ...agent, lastEventAt: nowMs, freshnessSource: 'live' }
}

/**
 * Mark the agents whose object changed between `prev` and `next` as just heard from (live events).
 * `touched` lists the agents the event may have changed: only those are visited (#210); without it,
 * every agent of `next` is.
 */
export function stampTouchedAgents(
  prev: ReadonlyMap<string, Agent>,
  next: Map<string, Agent>,
  nowMs: number,
  touched?: Iterable<string>,
): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const id of touched ?? next.keys()) {
    const agent = next.get(id)
    if (!agent || prev.get(id) === agent) continue
    if (!out) out = new Map(next)
    out.set(id, heardFrom(agent, nowMs))
  }
  return out ?? next
}

/** After a replay (seek) rebuilt the agents, give them back the wall-clock freshness they had. */
export function carryFreshness(prev: ReadonlyMap<string, Agent>, next: Map<string, Agent>): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    const before = prev.get(id)
    if (!before || before.lastEventAt === undefined) continue
    if (!out) out = new Map(next)
    out.set(id, { ...agent, lastEventAt: before.lastEventAt, freshnessSource: before.freshnessSource })
  }
  return out ?? next
}

/** Minimal agent view for the coarse key / announcements. */
export interface FreshnessSubject extends FreshnessInput { id: string; name: string }

/** Freshness of every agent at `now`. */
export function freshnessMap(agents: Iterable<FreshnessSubject>, now: number): Map<string, Freshness> {
  const out = new Map<string, Freshness>()
  for (const a of agents) out.set(a.id, deriveFreshness(a, now))
  return out
}

/**
 * Coarse key of the agents whose freshness is not 'fresh' / 'never-observed': it only changes when
 * an agent crosses a threshold, so a subscriber re-renders then and not on every tick.
 */
export function freshnessKey(agents: Iterable<FreshnessSubject>, now: number): string {
  const parts: string[] = []
  for (const a of agents) {
    const f = deriveFreshness(a, now)
    if (f !== 'fresh' && f !== 'never-observed') parts.push(`${a.id}=${f}`)
  }
  return parts.sort().join('|')
}

function listNames(names: string[]): string {
  const shown = names.slice(0, FRESHNESS_ANNOUNCE_MAX_NAMES).join(', ')
  const more = names.length - FRESHNESS_ANNOUNCE_MAX_NAMES
  return more > 0 ? `${shown} and ${more} more` : shown
}

/**
 * ONE aggregated, polite message for the agents that just became stale or closed between two ticks
 * (null when nothing did). Agents unknown to `prev` are a baseline, never announced.
 */
export function buildFreshnessAnnouncement(
  prev: ReadonlyMap<string, Freshness>,
  next: ReadonlyMap<string, Freshness>,
  names: ReadonlyMap<string, string>,
): string | null {
  const stale: string[] = []
  const closed: string[] = []
  for (const [id, f] of next) {
    const before = prev.get(id)
    if (before === undefined || before === f) continue
    const name = names.get(id) ?? id
    if (f === 'stale') stale.push(name)
    else if (f === 'closed') closed.push(name)
  }
  const parts: string[] = []
  if (stale.length > 0) parts.push(`${listNames(stale)} ${stale.length === 1 ? 'is' : 'are'} no longer reporting, showing the last known state`)
  if (closed.length > 0) parts.push(`${listNames(closed)} closed`)
  return parts.length > 0 ? parts.join('. ') + '.' : null
}
