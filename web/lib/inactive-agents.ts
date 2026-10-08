/**
 * 'Hide inactive agents': pure filter over the simulation's agents. Inactive = idle or complete, except the agents of a workflow that is still active.
 * Parents of a visible agent stay (edges need both ends), as do the selected and hovered agents.
 */
import type { Agent } from './agent-types'
import { isGroupActive } from '../hooks/simulation/team-info'

/** localStorage key of the 'Hide inactive agents' preference */
export const HIDE_INACTIVE_STORAGE_KEY = 'agent-lens:hide-inactive-agents'

/** Parse the persisted preference: hidden by default, only the exact string 'false' shows them. */
export function parseHideInactive(raw: string | null | undefined): boolean {
  return raw !== 'false'
}

export function isInactiveAgent(a: Pick<Agent, 'state' | 'archived' | 'kind' | 'activity'>): boolean {
  if (a.archived === true || a.state === 'complete') return true
  // A teammate reporting activity 'working' is busy even when its agent state is idle
  if (a.kind === 'teammate' && a.activity === 'working') return false
  return a.state === 'idle'
}

type GroupedAgent = Pick<Agent, 'sessionId' | 'teamName' | 'teamKind' | 'clusterKey' | 'activity' | 'state'>

/** Identity of the workflow group an agent belongs to, or undefined for anything else. */
function workflowGroupKey(a: GroupedAgent): string | undefined {
  return a.teamKind === 'workflow' && a.teamName ? (a.clusterKey ?? `${a.sessionId}\u0000${a.teamName}`) : undefined
}

/**
 * Workflow groups that are still active (see isGroupActive): some agent is working, or not every agent
 * is done yet. Their agents all stay on the canvas - a workflow must never draw empty while it runs.
 */
export function activeWorkflowGroups(agents: Iterable<GroupedAgent>): Set<string> {
  const stats = new Map<string, { members: number; done: number; working: number }>()
  for (const a of agents) {
    const key = workflowGroupKey(a)
    if (!key) continue
    const g = stats.get(key) ?? { members: 0, done: 0, working: 0 }
    g.members++
    if (a.activity === 'done' || a.state === 'complete') g.done++
    else if (a.activity === 'working') g.working++
    stats.set(key, g)
  }
  const out = new Set<string>()
  for (const [key, g] of stats) if (isGroupActive({ kind: 'workflow', members: g.members, done: g.done }, g.working)) out.add(key)
  return out
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
  const liveGroups = activeWorkflowGroups(agents.values())
  for (const a of agents.values()) {
    const group = workflowGroupKey(a)
    if (!isInactiveAgent(a) || (group !== undefined && liveGroups.has(group))) keepWithAncestors(a.id)
  }
  if (keep.size === agents.size) return agents
  const out = new Map<string, Agent>()
  for (const [id, a] of agents) if (keep.has(id)) out.set(id, a)
  return out
}
