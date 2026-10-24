// The English names of the timeline states, a leaf (#662): the message catalog reads them from here, so a locale
// table chunk carries no timeline or color code; timeline-rows.ts re-exports them.

export type TimelineStateKey =
  | 'idle'
  | 'thinking'
  | 'tool_call'
  | 'waiting_permission'
  | 'error'
  | 'complete'

export const TIMELINE_STATE_LABELS: Record<TimelineStateKey, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool_call: 'Tool Call',
  waiting_permission: 'Waiting for permission',
  error: 'Error',
  complete: 'Complete',
}
