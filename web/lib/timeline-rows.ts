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

// ─── Swimlane arrows (dispatch / return / peer messages between rows) ────────

/** Minimal link shape the swimlane needs (structurally compatible with AgentLink). */
export interface SwimlaneLink {
  id: string
  from: string
  to: string
  messages: ReadonlyArray<{
    id: string
    type: string
    content: string
    timestamp: number
    from?: string
    to?: string
    isError?: boolean
  }>
}

export type SwimlaneArrowKind = 'dispatch' | 'return' | 'message'

export interface SwimlaneArrow {
  id: string
  kind: SwimlaneArrowKind
  isError: boolean
  fromAgentId: string
  toAgentId: string
  /** Row indexes in the given order */
  fromRow: number
  toRow: number
  time: number
  /** Full content (shown on hover / focus) */
  content: string
  label: string
}

const ARROW_CONTENT_MAX = 2000

function arrowKindOf(type: string): SwimlaneArrowKind | null {
  return type === 'dispatch' || type === 'return' || type === 'message' ? type : null
}

/** Human label: 'orchestrator -> explore - DISPATCH'. */
export function swimlaneArrowLabel(kind: SwimlaneArrowKind, isError: boolean, fromName: string, toName: string): string {
  const word = kind === 'dispatch' ? 'DISPATCH' : kind === 'return' ? (isError ? 'RETURN (ERROR)' : 'RETURN') : 'MESSAGE'
  return `${fromName} -> ${toName} - ${word}`
}

/**
 * Arrows between rows: parent -> child at dispatch, child -> parent at return, and peer messages
 * between teammate rows. Messages whose endpoints have no row are skipped. Sorted by time.
 */
export function buildSwimlaneArrows(
  agentIds: readonly string[],
  links: ReadonlyMap<string, SwimlaneLink> | undefined,
  nameOf: (agentId: string) => string = id => id,
): SwimlaneArrow[] {
  if (!links) return []
  const rowOf = new Map(agentIds.map((id, i) => [id, i]))
  const arrows: SwimlaneArrow[] = []
  const seen = new Set<string>()
  for (const link of links.values()) {
    for (const m of link.messages) {
      const kind = arrowKindOf(m.type)
      if (!kind || seen.has(m.id)) continue
      const from = m.from ?? link.from
      const to = m.to ?? link.to
      const fromRow = rowOf.get(from)
      const toRow = rowOf.get(to)
      if (fromRow === undefined || toRow === undefined || fromRow === toRow) continue
      seen.add(m.id)
      const isError = kind === 'return' && m.isError === true
      arrows.push({
        id: m.id, kind, isError, fromAgentId: from, toAgentId: to, fromRow, toRow,
        time: m.timestamp,
        content: m.content.slice(0, ARROW_CONTENT_MAX),
        label: swimlaneArrowLabel(kind, isError, nameOf(from), nameOf(to)),
      })
    }
  }
  return arrows.sort((a, b) => a.time - b.time)
}

/** Time of the first interaction (message sent or received) per agent id. */
export function firstInteractionTimes(links: ReadonlyMap<string, SwimlaneLink> | undefined): Map<string, number> {
  const first = new Map<string, number>()
  if (!links) return first
  const note = (id: string, t: number) => {
    const prev = first.get(id)
    if (prev === undefined || t < prev) first.set(id, t)
  }
  for (const link of links.values()) {
    for (const m of link.messages) {
      if (!arrowKindOf(m.type)) continue
      note(m.from ?? link.from, m.timestamp)
      note(m.to ?? link.to, m.timestamp)
    }
  }
  return first
}

/** Default row order: by start time (stable). */
export function orderEntriesByStart<T extends { startTime: number }>(entries: readonly T[]): T[] {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.startTime - b.e.startTime || a.i - b.i).map(x => x.e)
}

/**
 * 'Sequence' order: rows sorted by their first interaction; agents that never interacted follow in
 * their start order.
 */
export function orderEntriesBySequence<T extends { agentId: string; startTime: number }>(
  entries: readonly T[],
  links: ReadonlyMap<string, SwimlaneLink> | undefined,
): T[] {
  const first = firstInteractionTimes(links)
  const base = orderEntriesByStart(entries)
  const idx = new Map(base.map((e, i) => [e, i]))
  const withI: T[] = []
  const without: T[] = []
  for (const e of base) (first.has(e.agentId) ? withI : without).push(e)
  withI.sort((a, b) => first.get(a.agentId)! - first.get(b.agentId)! || idx.get(a)! - idx.get(b)!)
  return [...withI, ...without]
}

export interface MessageTableRow {
  id: string
  kind: SwimlaneArrowKind
  label: string
  time: number
  start: string
  content: string
}

/** Rows of the table view's message list. */
export function buildMessageRows(arrows: readonly SwimlaneArrow[]): MessageTableRow[] {
  return arrows.map(a => ({
    id: a.id, kind: a.kind, label: a.label, time: a.time, start: formatDuration(a.time), content: a.content,
  }))
}

/** Arrow whose vertical line is within `tolerance` px of (x, y); used for hover hit-testing. */
export function hitTestArrow(
  arrows: ReadonlyArray<{ x: number; y1: number; y2: number; id: string }>,
  x: number,
  y: number,
  tolerance = 4,
): string | undefined {
  for (const a of arrows) {
    const lo = Math.min(a.y1, a.y2) - tolerance
    const hi = Math.max(a.y1, a.y2) + tolerance
    if (Math.abs(x - a.x) <= tolerance && y >= lo && y <= hi) return a.id
  }
  return undefined
}
