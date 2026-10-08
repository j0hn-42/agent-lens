/**
 * Agents that need the user (#126): waiting for a permission or in error, counted per session.
 * Pure (no React). Only what is proven is counted: a closed agent is never reported as blocked. A pending permission
 * stays counted past the freshness window (nothing answered it: the next event of the agent would change its state),
 * unless it only comes from a replayed history whose status expired. Agents of the other sessions, which the view
 * filter drops, are followed by trackForeignAttention.
 */
import { deriveFreshness } from '../hooks/simulation/freshness'
import type { SimulationEvent } from './agent-types'

export interface AttentionAgent {
  id: string
  sessionId: string
  state: string
  lastEventAt?: number
  freshnessSource?: 'live' | 'history'
}

export interface SessionAttention { waiting: number; errors: number }

export interface AttentionSummary {
  waiting: number
  errors: number
  /** waiting + errors */
  total: number
  /** Agent to jump to: the first waiting one (a permission blocks work), else the first in error */
  firstAgentId: string | null
  bySession: Map<string, SessionAttention>
  /** Session of firstAgentId */
  firstSessionId: string | null
  /** Ids of every counted agent */
  blockedIds: Set<string>
}

export function summarizeAttention(agents: Iterable<AttentionAgent>, now: number): AttentionSummary {
  const out: AttentionSummary = { waiting: 0, errors: 0, total: 0, firstAgentId: null, firstSessionId: null, bySession: new Map(), blockedIds: new Set() }
  let firstError: string | null = null
  let firstErrorSession: string | null = null
  for (const a of agents) {
    if (a.state !== 'waiting_permission' && a.state !== 'error') continue
    const freshness = deriveFreshness(a as Parameters<typeof deriveFreshness>[0], now)
    // 'error' stays visible for a while after the event. A live permission request stays pending until the agent
    // emits another event, so a stale one still counts; a stale history status is not proven any more
    const pending = a.state === 'waiting_permission' && freshness === 'stale' && a.freshnessSource !== 'history'
    if (freshness !== 'fresh' && freshness !== 'error' && !pending) continue
    const entry = out.bySession.get(a.sessionId) ?? { waiting: 0, errors: 0 }
    if (a.state === 'waiting_permission') {
      entry.waiting++; out.waiting++
      if (out.firstAgentId === null) { out.firstAgentId = a.id; out.firstSessionId = a.sessionId }
    } else {
      entry.errors++; out.errors++
      if (firstError === null) { firstError = a.id; firstErrorSession = a.sessionId }
    }
    out.bySession.set(a.sessionId, entry)
    out.blockedIds.add(a.id)
  }
  if (out.firstAgentId === null) { out.firstAgentId = firstError; out.firstSessionId = firstErrorSession }
  out.total = out.waiting + out.errors
  return out
}

/** "2 waiting / 1 error": zero parts are left out; empty when nothing is blocked. */
export function formatAttention(waiting: number, errors: number): string {
  const parts: string[] = []
  if (waiting > 0) parts.push(`${waiting} waiting`)
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  return parts.join(' / ')
}

/** Tab title prefixed with the number of blocked agents; the base title when none. */
export function attentionTitle(base: string, total: number): string {
  return total > 0 ? `(${total}) ${base}` : base
}

/** Strip a title prefix added by attentionTitle. */
export function baseTitle(title: string): string {
  return title.replace(/^\(\d+\) /, '')
}

/** Ids blocked now that were not blocked before: what a browser notification may announce. */
export function newlyBlocked(previous: ReadonlySet<string>, current: ReadonlySet<string>): string[] {
  return [...current].filter(id => !previous.has(id))
}

/** Row text of a session: spelled out (never colour alone). Null when nothing is blocked. */
export function sessionAttentionText(a: SessionAttention | undefined): string | null {
  if (!a) return null
  return formatAttention(a.waiting, a.errors) || null
}

/** Agents of every received session blocked on a permission, keyed by agent key (`session:name`). */
export type ForeignAttention = ReadonlyMap<string, AttentionAgent>

const localIdOf = (payload: Record<string, unknown>): string => {
  for (const k of ['agent', 'name']) {
    const v = payload[k]
    if (typeof v === 'string' && v) return v
  }
  return 'Orchestrator'
}

/**
 * Follows the permission requests of events the view filter drops (other sessions), so the counter covers
 * every session. A request is cleared by the next event of the same agent. Returns `prev` when nothing changed.
 */
export function trackForeignAttention(prev: ForeignAttention, events: readonly SimulationEvent[], now: number): ForeignAttention {
  let next: Map<string, AttentionAgent> | null = null
  for (const e of events) {
    if (!e.sessionId) continue
    const key = `${e.sessionId}:${localIdOf(e.payload as Record<string, unknown>)}`
    const current = (next ?? prev).get(key)
    if (e.type === 'permission_requested') {
      next ??= new Map(prev)
      next.set(key, { id: key, sessionId: e.sessionId, state: 'waiting_permission', lastEventAt: now, freshnessSource: e.replayed ? 'history' : 'live' })
    } else if (current) {
      next ??= new Map(prev)
      next.delete(key)
    }
  }
  return next ?? prev
}

/** Agents of the view plus the foreign ones the view does not hold (the view is authoritative for its own). */
export function withForeignAttention(agents: Iterable<AttentionAgent>, foreign: ForeignAttention): AttentionAgent[] {
  const list = Array.from(agents)
  const known = new Set(list.map(a => a.id))
  for (const [id, a] of foreign) if (!known.has(id)) list.push(a)
  return list
}
