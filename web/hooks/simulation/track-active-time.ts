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
    const fields = advanceActiveTime({ activeMs: agent.activeMs, activeSince: agent.activeSince }, working, nowMs)
    if (!out) out = new Map(next)
    const { activeMs: _ms, activeSince: _since, ...rest } = agent
    out.set(id, { ...rest, ...fields })
  }
  return out ?? next
}

/** After a replay (seek) rebuilt the agents, give them back the active time they had. */
export function carryActiveTime(prev: ReadonlyMap<string, Agent>, next: Map<string, Agent>): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    const before = prev.get(id)
    if (!before || (before.activeMs === undefined && before.activeSince === undefined)) continue
    if (!out) out = new Map(next)
    out.set(id, { ...agent, activeMs: before.activeMs, activeSince: before.activeSince })
  }
  return out ?? next
}
