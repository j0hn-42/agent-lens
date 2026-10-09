/**
 * Bounded per-session event buffers of the webview bridge (#209). Mirrors the relay bounds
 * (RELAY_MAX_EVENTS_PER_SESSION / RELAY_MAX_BUFFERED_SESSIONS / RELAY_REPLAY_LIFECYCLE_RESERVE in
 * extension/src/constants.ts; a test compares them). Positions stay absolute: `base` counts the events
 * dropped from a session's buffer, like `allBaseRef` does for the 'All' buffer.
 */
import type { SimulationEvent } from '@/lib/agent-types'

export const SESSION_BUFFER_MAX_EVENTS = 5000
export const SESSION_BUFFER_MAX_SESSIONS = 50
export const SESSION_BUFFER_LIFECYCLE_RESERVE = 400

const LIFECYCLE_TYPES = new Set(['agent_spawn', 'subagent_dispatch', 'team_info'])

export interface SessionBuffers {
  /** Insertion order = least recently written first */
  events: Map<string, SimulationEvent[]>
  /** Events dropped from the front side of each buffer */
  base: Map<string, number>
}

export function createSessionBuffers(): SessionBuffers {
  return { events: new Map(), base: new Map() }
}

/** Trim to `max`, evicting the oldest non-lifecycle event first (lifecycle only past the reserve). Returns the count dropped. */
function trimKeepingLifecycle(buf: SimulationEvent[], max: number): number {
  let dropped = 0
  while (buf.length > max) {
    let lifecycle = 0
    let victim = -1
    for (let i = 0; i < buf.length; i++) {
      if (LIFECYCLE_TYPES.has(buf[i].type)) { lifecycle++; continue }
      victim = i
      break
    }
    if (victim < 0 || lifecycle > SESSION_BUFFER_LIFECYCLE_RESERVE) victim = 0
    buf.splice(victim, 1)
    dropped++
  }
  return dropped
}

/** Append an event; cap the session buffer, and the number of buffered sessions (least recently written
 *  dropped first, `protectedId` never). */
export function appendSessionEvent(
  s: SessionBuffers, sessionId: string, ev: SimulationEvent, protectedId: string | null = null,
  maxEvents = SESSION_BUFFER_MAX_EVENTS, maxSessions = SESSION_BUFFER_MAX_SESSIONS,
): void {
  const buf = s.events.get(sessionId) ?? []
  buf.push(ev)
  // Re-insert so the Map order tracks recency of writes
  s.events.delete(sessionId)
  s.events.set(sessionId, buf)
  const dropped = trimKeepingLifecycle(buf, maxEvents)
  if (dropped > 0) s.base.set(sessionId, (s.base.get(sessionId) ?? 0) + dropped)
  while (s.events.size > maxSessions) {
    const victim = [...s.events.keys()].find(id => id !== protectedId && id !== sessionId)
    if (victim === undefined) break
    releaseSessionBuffer(s, victim)
  }
}

export function releaseSessionBuffer(s: SessionBuffers, sessionId: string): void {
  s.events.delete(sessionId)
  s.base.delete(sessionId)
}

export function clearSessionBuffers(s: SessionBuffers): void {
  s.events.clear()
  s.base.clear()
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
