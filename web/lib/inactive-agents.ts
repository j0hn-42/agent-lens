/**
 * 'Hide inactive agents': pure filter over the simulation's agents. Inactive = idle, complete or done (a teammate that
 * reported activity 'done'). The agents of a workflow that is still active are only hidden once done: those that
 * work or wait stay, so the workflow is never drawn empty (an active workflow always has a member that is not done).
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

/**
 * A finished agent: archived, complete, or a teammate / workflow member that reported activity 'done'.
 * An error or a permission wait is never "finished": it needs attention and stays visible.
 */
export function isDoneAgent(a: Pick<Agent, 'state' | 'archived' | 'activity'>): boolean {
  if (a.archived === true || a.state === 'complete') return true
  return a.activity === 'done' && a.state !== 'error' && a.state !== 'waiting_permission'
}

export function isInactiveAgent(a: Pick<Agent, 'state' | 'archived' | 'kind' | 'activity'>): boolean {
  if (isDoneAgent(a)) return true
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
    // Inside a live workflow only the finished members go: idle ones are between two calls, not over
    const hidden = group !== undefined && liveGroups.has(group) ? isDoneAgent(a) : isInactiveAgent(a)
    if (!hidden) keepWithAncestors(a.id)
  }
  if (keep.size === agents.size) return agents
  const out = new Map<string, Agent>()
  for (const [id, a] of agents) if (keep.has(id)) out.set(id, a)
  return out
}

/**
 * Finished agents ('done', complete or archived) that 'Hide inactive agents' keeps off the screen, for the polite
 * announcement: the user must not believe agents vanished. 0 when the filter is off.
 */
export function hiddenDoneCount(
  agents: Map<string, Agent>,
  hideInactive: boolean,
  keepIds: ReadonlyArray<string | null | undefined> = [],
): number {
  if (!hideInactive) return 0
  const shown = visibleAgents(agents, true, keepIds)
  if (shown === agents) return 0
  let n = 0
  for (const [id, a] of agents) if (!shown.has(id) && isDoneAgent(a)) n++
  return n
}

/** "3 finished agents hidden" / "1 finished agent hidden"; empty when nothing is hidden. */
export function hiddenDoneText(count: number): string {
  return count > 0 ? `${count} finished ${count === 1 ? 'agent' : 'agents'} hidden` : ''
}
