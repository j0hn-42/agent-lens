/**
 * Pure data-to-rows logic for the timeline panel. Used both for the accessible
 * table view and the canvas aria-label, so it must stay free of DOM/React.
 */

import type { TimelineEntry, TimelineBlock } from './agent-types'
import { COLORS } from './colors'
import { formatDuration } from './utils'

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

export interface TimelineRow {
  agentId: string
  agentName: string
  state: TimelineStateKey
  stateLabel: string
  /** Block label (e.g. "Read: foo.ts") */
  detail: string
  startTime: number
  endTime: number | null
  start: string
  end: string
}

/** Derive the semantic state of a block (type alone cannot express permission/error). */
export function timelineBlockState(block: Pick<TimelineBlock, 'type' | 'color'>): TimelineStateKey {
  if (block.color === COLORS.waiting_permission) return 'waiting_permission'
  if (block.color === COLORS.error) return 'error'
  return block.type
}

/** Overall [min, max] time range, extended to currentTime for running blocks. */
export function computeTimelineRange(
  entries: readonly TimelineEntry[],
  currentTime: number,
): { minTime: number; maxTime: number } {
  if (entries.length === 0) return { minTime: currentTime, maxTime: currentTime }
  let minTime = entries[0].startTime
  let maxTime = currentTime
  for (const e of entries) {
    if (e.startTime < minTime) minTime = e.startTime
    const end = e.endTime ?? currentTime
    if (end > maxTime) maxTime = end
  }
  return { minTime, maxTime }
}

/** One row per block, in entry order then block order. */
export function buildTimelineRows(entries: readonly TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const entry of entries) {
    for (const block of entry.blocks) {
      const state = timelineBlockState(block)
      rows.push({
        agentId: entry.agentId,
        agentName: entry.agentName,
        state,
        stateLabel: TIMELINE_STATE_LABELS[state],
        detail: block.label,
        startTime: block.startTime,
        endTime: block.endTime ?? null,
        start: formatDuration(block.startTime),
        end: block.endTime === undefined ? 'ongoing' : formatDuration(block.endTime),
      })
    }
  }
  return rows
}

/** Accessible name for the timeline canvas. */
export function timelineAriaLabel(entries: readonly TimelineEntry[], currentTime: number): string {
  if (entries.length === 0) return 'Timeline: no data'
  const { minTime, maxTime } = computeTimelineRange(entries, currentTime)
  const n = entries.length
  return `Timeline of ${n} ${n === 1 ? 'agent' : 'agents'}, from ${formatDuration(minTime)} to ${formatDuration(maxTime)}`
}
