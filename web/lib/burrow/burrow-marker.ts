/**
 * Burrow view: the ring on the floor under an animal, which tells apart the sessions and teams of an 'All sessions'
 * view. Its colour is one the graph already gives the agent's cluster halo: the team colour (validated '#rrggbb', with
 * the halo's fallbacks) for a team or workflow member, else the session colour. A sub-agent without a team of its own
 * is drawn with its parent's (up the tree). No ring when the view shows one session and no team: nothing to tell apart.
 * Pure (no DOM): unit-tested under node:test.
 */
import type { Agent, TeamSummary } from '../agent-types'
import { sessionColor } from '../../components/agent-visualizer/canvas/cluster-model'
import { cleanText, safeTeamColor, TEAM_DEFAULT_COLOR } from '../../components/agent-visualizer/canvas/team-style'
import { teamOfAgent } from '../../hooks/simulation/team-key'
import { normalizeGroupKind, type GroupKind } from '../ui-glossary'

export type MarkerAgent = Pick<Agent, 'id' | 'sessionId' | 'parentId'> & Partial<Pick<Agent, 'teamName' | 'teamKind' | 'teamColor' | 'clusterKey'>>

export interface MarkerContext {
  /** Several sessions are shown, or a team: the rings are drawn */
  show: boolean
  teams?: ReadonlyMap<string, TeamSummary>
}

/** The agent itself when it has a team, else its nearest ancestor that has one (a cycle in the parents ends the walk) */
function teamHolder(agent: MarkerAgent, agents: ReadonlyMap<string, MarkerAgent>): MarkerAgent | undefined {
  const seen = new Set<string>()
  let a: MarkerAgent | undefined = agent
  while (a && !seen.has(a.id)) {
    if (cleanText(a.teamName)) return a
    seen.add(a.id)
    a = a.parentId ? agents.get(a.parentId) : undefined
  }
  return undefined
}

/** Team or workflow the agent is drawn with: its own, else its parent's (up the tree); undefined when none */
export function teamOf(agent: MarkerAgent, agents: ReadonlyMap<string, MarkerAgent>): { name: string; kind: GroupKind } | undefined {
  const h = teamHolder(agent, agents)
  return h ? { name: cleanText(h.teamName, 40), kind: normalizeGroupKind(h.teamKind) } : undefined
}

/** Whether the rings are drawn: the shown agents come from several sessions, or one of them is in a team */
export function markerContext(shown: Iterable<MarkerAgent>, agents: ReadonlyMap<string, MarkerAgent>, teams?: ReadonlyMap<string, TeamSummary>): MarkerContext {
  const sessions = new Set<string>()
  let team = false
  for (const a of shown) {
    sessions.add(a.sessionId)
    if (!team && teamHolder(a, agents)) team = true
  }
  return { show: team || sessions.size > 1, ...(teams ? { teams } : {}) }
}

/** Colour of the agent's ring, or null when no ring is drawn */
export function colourOf(agent: MarkerAgent, agents: ReadonlyMap<string, MarkerAgent>, ctx: MarkerContext): string | null {
  if (!ctx.show) return null
  const h = teamHolder(agent, agents)
  if (!h) return sessionColor(agent.sessionId)
  const own = safeTeamColor(h.teamColor)
  if (own) return own
  // the halo's fallbacks: another member of the same cluster, then the team's summary, then the default team colour
  const name = cleanText(h.teamName)
  for (const o of agents.values()) {
    if (o === h || cleanText(o.teamName) !== name) continue
    if (h.clusterKey !== undefined && o.clusterKey !== undefined && o.clusterKey !== h.clusterKey) continue
    const c = safeTeamColor(o.teamColor)
    if (c) return c
  }
  const summary = teamOfAgent(ctx.teams, { sessionId: h.sessionId, teamName: h.teamName })
  return summary?.members.map((m) => safeTeamColor(m.color)).find(Boolean) ?? TEAM_DEFAULT_COLOR
}
