/**
 * Archived agents: a finished agent is kept (reduced) instead of being removed, so its
 * conversation stays reachable. Bounds:
 * - per session: at most MAX_ARCHIVED_PER_SESSION archived agents (oldest evicted first, never a main
 *   agent nor a teammate);
 * - per team: at most MAX_TEAM_MEMBERS teammates, at most MAX_TEAMS teams (oldest finished teammate first);
 * - overall: MAX_AGENTS_PER_SESSION / MAX_AGENTS_TOTAL agents and MAX_LINKS_* links.
 * - conversations: those of known agents follow the agent caps; conversations of parties that are NOT
 *   agents (events for unknown names, a refused spawn, an evicted agent) are kept only up to
 *   MAX_ORPHAN_CONVERSATIONS, least recently updated first out (see pruneOrphanConversations).
 * A live (non-archived) agent and a lead are never evicted: when nothing can be evicted a new
 * spawn is refused instead (see admitSpawn). Leads (main agents) skip the team gates: they are
 * only subject to the hard agent cap.
 */
import type { Agent } from '../../lib/agent-types'
import type { MutableEventState } from './process-event'
import { MAX_TEAM_MEMBERS, MAX_TEAMS } from './team-info'
import { appendConversation } from './types'

/** Archived agents kept per session (oldest completed are evicted first) */
export const MAX_ARCHIVED_PER_SESSION = 200

/** Agents (live + archived) kept per session */
export const MAX_AGENTS_PER_SESSION = 400
/** Agents kept over all sessions */
export const MAX_AGENTS_TOTAL = 2000
/** Communication links kept per session / over all sessions (oldest created are dropped) */
export const MAX_LINKS_PER_SESSION = 500
export const MAX_LINKS_TOTAL = 2000

/** Conversations kept for parties that are not agents (least recently updated are dropped) */
export const MAX_ORPHAN_CONVERSATIONS = 100
/** Orphan pruning runs once this many conversations beyond the allowance piled up (amortises the scan) */
const ORPHAN_SLACK = 32

/** Opacity an archived agent settles at */
export const ARCHIVED_OPACITY = 0.5

/** Agents of `sessionId` to evict so that at most `cap` archived ones remain (oldest completeTime first). */
export function archivedToEvict(agents: Iterable<Agent>, sessionId: string, cap = MAX_ARCHIVED_PER_SESSION): string[] {
  const archived: Agent[] = []
  for (const a of agents) if (a.archived && a.sessionId === sessionId && !a.isMain && a.kind !== 'teammate') archived.push(a)
  if (archived.length <= cap) return []
  archived.sort((a, b) => (a.completeTime ?? 0) - (b.completeTime ?? 0))
  return archived.slice(0, archived.length - cap).map(a => a.id)
}

/**
 * Keep the conversations of non-agents bounded. Events can name agents that are not in state.agents
 * (a message for an unknown name, a dispatch whose spawn was refused, traffic after an eviction):
 * such conversations are never evicted with an agent, so they are capped here, least recently updated
 * first out. Conversations of known agents are bounded by the agent caps.
 */
export function pruneOrphanConversations(state: MutableEventState): void {
  if (state.conversations.size <= state.agents.size + MAX_ORPHAN_CONVERSATIONS + ORPHAN_SLACK) return
  const orphans: Array<{ key: string; last: number }> = []
  for (const [key, msgs] of state.conversations) {
    if (!state.agents.has(key)) orphans.push({ key, last: msgs.length > 0 ? msgs[msgs.length - 1].timestamp : 0 })
  }
  if (orphans.length <= MAX_ORPHAN_CONVERSATIONS) return
  orphans.sort((a, b) => a.last - b.last)
  for (const o of orphans.slice(0, orphans.length - MAX_ORPHAN_CONVERSATIONS)) {
    state.conversations.delete(o.key)
    state.droppedMessages.delete(o.key)
  }
}

/** Append to a conversation, then keep the conversations of non-agents bounded. */
export function appendBoundedConversation(
  state: MutableEventState,
  agentKey: string,
  message: Parameters<typeof appendConversation>[2],
): void {
  appendConversation(state.conversations, agentKey, message, state.droppedMessages)
  pruneOrphanConversations(state)
}

/** Remove evicted agents with everything hanging on them (edges, tool calls, conversation, timeline). */
export function evictArchived(state: MutableEventState, sessionId: string, cap = MAX_ARCHIVED_PER_SESSION): void {
  evictAgents(state, archivedToEvict(state.agents.values(), sessionId, cap))
}

