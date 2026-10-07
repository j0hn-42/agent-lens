/**
 * Pure builders for the accessible DOM mirror of the canvas graph (WCAG 1.1.1, 1.3.1, 4.1.2).
 * No React and no canvas here, so everything is unit-testable under node:test.
 * Imports are relative (not "@/") on purpose: the root test runner has no path aliases.
 */
import type { Agent, ToolCallNode, Discovery, Particle, Edge } from '../../../lib/agent-types'
import { formatTokens, formatCost, formatModelName } from '../../../lib/utils'
import { agentCost } from '../../../lib/cost'
import { STATE_LABEL_LONG, A11Y_HISTORY_MAX, A11Y_TOOLS_PER_AGENT, A11Y_ANNOUNCE_MAX } from '../../../lib/canvas-constants'
import type { StateTransition } from './detect-state-changes'

/** Max characters of tool arguments / error text kept in the DOM mirror */
const MAX_TEXT = 240

function clip(text: string | undefined, max = MAX_TEXT): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function stateText(state: string): string {
  return STATE_LABEL_LONG[state] ?? state
}

// ─── Tool-call history (kept after a tool card fades from the canvas) ────────

export interface ToolHistoryEntry {
  id: string
  agentId: string
  name: string
  args: string
  state: ToolCallNode['state']
  error: string
  result: string
  tokenCost?: number
}

/**
 * Fold the current tool calls into a persistent history keyed by id.
 * Entries are never removed because their canvas card faded, only evicted
 * (oldest first) once `max` is exceeded. Returns the same Map instance.
 */
export function updateToolHistory(
  history: Map<string, ToolHistoryEntry>,
  toolCalls: Map<string, ToolCallNode>,
  max = A11Y_HISTORY_MAX,
): Map<string, ToolHistoryEntry> {
  for (const [id, tc] of toolCalls) {
    const entry: ToolHistoryEntry = {
      id,
      agentId: tc.agentId,
      name: tc.toolName,
      args: clip(tc.args),
      state: tc.state,
      error: tc.state === 'error' ? clip(tc.errorMessage || tc.result) : '',
      result: tc.state === 'complete' ? clip(tc.result, 120) : '',
      tokenCost: tc.tokenCost,
    }
    history.set(id, entry) // Map.set keeps the original insertion order for existing ids
  }
  while (history.size > max) {
    const oldest = history.keys().next()
    if (oldest.done) break
    history.delete(oldest.value)
  }
  return history
}

// ─── Communication history (dispatch / return labels vanish in under a second on the canvas) ──

export interface CommEntry {
  id: string
  /** e.g. "main dispatched task to Explorer: Find auth code" */
  text: string
}

/**
 * Record dispatch / return particles that carry a label so the exchange stays readable
 * after the particle is gone. Keyed by particle id; oldest evicted past `max`.
 */
export function updateCommHistory(
  history: Map<string, CommEntry>,
  particles: Particle[],
  edges: Edge[],
  agents: Map<string, Agent>,
  max = A11Y_HISTORY_MAX,
): Map<string, CommEntry> {
  if (particles.length > 0) {
    const edgeById = new Map(edges.map(e => [e.id, e]))
    for (const p of particles) {
      if ((p.type !== 'dispatch' && p.type !== 'return') || !p.label || history.has(p.id)) continue
      const edge = edgeById.get(p.edgeId)
      const from = edge ? agents.get(edge.from)?.name : undefined
      const to = edge ? agents.get(edge.to)?.name : undefined
      const who = p.type === 'dispatch'
        ? `${from ?? 'agent'} dispatched to ${to ?? 'sub-agent'}`
        : `${to ?? 'sub-agent'} returned to ${from ?? 'agent'}`
      history.set(p.id, { id: p.id, text: `${who}: ${clip(p.label, 160)}` })
    }
  }
  while (history.size > max) {
    const oldest = history.keys().next()
    if (oldest.done) break
    history.delete(oldest.value)
  }
  return history
}

// ─── DOM model ───────────────────────────────────────────────────────────────

export interface A11yToolItem extends ToolHistoryEntry {
  stateText: string
  /** Still present on the canvas (and therefore selectable through the simulation) */
  live: boolean
}

export interface A11yAgentItem {
  id: string
  name: string
  state: Agent['state']
  stateText: string
  model: string
  runtime: string
  /** "12k / 200k tokens" */
  tokens: string
  cost: string
  toolCalls: number
  isMain: boolean
  parentId: string | null
  /** "child of X" / "main agent" */
  relation: string
  childNames: string[]
  tools: A11yToolItem[]
}

