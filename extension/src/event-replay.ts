/**
 * Pure helpers for the relay's /events endpoint: URL parsing and replay of the
 * per-session event buffers. Kept free of vscode/http dependencies so they are
 * unit-testable.
 */

import type { AgentEvent } from './protocol'

const MAX_SESSION_PARAM_LENGTH = 200

export interface EventsRequest {
  /** True when the URL path is exactly /events (query string ignored) */
  isEvents: boolean
  /** Session filter from ?session=<id>, when present and sane */
  session?: string
}

/** Parse a request URL such as `/events?session=abc`. The id is only ever used as a Map key. */
export function parseEventsUrl(url: string | undefined): EventsRequest {
  if (!url) return { isEvents: false }
  let parsed: URL
  try { parsed = new URL(url, 'http://localhost') } catch { return { isEvents: false } }
  if (parsed.pathname !== '/events') return { isEvents: false }
  const session = parsed.searchParams.get('session')
  if (session && session.length <= MAX_SESSION_PARAM_LENGTH) return { isEvents: true, session }
  return { isEvents: true }
}

export interface ReplayBatch {
  type: 'agent-event-batch'
  events: AgentEvent[]
}

/**
 * Build the replay messages sent when an SSE client connects.
 * - With `session`: only that session's buffer (nothing if it is unknown or empty).
 * - Otherwise: the buffers of every session, with `primarySessionId` last so the
 *   most relevant session is the one the client processes most recently.
 * Each event already carries its own sessionId.
 */
export function buildReplayBatches(
  buffers: ReadonlyMap<string, readonly AgentEvent[]>,
  opts: { session?: string; primarySessionId?: string } = {},
): ReplayBatch[] {
  if (opts.session) {
    const buf = buffers.get(opts.session)
    return buf && buf.length > 0 ? [{ type: 'agent-event-batch', events: [...buf] }] : []
  }
  const ids = [...buffers.keys()].filter(id => (buffers.get(id)?.length ?? 0) > 0)
  if (opts.primarySessionId && ids.includes(opts.primarySessionId)) {
    ids.splice(ids.indexOf(opts.primarySessionId), 1)
    ids.push(opts.primarySessionId)
  }
  return ids.map(id => ({ type: 'agent-event-batch' as const, events: [...(buffers.get(id) ?? [])] }))
}
