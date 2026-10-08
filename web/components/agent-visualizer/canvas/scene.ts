import type { Agent, Discovery } from '../../../lib/agent-types'
import type { SimulationState } from '../../../hooks/simulation/types'
import { visibleAgents } from '../../../lib/inactive-agents'
import { evaluateCollapse, applyCollapse, applyCollapseToContent, selectionOwners, type CollapseMemory, type CollapseView } from './branch-collapse'

/**
 * Agents to draw: the 'hide inactive' filter, then the automatic collapse of inactive sub-trees.
 * Only the selected agent keeps a branch open (hovering must not make the graph jump).
 */
export function sceneAgents(
  all: Map<string, Agent>, hideInactive: boolean, keepIds: ReadonlyArray<string | null | undefined>,
  selection: { agentId: string | null; toolCallId: string | null; discoveryId: string | null },
  memory: CollapseMemory, sim: Pick<SimulationState, 'toolCalls' | 'discoveries'>,
): { agents: Map<string, Agent>; collapse: CollapseView; toolCalls: SimulationState['toolCalls']; discoveries: Discovery[] } {
  const base = visibleAgents(all, hideInactive, keepIds)
  // A selected card keeps the branch of its owner open, like a selected agent
  const owners = selectionOwners(selection.agentId, selection.toolCallId, selection.discoveryId, sim.toolCalls, sim.discoveries)
  const collapse = evaluateCollapse(base, memory, owners)
  return { agents: applyCollapse(base, collapse), collapse, ...applyCollapseToContent(sim.toolCalls, sim.discoveries, collapse) }
}

/**
 * What every cost figure (Costs panel, halos, DOM mirror) is computed on: the whole simulation,
 * never the drawn scene, so a collapsed branch or the 'hide inactive' filter cannot move a total (#106).
 */
export function costScope(sim: Pick<SimulationState, 'agents' | 'toolCalls' | 'unattributed'>) {
  return { agents: sim.agents, toolCalls: sim.toolCalls, unattributed: sim.unattributed.values() }
}
