import type { Agent } from '../../lib/agent-types'
import { agentKeyOf, cappedString, MAX_ID_LEN } from './types'

/** Untrusted identifier from a payload: a string capped at MAX_ID_LEN, else ''. */
export function idString(v: unknown): string {
  return cappedString(v, MAX_ID_LEN)
}

/** The agent of `sessionId` that was dispatched by the Agent/Task call `toolUseId`, if known. */
export function findAgentByToolUseId(agents: Map<string, Agent>, sessionId: string, toolUseId: string): Agent | undefined {
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.toolUseId === toolUseId) return a
  }
  return undefined
}

/**
 * Local id of a sub-agent. The event stream names agents uniquely per session (the extension
 * adds ' #n' to equal descriptions), but identity must follow the tool_use_id, never the description:
 * - an agent already registered for this tool_use_id keeps its local id;
 * - if the name is taken by an agent dispatched by a different tool_use_id, a disambiguated
 *   local id `${name}@${toolUseId}` is used so both agents coexist.
 *
 * Addressing rule (tested): only dispatch/return/spawn carry the tool_use_id. Later events
 * (tool_call_*, message, context_update, ...) address an agent by its local id, so a plain name
 * always reaches the FIRST holder of that name; the second agent is reached by its disambiguated
 * local id `${name}@${toolUseId}`. Producers that can collide on names must therefore make the names
 * unique per session (the extension appends ' #n') or address the later agent by that local id.
 */
export function resolveChildLocalId(
  agents: Map<string, Agent>,
  sessionId: string,
  name: string,
  toolUseId: string | undefined,
): string {
  if (!toolUseId) return name
  const known = findAgentByToolUseId(agents, sessionId, toolUseId)
  if (known) return known.localId
  const holder = agents.get(agentKeyOf(sessionId, name))
  if (holder && holder.toolUseId && holder.toolUseId !== toolUseId) return `${name}@${toolUseId}`
  return name
}
