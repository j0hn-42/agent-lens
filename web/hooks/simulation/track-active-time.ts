/**
 * Active time on the live path (issue #59): when an event moves an agent between a working state
 * and a pause, its active-time fields move with the wall clock of the event. Pure, `nowMs` passed in.
 */
import type { Agent } from '../../lib/agent-types'
import { advanceActiveTime, isActiveState } from '../../lib/active-time'

/** Agents whose object changed between `prev` and `next`: start or close their active span. */
export function trackActiveTime(
  prev: ReadonlyMap<string, Agent>,
  next: Map<string, Agent>,
  nowMs: number,
): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    if (prev.get(id) === agent) continue
    const working = isActiveState(agent.state)
    // Same phase as the recorded one (still working, or still paused): nothing to record
    if (working === (agent.activeSince !== undefined)) continue
    // Already working before this event (e.g. seen through a history replay) but with no known start:
    // the live event does not witness the start of the span, so it stays unknown
    const before = prev.get(id)
    if (working && before && isActiveState(before.state) && before.activeSince === undefined) continue
    const fields = advanceActiveTime({ activeMs: agent.activeMs, activeSince: agent.activeSince }, working, nowMs)
    if (!out) out = new Map(next)
    const { activeMs: _ms, activeSince: _since, ...rest } = agent
    out.set(id, { ...rest, ...fields })
  }
  return out ?? next
}

/**
 * After a replay (seek) rebuilt the agents, give them back the active time they had - only when the
 * rebuilt agent is in the same phase (working / paused) as before, so the fields never contradict the
 * state shown. A running span only survives for an agent that is working in both; otherwise the span
 * is dropped (unknown) rather than shown as a counter for an agent replayed to idle, or frozen for a
 * working one.
 */
export function carryActiveTime(prev: ReadonlyMap<string, Agent>, next: Map<string, Agent>): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    const before = prev.get(id)
    if (!before || (before.activeMs === undefined && before.activeSince === undefined)) continue
    const working = isActiveState(agent.state)
    if (working !== isActiveState(before.state)) continue
    if (!out) out = new Map(next)
    const { activeSince: _since, ...rest } = agent
    out.set(id, { ...rest, activeMs: before.activeMs, ...(working && before.activeSince !== undefined ? { activeSince: before.activeSince } : {}) })
  }
  return out ?? next
}
