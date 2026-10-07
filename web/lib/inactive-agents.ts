/**
 * 'Hide inactive agents': pure filter over the simulation's agents. Inactive = idle or complete.
 * Parents of a visible agent stay (edges need both ends), as do the selected and hovered agents.
 */
import type { Agent } from './agent-types'

/** localStorage key of the 'Hide inactive agents' preference */
export const HIDE_INACTIVE_STORAGE_KEY = 'agent-lens:hide-inactive-agents'

/** Parse the persisted preference: hidden by default, only the exact string 'false' shows them. */
export function parseHideInactive(raw: string | null | undefined): boolean {
  return raw !== 'false'
}

export function isInactiveAgent(a: Pick<Agent, 'state' | 'archived'>): boolean {
  return a.state === 'idle' || a.state === 'complete' || a.archived === true
}

/** Agents to draw; returns `agents` itself when nothing is hidden (no allocation, stable identity). */
export function visibleAgents(
  agents: Map<string, Agent>,
  hideInactive: boolean,
  keepIds: ReadonlyArray<string | null | undefined> = [],
): Map<string, Agent> {
  if (!hideInactive) return agents
  const keep = new Set<string>()
  const keepWithAncestors = (start: string | null | undefined) => {
    let id = start
    while (id && !keep.has(id)) {
      keep.add(id)
      id = agents.get(id)?.parentId
    }
  }
  for (const id of keepIds) if (id && agents.has(id)) keepWithAncestors(id)
  for (const a of agents.values()) if (!isInactiveAgent(a)) keepWithAncestors(a.id)
  if (keep.size === agents.size) return agents
  const out = new Map<string, Agent>()
  for (const [id, a] of agents) if (keep.has(id)) out.set(id, a)
  return out
}
