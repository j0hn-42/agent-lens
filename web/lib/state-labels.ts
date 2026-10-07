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

/** Teammate activity labels (Agent.activity). */
export const ACTIVITY_LABELS: Record<'working' | 'idle' | 'done', string> = {
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
}

export function getActivityLabel(activity: string): string {
  return (ACTIVITY_LABELS as Record<string, string>)[activity] ?? activity.replace(/_/g, ' ')
}

/** Accepts only '#rrggbb'; anything else (untrusted team config) yields undefined. */
export function safeTeamColor(color: unknown): string | undefined {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined
}

/** Strips control characters and caps the length of an untrusted display string. */
export function safeLabel(value: unknown, max = 60): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return clean ? clean.slice(0, max) : undefined
}
