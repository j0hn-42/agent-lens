/**
 * Agents that need the user (#126): waiting for a permission or in error, counted per session.
 * Pure (no React). Only what is proven is counted: an agent whose last event is stale or closed is not
 * reported as blocked (its state is only the last known one), and only the agents of the current view exist here.
 */
import { deriveFreshness } from '../hooks/simulation/freshness'

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
  /** Ids of every counted agent */
  blockedIds: Set<string>
}

export function summarizeAttention(agents: Iterable<AttentionAgent>, now: number): AttentionSummary {
  const out: AttentionSummary = { waiting: 0, errors: 0, total: 0, firstAgentId: null, bySession: new Map(), blockedIds: new Set() }
  let firstError: string | null = null
  for (const a of agents) {
    if (a.state !== 'waiting_permission' && a.state !== 'error') continue
    const freshness = deriveFreshness(a as Parameters<typeof deriveFreshness>[0], now)
    // 'error' stays visible for a while after the event; a stale waiting state is no longer proven
    if (freshness !== 'fresh' && freshness !== 'error') continue
    const entry = out.bySession.get(a.sessionId) ?? { waiting: 0, errors: 0 }
    if (a.state === 'waiting_permission') {
      entry.waiting++; out.waiting++
      if (out.firstAgentId === null) out.firstAgentId = a.id
    } else {
      entry.errors++; out.errors++
      if (firstError === null) firstError = a.id
    }
    out.bySession.set(a.sessionId, entry)
    out.blockedIds.add(a.id)
  }
  if (out.firstAgentId === null) out.firstAgentId = firstError
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
