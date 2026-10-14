/**
 * Memory behind the inspector's "no longer listed" notice (issue #57). Pure: no React, no clock.
 *
 * The card itself (agent-detail-card.tsx) reads ONLY the selected node's own record for freshness, clock,
 * counters and errors, and tests-a11y/inspector-own-state.test.tsx proves it on the real component. There is
 * no separate view model: it was never executed in production (#221), and it stays that way until the card
 * needs one.
 */
import type { Agent } from './agent-types'

/** Last name the selected id had while it was listed, so "no longer listed" can still name it. */
export interface InspectorMemory { id: string; name: string }

/** Memory follows the selection: it never carries a name over from a previously selected node. */
export function nextInspectorMemory(
  prev: InspectorMemory | null, selectedId: string | null, agent: Pick<Agent, 'name'> | undefined,
): InspectorMemory | null {
  if (!selectedId) return null
  if (agent) return prev && prev.id === selectedId && prev.name === agent.name ? prev : { id: selectedId, name: agent.name }
  return prev && prev.id === selectedId ? prev : null
}

/** Text of the "gone" notice. */
export function goneText(name: string | null): string {
  return `${name ?? 'This node'} is no longer listed`
}
