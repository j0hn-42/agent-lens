/**
 * What the inspector (agent detail card) shows for the selected node (issue #57). Pure: no React, no clock.
 *
 * Rule: the inspector reads ONLY the selected node's own record. Freshness, clock (lastEventAt), counters
 * and errors come from that agent and the tool calls it owns, never from the anchor session (the session
 * the view is opened on) or from any other node. When the selection is no longer in the graph the view
 * says so explicitly instead of substituting another node's values.
 */
import type { Agent } from './agent-types'
import { deriveFreshness, type Freshness } from '../hooks/simulation/freshness'

/** Last name the selected id had while it was listed, so "no longer listed" can still name it. */
export interface InspectorMemory { id: string; name: string }

export type InspectorView =
  | { kind: 'none' }
  | { kind: 'gone'; id: string; name: string | null }
  | {
    kind: 'agent'
    agent: Agent
    freshness: Freshness
    /** Wall-clock ms of this agent's own last event; null = never observed */
    lastEventAt: number | null
    /** Cumulative tool calls of this agent (not of the session) that ended in error; null = not counted, never shown as 0 */
    toolErrors: number | null
  }

/** Memory follows the selection: it never carries a name over from a previously selected node. */
export function nextInspectorMemory(
  prev: InspectorMemory | null, selectedId: string | null, agent: Pick<Agent, 'name'> | undefined,
): InspectorMemory | null {
  if (!selectedId) return null
  if (agent) return prev && prev.id === selectedId && prev.name === agent.name ? prev : { id: selectedId, name: agent.name }
  return prev && prev.id === selectedId ? prev : null
}

export function deriveInspectorView(
  selectedId: string | null,
  agents: ReadonlyMap<string, Agent>,
  memory: InspectorMemory | null,
  now: number,
): InspectorView {
  if (!selectedId) return { kind: 'none' }
  const agent = agents.get(selectedId)
  if (!agent) return { kind: 'gone', id: selectedId, name: memory && memory.id === selectedId ? memory.name : null }
  return {
    kind: 'agent',
    agent,
    freshness: deriveFreshness(agent, now),
    lastEventAt: typeof agent.lastEventAt === 'number' && Number.isFinite(agent.lastEventAt) ? agent.lastEventAt : null,
    toolErrors: typeof agent.toolErrors === 'number' && Number.isFinite(agent.toolErrors) ? agent.toolErrors : null,
  }
}

/** Text of the "gone" notice. */
export function goneText(name: string | null): string {
  return `${name ?? 'This node'} is no longer listed`
}
