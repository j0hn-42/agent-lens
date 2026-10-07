/**
 * Archived agents: a finished agent is kept (reduced) instead of being removed, so its
 * conversation stays reachable. A per-session cap evicts the oldest ones.
 */
import type { Agent } from '../../lib/agent-types'
import type { MutableEventState } from './process-event'

/** Archived agents kept per session (oldest completed are evicted first) */
export const MAX_ARCHIVED_PER_SESSION = 200

/** Opacity an archived agent settles at */
export const ARCHIVED_OPACITY = 0.5

/** Agents of `sessionId` to evict so that at most `cap` archived ones remain (oldest completeTime first). */
export function archivedToEvict(agents: Iterable<Agent>, sessionId: string, cap = MAX_ARCHIVED_PER_SESSION): string[] {
  const archived: Agent[] = []
  for (const a of agents) if (a.archived && a.sessionId === sessionId && !a.isMain) archived.push(a)
  if (archived.length <= cap) return []
  archived.sort((a, b) => (a.completeTime ?? 0) - (b.completeTime ?? 0))
  return archived.slice(0, archived.length - cap).map(a => a.id)
}

/** Remove evicted agents with everything hanging on them (edges, tool calls, conversation, timeline). */
export function evictArchived(state: MutableEventState, sessionId: string, cap = MAX_ARCHIVED_PER_SESSION): void {
  const ids = archivedToEvict(state.agents.values(), sessionId, cap)
  if (ids.length === 0) return
  const gone = new Set(ids)
  for (const id of ids) {
    state.agents.delete(id)
    state.conversations.delete(id)
    state.timelineEntries.delete(id)
    state.droppedMessages.delete(id)
  }
  state.edges = state.edges.filter(e => !gone.has(e.from) && !gone.has(e.to))
  for (const [tcId, tc] of state.toolCalls) if (gone.has(tc.agentId)) state.toolCalls.delete(tcId)
}
