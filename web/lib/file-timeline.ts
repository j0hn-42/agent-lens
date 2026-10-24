/**
 * File timeline (#385): the ordered steps of one file across a session, each tied to the tool call that proved it.
 *
 * Only what the events prove becomes a step:
 * - a Read, Edit / MultiEdit / NotebookEdit or Write call whose end was observed as a success;
 * - a failed or cancelled call, a call still running, or an end whose start was not seen, makes none;
 * - the same call (same call node id, or same tool_use_id) never makes two steps, so a replayed result adds nothing.
 *
 * "Committed" is deliberately not a kind: `git add` / `git commit` commands do not prove which files a commit
 * contains (`commit -a`, a file staged earlier, a hook), and no event lists them. Until one does, no commit step
 * is shown.
 *
 * The list is bounded (FILE_TIMELINE_MAX_STEPS): the most recent steps are kept, the older ones are counted in
 * `omitted`, so a long session never hides that some steps are no longer listed.
 */

export type FileStepKind = 'read' | 'edited' | 'written'

export interface FileStep {
  kind: FileStepKind
  /** Id of the tool call node (ToolCallNode.id) the step comes from */
  callId: string
  /** tool_use_id of that call, when the runtime reported one */
  toolUseId?: string
  /** Agent key (`<session>:<agent>`) */
  agentId: string
  /** Simulation time at which the call's success was observed */
  time: number
}

export interface FileTimeline {
  /** Kept steps, oldest first, in the order their success was observed */
  steps: FileStep[]
  /** Older steps no longer kept because of the cap */
  omitted: number
}

/** Steps kept per file (list-limits.ts); the older ones are counted, not listed. */
import { FILE_TIMELINE_MAX_STEPS } from './list-limits'
export { FILE_TIMELINE_MAX_STEPS }

/** The kind of step a tool makes on its file, or null when the tool makes none. */
export function fileStepKind(toolName: string): FileStepKind | null {
  switch (toolName) {
    case 'Read': return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return 'edited'
    case 'Write': return 'written'
    default: return null
  }
}

/** Whether the timeline already holds a step of this call. */
function hasStepOf(timeline: FileTimeline, step: FileStep): boolean {
  return timeline.steps.some(s => s.callId === step.callId || (step.toolUseId !== undefined && s.toolUseId === step.toolUseId))
}

/**
 * The timeline after one call ended with `outcome`. Unchanged (the same object) unless the call succeeded and is
 * not already listed; past the cap the oldest step is dropped and counted.
 */
export function recordFileStep(
  timeline: FileTimeline | undefined,
  step: FileStep,
  outcome: 'complete' | 'error' | 'cancelled' | 'expired' | 'running',
): FileTimeline | undefined {
  if (outcome !== 'complete') return timeline
  if (timeline && hasStepOf(timeline, step)) return timeline
  const steps = [...(timeline?.steps ?? []), step]
  const over = Math.max(0, steps.length - FILE_TIMELINE_MAX_STEPS)
  return { steps: over > 0 ? steps.slice(over) : steps, omitted: (timeline?.omitted ?? 0) + over }
}

/** Steps observed in all, kept or not. */
export function fileStepTotal(timeline: FileTimeline): number {
  return timeline.steps.length + timeline.omitted
}
