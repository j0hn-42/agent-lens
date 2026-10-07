import type { AgentState } from '@/lib/agent-types'

/** User-facing labels for agent states (never show raw identifiers like tool_calling). */
export const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool_calling: 'Calling tool',
  complete: 'Complete',
  error: 'Error',
  paused: 'Paused',
  waiting_permission: 'Waiting for permission',
}

export function getStateLabel(state: string): string {
  return (STATE_LABELS as Record<string, string>)[state] ?? state.replace(/_/g, ' ')
}
