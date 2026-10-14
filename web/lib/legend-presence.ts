/**
 * Which legend entries are proven on screen (#244). Pure: the canvas hands in what its scene holds
 * (agents, tool cards, edges, links...) and gets back the entries whose symbol is really drawn, plus an
 * example agent per entry so the tour can point at it. Nothing is guessed: an entry with no proof is absent.
 * Runtime imports are relative (the root test runner has no "@/" alias).
 */
import type { Agent, Edge } from './agent-types'
import { LEGEND_ENTRY_IDS, type LegendEntryId } from './legend-entries'
import { cleanText, isOrchestrator, teammateActivity } from '../components/agent-visualizer/canvas/team-style'
import type { LinkState } from '../components/agent-visualizer/canvas/link-geometry'
import type { BranchInfo } from '../components/agent-visualizer/canvas/branch-collapse'

/** A row whose symbol left the scene stays listed this long (wall clock), so the list does not flicker under the reader */
export const LEGEND_HOLD_MS = 10_000

/** Cap of an agent label that enters a sentence of the tour */
export const PRESENCE_LABEL_MAX = 40

export interface LegendPresenceInput {
  /** Agents of the drawn scene (hidden, folded and filtered-out agents are not drawn, so they prove nothing) */
  agents: Iterable<Pick<Agent, 'id' | 'name' | 'state' | 'isMain' | 'contextBreakdown'> & Partial<Pick<Agent, 'kind' | 'runtime' | 'archived' | 'activity'>>>
  /** Tool cards of the drawn scene */
  toolCallCount: number
  discoveryTypes: Iterable<string>
  edges: Iterable<Pick<Edge, 'type'> & Partial<Pick<Edge, 'verified'>>>
  particleTypes: Iterable<string>
  /** Resolved communication links (both ends on screen) */
  links: Iterable<{ state: LinkState; messageCount: number }>
  /** Message bubbles that exist as buttons of the outline */
  bubbleCount: number
  fileConflictCount: number
  branches: Iterable<Pick<BranchInfo, 'collapsed' | 'active' | 'descendants'>>
  /** Teams (or workflows) with at least two members on screen */
  teamCount: number
  /** Session halos drawn (several sessions on one canvas) */
  sessionHaloCount: number
}

export interface LegendPresence {
  /** Entries proven on screen, in legend order */
  entries: LegendEntryId[]
  /** For an entry an agent shows: the key of the first such agent */
  agentFor: Partial<Record<LegendEntryId, string>>
  /** Cleaned labels of the agents named in `agentFor` */
  labels: Record<string, string>
}

export const EMPTY_PRESENCE: LegendPresence = { entries: [], agentFor: {}, labels: {} }

const DISCOVERY_ENTRY: Record<string, LegendEntryId> = {
  file: 'disc-file', pattern: 'disc-pattern', finding: 'disc-finding', code: 'disc-code',
}
const CONTEXT_ENTRY: Array<[keyof Agent['contextBreakdown'], LegendEntryId]> = [
  ['systemPrompt', 'ctx-system'], ['userMessages', 'ctx-user'], ['toolResults', 'ctx-tool-results'],
  ['reasoning', 'ctx-reasoning'], ['subagentResults', 'ctx-subagent'],
]
const STATE_ENTRY: Record<Agent['state'], LegendEntryId> = {
  idle: 'state-idle', thinking: 'state-thinking', tool_calling: 'state-tool_calling', waiting_permission: 'state-waiting_permission',
  error: 'state-error', paused: 'state-paused', complete: 'state-complete',
}
const LINK_ENTRY: Record<LinkState, LegendEntryId> = {
  in_flight: 'link-flight', recent: 'link-recent', error: 'link-error', idle: 'link-quiet',
}
const TEAMMATE_ENTRY = { working: 'team-working', idle: 'team-idle', done: 'team-done' } as const

export function deriveLegendPresence(input: LegendPresenceInput): LegendPresence {
  const found = new Set<LegendEntryId>()
  const agentFor: Partial<Record<LegendEntryId, string>> = {}
  const labels: Record<string, string> = {}
  const add = (id: LegendEntryId) => { found.add(id) }
  const addFor = (id: LegendEntryId, agent: { id: string; name: string }) => {
    found.add(id)
    if (agentFor[id] !== undefined) return
    agentFor[id] = agent.id
    labels[agent.id] = cleanText(agent.name, PRESENCE_LABEL_MAX)
  }

  for (const agent of input.agents) {
    addFor(STATE_ENTRY[agent.state], agent)
    addFor(agent.isMain ? 'shape-main' : 'shape-sub', agent)
    if (agent.state === 'complete') addFor('shape-complete', agent)
    if (agent.archived) addFor('team-archived', agent)
    if (isOrchestrator(agent)) addFor('orchestrator', agent)
    addFor(agent.runtime === 'codex' ? 'rt-codex' : agent.runtime === 'copilot' ? 'rt-copilot' : agent.runtime === 'pi' ? 'rt-pi' : agent.runtime === 'gemini' ? 'rt-gemini' : 'rt-claude', agent)
    if (agent.kind === 'teammate') {
      addFor('team-ring', agent)
      const activity = teammateActivity({ kind: agent.kind, activity: agent.activity, state: agent.state })
      if (activity) addFor(TEAMMATE_ENTRY[activity], agent)
    }
    for (const [field, id] of CONTEXT_ENTRY) if (agent.contextBreakdown[field] > 0) addFor(id, agent)
  }

  if (input.toolCallCount > 0) { add('shape-tool'); add('edge-tool') }
  for (const type of input.discoveryTypes) {
    const id = DISCOVERY_ENTRY[type]
    if (id) { add('shape-discovery'); add(id) }
  }
  for (const edge of input.edges) {
    if (edge.type === 'parent-child') add(edge.verified === false ? 'edge-unverified' : 'edge-parent')
  }
  for (const type of input.particleTypes) {
    if (type === 'dispatch') add('particle-dispatch')
    else if (type === 'return') add('particle-return')
  }
  if (input.fileConflictCount > 0) add('edge-file-conflict')
  for (const branch of input.branches) {
    if (!branch.collapsed || branch.descendants <= 0) continue
    add(branch.active > 0 ? 'edge-badge-active' : 'edge-badge-hidden')
  }
  if (input.teamCount > 0) { add('team-halo'); add('team-row') }
  if (input.sessionHaloCount > 0) add('session-halo')
  for (const link of input.links) if (link.messageCount > 0) add(LINK_ENTRY[link.state])
  if (input.bubbleCount > 0) add('link-bubble')

  return { entries: LEGEND_ENTRY_IDS.filter(id => found.has(id)), agentFor, labels }
}

/**
 * Keeps a row listed for `holdMs` after its symbol last proved present. Returns the new "last seen" map
 * (entries past the hold are forgotten, so it stays bounded) and the entries to list, in legend order.
 */
export function holdPresence(
  lastSeen: ReadonlyMap<LegendEntryId, number>, current: readonly LegendEntryId[], now: number, holdMs: number,
): { lastSeen: Map<LegendEntryId, number>; shown: LegendEntryId[] } {
  const next = new Map<LegendEntryId, number>()
  for (const [id, at] of lastSeen) if (now - at <= holdMs) next.set(id, at)
  for (const id of current) next.set(id, now)
  return { lastSeen: next, shown: LEGEND_ENTRY_IDS.filter(id => next.has(id)) }
}