export interface A11yDiscoveryItem {
  id: string
  type: Discovery['type']
  label: string
  content: string
  agentName: string
}

export interface A11yModel {
  /** aria-label for the canvas wrapper */
  summary: string
  agents: A11yAgentItem[]
  discoveries: A11yDiscoveryItem[]
}

/** "3 agents, 2 running, 1 waiting for permission" */
export function buildGraphLabel(agents: Iterable<Pick<Agent, 'state'>>): string {
  let total = 0, running = 0, waiting = 0, errored = 0
  for (const a of agents) {
    total++
    if (a.state === 'thinking' || a.state === 'tool_calling') running++
    else if (a.state === 'waiting_permission') waiting++
    else if (a.state === 'error') errored++
  }
  if (total === 0) return 'Agent graph: no agents yet'
  const parts = [`${total} ${total === 1 ? 'agent' : 'agents'}`, `${running} running`, `${waiting} waiting for permission`]
  if (errored > 0) parts.push(`${errored} in error`)
  return `Agent graph: ${parts.join(', ')}`
}

export function buildA11yModel(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  discoveries: Discovery[],
  history: Map<string, ToolHistoryEntry>,
): A11yModel {
  const toolsByAgent = new Map<string, A11yToolItem[]>()
  for (const entry of history.values()) {
    let list = toolsByAgent.get(entry.agentId)
    if (!list) { list = []; toolsByAgent.set(entry.agentId, list) }
    list.push({ ...entry, stateText: entry.state, live: toolCalls.has(entry.id) })
  }
  const childNames = new Map<string, string[]>()
  for (const a of agents.values()) {
    if (a.parentId) {
      let list = childNames.get(a.parentId)
      if (!list) { list = []; childNames.set(a.parentId, list) }
      list.push(a.name)
    }
  }

  const agentItems: A11yAgentItem[] = []
  for (const a of agents.values()) {
    const parent = a.parentId ? agents.get(a.parentId) : undefined
    const tools = toolsByAgent.get(a.id) ?? []
    agentItems.push({
      id: a.id,
      name: a.name,
      state: a.state,
      stateText: stateText(a.state),
      model: a.model ? formatModelName(a.model) : 'unknown model',
      runtime: a.runtime === 'codex' ? 'Codex' : 'Claude',
      tokens: `${formatTokens(a.tokensUsed)} / ${formatTokens(a.tokensMax)} tokens`,
      cost: formatCost(agentCost(a.tokensUsed, a.model)),
      toolCalls: a.toolCalls,
      isMain: a.isMain,
      parentId: a.parentId,
      relation: parent ? `child of ${parent.name}` : a.isMain ? 'main agent' : 'no parent',
      childNames: childNames.get(a.id) ?? [],
      tools: tools.length > A11Y_TOOLS_PER_AGENT ? tools.slice(tools.length - A11Y_TOOLS_PER_AGENT) : tools,
    })
  }

  return {
    summary: buildGraphLabel(agents.values()),
    agents: agentItems,
    discoveries: discoveries.map(d => ({
      id: d.id,
      type: d.type,
      label: clip(d.label, 80),
      content: clip(d.content, 160),
      agentName: agents.get(d.agentId)?.name ?? 'unknown agent',
    })),
  }
}

// ─── Live-region announcements ───────────────────────────────────────────────

/** Human sentence for a semantic transition, or null when it is not worth announcing. */
export function describeTransition(t: StateTransition): string | null {
  switch (t.kind) {
    case 'agent_spawn': return `Agent ${t.name} started`
    case 'agent_complete': return `Agent ${t.name} completed`
    case 'agent_error': return `Agent ${t.name} failed`
    case 'agent_waiting_permission': return `Agent ${t.name} is waiting for permission`
    case 'tool_error': return `Tool ${t.name} failed`
    // Tool start/complete are too chatty for a polite live region; they live in the list.
    default: return null
  }
}

/** More announceable transitions than this in one pass (e.g. a session just loaded) collapse into one summary. */
export const ANNOUNCE_BULK_THRESHOLD = 4

/** Append announcements, keeping only the last `max` (older ones would be read late and out of context). */
export function pushAnnouncements(current: string[], transitions: StateTransition[], max = A11Y_ANNOUNCE_MAX): string[] {
  const texts: string[] = []
  for (const t of transitions) {
    const text = describeTransition(t)
    if (text) texts.push(text)
  }
  if (texts.length === 0) return current
  const added = texts.length > ANNOUNCE_BULK_THRESHOLD ? [`${texts.length} agent graph updates`] : texts
  const next = [...current, ...added]
  return next.length > max ? next.slice(next.length - max) : next
}
