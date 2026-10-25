/**
 * Bounded per-session event buffers of the webview bridge (#209). Mirrors the relay bounds
 * (RELAY_MAX_EVENTS_PER_SESSION / RELAY_MAX_BUFFERED_SESSIONS / RELAY_REPLAY_LIFECYCLE_RESERVE in
 * extension/src/constants.ts; a test compares them). Positions stay absolute: `base` counts the events
 * dropped from a session's buffer, like `allBaseRef` does for the 'All' buffer.
 */
import type { SimulationEvent } from '@/lib/agent-types'
import { estimateEventBytes } from './bounded-buffer'

export const SESSION_BUFFER_MAX_EVENTS = 5000
export const SESSION_BUFFER_MAX_SESSIONS = 50
export const SESSION_BUFFER_LIFECYCLE_RESERVE = 400
/**
 * Estimated bytes all session buffers may hold together (#659). Client-side only (the relay bounds counts): 50 full
 * buffers retained 314 MiB in a real browser with the parser's payload caps (tests-a11y/e2e/heap-measure.ts). Past it the
 * least recently written sessions are freed first, as with the session-count cap; their base keeps the count.
 */
const SESSION_BUFFER_MAX_BYTES = 64 * 1024 * 1024

export const LIFECYCLE_TYPES = new Set(['agent_spawn', 'subagent_dispatch', 'team_info'])

export interface SessionBuffers {
  /** Insertion order = least recently written first */
  events: Map<string, SimulationEvent[]>
  /** Events dropped from each buffer (kept after release so positions never go back) */
  base: Map<string, number>
  /** Estimated bytes of each buffer, and of all of them (see estimateEventBytes) */
  bytes: Map<string, number>
  totalBytes: number
}

export function createSessionBuffers(): SessionBuffers {
  return { events: new Map(), base: new Map(), bytes: new Map(), totalBytes: 0 }
}

/** Index of the next event to evict: the oldest non-lifecycle one (a lifecycle one only past the reserve). */
function evictionVictim(buf: SimulationEvent[]): number {
  let lifecycle = 0
  for (let i = 0; i < buf.length; i++) {
    if (LIFECYCLE_TYPES.has(buf[i].type)) { lifecycle++; continue }
    return lifecycle > SESSION_BUFFER_LIFECYCLE_RESERVE ? 0 : i
  }
  return 0
}

/** Removes one event of a session's buffer and accounts for it: its bytes leave the tallies, its slot goes to the base. */
function dropAt(s: SessionBuffers, sessionId: string, buf: SimulationEvent[], index: number): void {
  const [gone] = buf.splice(index, 1)
  const size = estimateEventBytes(gone)
  s.bytes.set(sessionId, (s.bytes.get(sessionId) ?? 0) - size)
  s.totalBytes -= size
  s.base.set(sessionId, (s.base.get(sessionId) ?? 0) + 1)
}

/** Trim to `max` events, evicting the oldest non-lifecycle event first (lifecycle only past the reserve). */
function trimKeepingLifecycle(s: SessionBuffers, sessionId: string, buf: SimulationEvent[], max: number): void {
  while (buf.length > max) dropAt(s, sessionId, buf, evictionVictim(buf))
}

/** Drops the oldest events of one session (same order as the count trim) until the total fits, keeping the newest. */
function trimBytes(s: SessionBuffers, sessionId: string, maxBytes: number): void {
  const buf = s.events.get(sessionId)
  if (!buf) return
  while (s.totalBytes > maxBytes && buf.length > 1) dropAt(s, sessionId, buf, evictionVictim(buf))
}

/** Append an event; cap the session buffer, the number of buffered sessions and their estimated bytes (least
 *  recently written freed first, `protectedId` and the session written never; past that, the session written then
 *  the protected one lose their oldest events). Every dropped event is counted in its session's base. */
