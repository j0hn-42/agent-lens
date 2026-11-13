/**
 * Burrow view: the ring on the floor under an animal, which tells apart the sessions and teams of an 'All sessions'
 * view. Its colour is the one the graph gives the halo of the agent's cluster, by the graph's own rule: the cluster
 * key of clusterKeyOf (a team member, or an agent of the session that hosts a team such as its lead, is in the team's
 * cluster; anyone else in its session's) and one colour per cluster (clusterColor). No ring when the view shows one
 * session and no team: nothing to tell apart. Computed once per sync for the listed agents.
 * Pure (no DOM): unit-tested under node:test.
 */
import type { Agent, TeamSummary } from '../agent-types'
import { clusterColor, clusterKeyOf, hostedTeams } from '../../components/agent-visualizer/canvas/cluster-model'
import { cleanText } from '../../components/agent-visualizer/canvas/team-style'
import { normalizeGroupKind, type GroupKind } from '../ui-glossary'

export type MarkerAgent = Pick<Agent, 'id' | 'sessionId'> & Partial<Pick<Agent, 'teamName' | 'teamKind' | 'teamColor'>>

interface ClusterMark {
  colour: string
  team?: { name: string; kind: GroupKind }
}

export interface MarkerContext {
  /** Several sessions are shown, or a team: the rings are drawn */
  show: boolean
  /** Ring colour and team of each listed agent, by agent id */
  byAgent: ReadonlyMap<string, ClusterMark>
}

/** Rings of the listed agents: their clusters as the graph forms them, and whether there is anything to tell apart */
export function markerContext(shown: Iterable<MarkerAgent>, teams?: ReadonlyMap<string, TeamSummary>): MarkerContext {
  const list = [...shown]
  const hosted = hostedTeams(list, teams)
  const clusters = new Map<string, MarkerAgent[]>()
  for (const a of list) {
    const key = clusterKeyOf(a, teams, hosted)
    const members = clusters.get(key)
    if (members) members.push(a)
    else clusters.set(key, [a])
  }
  const sessions = new Set(list.map((a) => a.sessionId))
  const show = sessions.size > 1 || [...clusters.keys()].some((k) => k.startsWith('team:'))
  const byAgent = new Map<string, ClusterMark>()
  if (!show) return { show, byAgent }
  for (const [key, members] of clusters) {
    const mark: ClusterMark = { colour: clusterColor(key, members, teams) }
    if (key.startsWith('team:')) {
      // the halo's own title and kind: the first member's team name, a workflow when one member or the summary says so
      const raw = cleanText(members.find((m) => cleanText(m.teamName))?.teamName)
      const workflow = members.some((m) => m.teamKind === 'workflow') || teams?.get(raw)?.kind === 'workflow'
      if (raw) mark.team = { name: cleanText(raw, 40), kind: normalizeGroupKind(workflow ? 'workflow' : 'team') }
    }
    for (const m of members) byAgent.set(m.id, mark)
  }
  return { show, byAgent }
}

/** Colour of the agent's ring, or null when no ring is drawn (or the agent is not one of the listed) */
export function colourOf(agent: Pick<MarkerAgent, 'id'>, ctx: MarkerContext): string | null {
  return ctx.byAgent.get(agent.id)?.colour ?? null
}

/** Team or workflow whose halo holds the agent in the graph, when the rings are drawn; undefined otherwise */
export function teamOf(agent: Pick<MarkerAgent, 'id'>, ctx: MarkerContext): { name: string; kind: GroupKind } | undefined {
  return ctx.byAgent.get(agent.id)?.team
}
