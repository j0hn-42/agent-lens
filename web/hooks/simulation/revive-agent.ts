/**
 * A finished agent that shows work again (#433). A subagent that completed and was resumed (SendMessage
 * "Resuming agent") keeps writing to the same transcript and gets no new agent_spawn: its first observed
 * work event (a tool call start, an assistant or thinking message) is the only proof it is live again.
 * Nothing else brings it back: not a late tool result, not a user message, not an administrative event.
 */
import type { Agent } from '../../lib/agent-types'
import type { MutableEventState } from './process-event'

/**
 * The agent `id`, brought back to life when it was finished: not archived, no completion time, idle between
 * two steps (the caller then sets what the event proves: tool_calling, thinking), its timeline entry open
 * again and a returning teammate working. An agent that is not finished is returned as it is.
 */
export function reviveFinished(state: MutableEventState, id: string): Agent | undefined {
  const agent = state.agents.get(id)
  if (!agent || agent.state !== 'complete') return agent
  const revived: Agent = {
    ...agent,
    state: 'idle',
    awaitingNextEvent: true,
    archived: false,
    completeTime: undefined,
    ...(agent.kind === 'teammate' ? { activity: 'working' as const } : {}),
  }
  state.agents.set(id, revived)
  const entry = state.timelineEntries.get(id)
  if (entry && entry.endTime !== undefined) {
    const { endTime: _ended, ...open } = entry
    state.timelineEntries.set(id, open)
  }
  return revived
}
