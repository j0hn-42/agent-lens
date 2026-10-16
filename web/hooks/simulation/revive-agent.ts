/**
 * A finished agent that works again (#433). A subagent that completed and was resumed (SendMessage
 * "Resuming agent") keeps writing to the same transcript and gets no new agent_spawn. Two observed facts
 * bring it back, in this order: a prompt (a user turn) received after its end, then its first work event
 * (a tool call start, an assistant or thinking message). Work alone is not enough: the final report of the
 * turn that already ended can reach the screen after `agent_complete` (the transcripts are read in turn).
 * Nothing else brings it back: not a late tool result, not a bookkeeping event.
 */
import type { Agent } from '../../lib/agent-types'
import { SCENE } from '../../lib/colors'
import { pushTimelineBlock, type MutableEventState, type ProcessEventContext } from './process-event'

/** The agent `id`; when it is finished and `role: user` just reached it, it is now waiting for a resume. */
export function armResume(state: MutableEventState, id: string): Agent | undefined {
  const agent = state.agents.get(id)
  if (!agent || agent.state !== 'complete' || agent.resumePrompted) return agent
  const armed: Agent = { ...agent, resumePrompted: true }
  state.agents.set(id, armed)
  return armed
}

/**
 * The agent `id`, brought back to life when it was finished and prompted: not archived, no completion time,
 * idle between two steps (the caller then sets what the event proves: tool_calling, thinking), its timeline
 * entry open again with a neutral block after "Done", and a returning teammate working. Any other agent is
 * returned as it is.
 */
export function reviveFinished(state: MutableEventState, id: string, ctx: ProcessEventContext, time: number): Agent | undefined {
  const agent = state.agents.get(id)
  if (!agent || agent.state !== 'complete' || !agent.resumePrompted) return agent
  const { resumePrompted: _armed, ...rest } = agent
  const revived: Agent = {
    ...rest,
    state: 'idle',
    awaitingNextEvent: true,
    archived: false,
    completeTime: undefined,
    ...(agent.kind === 'teammate' ? { activity: 'working' as const } : {}),
  }
  state.agents.set(id, revived)
  const entry = state.timelineEntries.get(id)
  if (entry) {
    const { endTime: _ended, ...open } = entry
    state.timelineEntries.set(id, pushTimelineBlock(open, time, { type: 'idle', label: 'Resumed', color: SCENE.idle }, ctx))
  }
  return revived
}