export function appendSessionEvent(
  s: SessionBuffers, sessionId: string, ev: SimulationEvent, protectedId: string | null = null,
  maxEvents = SESSION_BUFFER_MAX_EVENTS, maxSessions = SESSION_BUFFER_MAX_SESSIONS, maxBytes = SESSION_BUFFER_MAX_BYTES,
): void {
  const buf = s.events.get(sessionId) ?? []
  buf.push(ev)
  const size = estimateEventBytes(ev)
  s.bytes.set(sessionId, (s.bytes.get(sessionId) ?? 0) + size)
  s.totalBytes += size
  // Re-insert so the Map order tracks recency of writes
  s.events.delete(sessionId)
  s.events.set(sessionId, buf)
  trimKeepingLifecycle(s, sessionId, buf, maxEvents)
  while (s.events.size > maxSessions || s.totalBytes > maxBytes) {
    const victim = [...s.events.keys()].find(id => id !== protectedId && id !== sessionId)
    if (victim === undefined) break
    releaseSessionBuffer(s, victim)
  }
  if (s.totalBytes > maxBytes) trimBytes(s, sessionId, maxBytes)
  if (s.totalBytes > maxBytes && protectedId !== null && protectedId !== sessionId) trimBytes(s, protectedId, maxBytes)
}

/** Free a session's events. Its base is kept (one number per session): the visualizer caches a snapshot with
 *  the absolute count, and a count that went back to 0 would make it skip the events that arrive later. */
export function releaseSessionBuffer(s: SessionBuffers, sessionId: string): void {
  const total = sessionEventCount(s, sessionId)
  s.events.delete(sessionId)
  s.totalBytes -= s.bytes.get(sessionId) ?? 0
  s.bytes.delete(sessionId)
  if (total > 0) s.base.set(sessionId, total)
}

export function clearSessionBuffers(s: SessionBuffers): void {
  s.events.clear()
  s.base.clear()
  s.bytes.clear()
  s.totalBytes = 0
}

/** Absolute number of events ever buffered for the session (dropped ones included). */
export function sessionEventCount(s: SessionBuffers, sessionId: string): number {
  return (s.base.get(sessionId) ?? 0) + (s.events.get(sessionId)?.length ?? 0)
}

/** Events at absolute position >= fromIndex that are still buffered. */
export function sessionEventsFrom(s: SessionBuffers, sessionId: string, fromIndex = 0): SimulationEvent[] {
  const buf = s.events.get(sessionId) ?? []
  return buf.slice(Math.max(0, fromIndex - (s.base.get(sessionId) ?? 0)))
}

/** Lifecycle events (agent_spawn, subagent_dispatch, team_info) the session's buffer still holds. */
export function bufferedLifecycleCount(s: SessionBuffers, sessionId: string): number {
  let n = 0
  for (const e of s.events.get(sessionId) ?? []) if (LIFECYCLE_TYPES.has(e.type)) n++
  return n
}

/**
 * Whether a cached view must restart from the buffer instead of resuming at `snapshotCount` (#613).
 * Only a trim qualifies, not a release: the buffer must still hold lifecycle events, otherwise a restart would
 * draw an empty canvas where the snapshot still shows the agents (the snapshot is kept, with a silent gap).
 * Lifecycle events survive at the head of a trimmed buffer, so the dropped events are the oldest non-lifecycle
 * ones: events after the snapshot are lost as soon as `base` exceeds the snapshot's count minus the lifecycle
 * events kept (an upper bound of those from before the snapshot, so it errs towards restarting).
 */
export function mustRestartFromBuffer(snapshotCount: number, base: number, lifecycleHeld: number): boolean {
  return base > 0 && lifecycleHeld > 0 && base > snapshotCount - lifecycleHeld
}

/** Events of the session still in memory (not counting the dropped ones). */
export function bufferedEventCount(s: SessionBuffers, sessionId: string): number {
  return s.events.get(sessionId)?.length ?? 0
}

/** What an export can hold (#237): a copy of the buffered events and how many were dropped before them. */
export function sessionExportSlice(s: SessionBuffers, sessionId: string): { events: SimulationEvent[]; droppedBefore: number } {
  const buf = s.events.get(sessionId)
  if (!buf) return { events: [], droppedBefore: 0 }
  return { events: buf.slice(), droppedBefore: s.base.get(sessionId) ?? 0 }
}