/** Remove the given agents and everything hanging on them. */
export function evictAgents(state: MutableEventState, ids: string[]): void {
  if (ids.length === 0) return
  const gone = new Set(ids)
  for (const id of ids) {
    state.agents.delete(id)
    state.conversations.delete(id)
    state.timelineEntries.delete(id)
    state.droppedMessages.delete(id)
  }
  for (const [id, l] of state.links) if (gone.has(l.from) || gone.has(l.to)) state.links.delete(id)
  state.edges = state.edges.filter(e => !gone.has(e.from) && !gone.has(e.to))
  for (const [tcId, tc] of state.toolCalls) if (gone.has(tc.agentId)) state.toolCalls.delete(tcId)
}

const byAge = (a: Agent, b: Agent): number => (a.completeTime ?? 0) - (b.completeTime ?? 0)

/** Archived, non-lead, non-teammate agents, oldest finished first, optionally of one session. */
function evictableWorkers(agents: Iterable<Agent>, sessionId?: string): Agent[] {
  const out: Agent[] = []
  for (const a of agents) {
    if (a.archived && !a.isMain && a.kind !== 'teammate' && (sessionId === undefined || a.sessionId === sessionId)) out.push(a)
  }
  return out.sort(byAge)
}

export interface SpawnCandidateInfo { sessionId: string; isMain: boolean; teamName?: string }

/**
 * Decide whether a NEW agent may be added and make room for it. Evicts, oldest finished first,
 * only archived agents: teammates solely beyond their team's cap, never a lead or a live agent.
 * Leads skip the team gates (MAX_TEAMS / MAX_TEAM_MEMBERS) and the per-session cap; only the hard cap applies.
 * Returns false (spawn refused) when the caps hold and nothing may be evicted.
 */
export function admitSpawn(state: MutableEventState, c: SpawnCandidateInfo): boolean {
  let total = 0
  let inSession = 0
  const teams = new Set<string>(state.teams.keys())
  const team: Agent[] = []
  for (const a of state.agents.values()) {
    total++
    if (a.sessionId === c.sessionId) inSession++
    if (a.teamName) {
      teams.add(a.teamName)
      if (a.teamName === c.teamName && a.kind === 'teammate') team.push(a)
    }
  }
  if (c.teamName && !c.isMain) {
    if (!teams.has(c.teamName) && teams.size >= MAX_TEAMS) return false
    if (team.length >= MAX_TEAM_MEMBERS) {
      const finished = team.filter(a => a.archived).sort(byAge)
      const need = team.length - MAX_TEAM_MEMBERS + 1
      if (finished.length < need) return false
      const gone = finished.slice(0, need)
      evictAgents(state, gone.map(a => a.id))
      total -= gone.length
      inSession -= gone.filter(a => a.sessionId === c.sessionId).length
    }
  }
  // Leads are never refused (nor evicted); only a runaway count of them is cut off.
  const hardCap = c.isMain ? MAX_AGENTS_TOTAL * 2 : MAX_AGENTS_TOTAL
  if (inSession >= MAX_AGENTS_PER_SESSION && !c.isMain) {
    const room = inSession - MAX_AGENTS_PER_SESSION + 1
    const ids = evictableWorkers(state.agents.values(), c.sessionId).slice(0, room).map(a => a.id)
    evictAgents(state, ids)
    total -= ids.length
    inSession -= ids.length
    if (inSession >= MAX_AGENTS_PER_SESSION) return false
  }
  if (total >= hardCap) {
    const room = total - hardCap + 1
    const ids = evictableWorkers(state.agents.values()).slice(0, room).map(a => a.id)
    evictAgents(state, ids)
    total -= ids.length
    if (total >= hardCap) return false
  }
  return true
}

/** Make room for one new link: drops the oldest created links beyond the per-session / overall caps. */
export function makeRoomForLink(state: MutableEventState, sessionId: string): void {
  const drop = (over: number, match: (l: { sessionId: string }) => boolean): void => {
    if (over <= 0) return
    for (const [id, l] of state.links) {
      if (over <= 0) break
      if (match(l)) { state.links.delete(id); over-- }
    }
  }
  let inSession = 0
  for (const l of state.links.values()) if (l.sessionId === sessionId) inSession++
  drop(inSession - MAX_LINKS_PER_SESSION + 1, l => l.sessionId === sessionId)
  drop(state.links.size - MAX_LINKS_TOTAL + 1, () => true)
}
