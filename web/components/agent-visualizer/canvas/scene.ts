import type { Agent, Discovery } from '../../../lib/agent-types'
import type { SimulationState } from '../../../hooks/simulation/types'
import { visibleAgents } from '../../../lib/inactive-agents'
import { evaluateCollapse, applyCollapse, applyCollapseToContent, selectionOwners, focusOwners, type CollapseMemory, type CollapseView } from './branch-collapse'
import type { NavNode } from './keyboard-nav'

/**
 * Agents to draw: the 'hide inactive' filter, then the automatic collapse of inactive sub-trees.
 * The selected agent keeps a branch open, and so does the keyboard-focused node (hovering must not make the graph jump).
 */
export function sceneAgents(
  all: Map<string, Agent>, hideInactive: boolean, keepIds: ReadonlyArray<string | null | undefined>,
  selection: { agentId: string | null; toolCallId: string | null; discoveryId: string | null },
  focused: NavNode | null,
  memory: CollapseMemory, sim: Pick<SimulationState, 'toolCalls' | 'discoveries'>,
): {
  agents: Map<string, Agent>; collapse: CollapseView; toolCalls: SimulationState['toolCalls']; discoveries: Discovery[]
  /** Agents drawn although 'hide inactive' hides them (selected, hovered, keyboard focus): the force layout lays them out too (#554) */
  keptIds: Array<string | null | undefined>
} {
  // The keyboard-focused node pins its branch too, and survives 'hide inactive': focus must not vanish under the user (hover still does not)
  const focusedOwners = focusOwners(focused, sim.toolCalls, sim.discoveries)
  const selectedOwners = selectionOwners(selection.agentId, selection.toolCallId, selection.discoveryId, sim.toolCalls, sim.discoveries)
  // A selected card keeps its owner drawn under 'hide inactive': the card is only drawn with its agent (#378)
  const keptIds = [...keepIds, ...focusedOwners, ...selectedOwners]
  const base = visibleAgents(all, hideInactive, keptIds)
  // A selected card keeps the branch of its owner open, like a selected agent
  const owners = [...selectedOwners, ...focusedOwners]
  const collapse = evaluateCollapse(base, memory, owners)
  const agents = applyCollapse(base, collapse)
  const content = applyCollapseToContent(sim.toolCalls, sim.discoveries, collapse)
  return { agents, collapse, keptIds, ...contentOfDrawnAgents(content.toolCalls, content.discoveries, agents) }
}

/**
 * Tool cards and discoveries of the agents actually drawn (#378): a card whose agent is filtered out
 * ('hide inactive') would otherwise float alone, outside any halo, and drag "Fit to view" towards it.
 * Returns the same Map / array when nothing is dropped (called every frame).
 */
function contentOfDrawnAgents(
  toolCalls: SimulationState['toolCalls'], discoveries: Discovery[], agents: Map<string, Agent>,
): { toolCalls: SimulationState['toolCalls']; discoveries: Discovery[] } {
  let toolsOk = true
  for (const t of toolCalls.values()) if (!agents.has(t.agentId)) { toolsOk = false; break }
  const discOk = discoveries.every(d => agents.has(d.agentId))
  if (toolsOk && discOk) return { toolCalls, discoveries }
  let tools = toolCalls
  if (!toolsOk) {
    tools = new Map()
    for (const [id, t] of toolCalls) if (agents.has(t.agentId)) tools.set(id, t)
  }
  return { toolCalls: tools, discoveries: discOk ? discoveries : discoveries.filter(d => agents.has(d.agentId)) }
}

/**
 * What every cost figure (Costs panel, halos, DOM mirror) is computed on: the whole simulation,
 * never the drawn scene, so a collapsed branch or the 'hide inactive' filter cannot move a total (#106).
 */
export function costScope(sim: Pick<SimulationState, 'agents' | 'toolCalls' | 'unattributed'>) {
  return { agents: sim.agents, toolCalls: sim.toolCalls, unattributed: sim.unattributed.values() }
}
