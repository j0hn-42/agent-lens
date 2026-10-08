/**
 * Automatic collapse of inactive sub-trees (#55). Pure model, no React and no canvas.
 *
 * - A branch (an agent with sub-agents and a parent of its own) is collapsed by default unless a
 *   descendant is active or selected. The root of a tree is never collapsed.
 * - A collapsed branch shows "+N" (hidden agents) or a green count of its active descendants.
 * - New activity under a branch the user closed reopens it once; manual choices are remembered.
 * - Tree-style keys: Right expands / enters the first child, Left collapses / goes to the parent.
 * Runtime imports are relative so this file is unit-testable with node:test.
 */
import type { Agent, ToolCallNode, Discovery } from '../../../lib/agent-types'
import { isInactiveAgent } from '../../../lib/inactive-agents'
import { agentDrawRadius } from './team-style'

export type ManualChoice = 'open' | 'closed'

/** What the user decided and what was active last time; owned by the canvas, mutated by `evaluateCollapse`. */
export interface CollapseMemory {
  manual: Map<string, ManualChoice>
  /** Branches that had an active descendant at the previous evaluation (to detect NEW activity) */
  hadActivity: Set<string>
}

export function createCollapseMemory(): CollapseMemory {
  return { manual: new Map(), hadActivity: new Set() }
}

export interface BranchInfo {
  id: string
  /** Direct children present in the evaluated agents, in insertion order */
  children: string[]
  /** All agents below this one */
  descendants: number
  /** Active agents below this one */
  active: number
  collapsed: boolean
  /** Held open because a selected agent is below (the user's choice cannot hide the selection) */
  pinned: boolean
}

export interface CollapseView {
  branches: Map<string, BranchInfo>
  /** Agents hidden by a collapsed ancestor */
  hidden: Set<string>
}

interface Totals { descendants: number; active: number; selected: boolean }

/**
 * Work out which branches are collapsed. Updates `memory` (reopen on new activity, forget vanished
 * agents). `selectedIds` are the agents whose ancestors must stay open.
 */
export function evaluateCollapse(
  agents: Map<string, Agent>,
  memory: CollapseMemory,
  selectedIds: ReadonlyArray<string | null | undefined> = [],
): CollapseView {
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const [id, a] of agents) {
    const parent = a.parentId
    if (parent && parent !== id && agents.has(parent)) {
      const list = children.get(parent)
      if (list) list.push(id)
      else children.set(parent, [id])
    } else if (!parent || !agents.has(parent)) {
      roots.push(id)
    }
  }
  const selected = new Set<string>()
  for (const id of selectedIds) if (id && agents.has(id)) selected.add(id)

  const branches = new Map<string, BranchInfo>()
  const hidden = new Set<string>()
  const seen = new Set<string>()

  // Pre-order from the roots; `seen` also cuts parent cycles (their members are unreachable and stay visible)
  const walk = (id: string, isRoot: boolean, ancestorCollapsed: boolean): void => {
    seen.add(id)
    const kids = (children.get(id) ?? []).filter(k => !seen.has(k))
    let collapsed = false
    if (!isRoot && kids.length > 0) {
      const sub = measure(id, kids)
      const hasActivity = sub.active > 0
      // New activity (none at the previous evaluation) reopens a branch the user had closed, once
      if (hasActivity && !memory.hadActivity.has(id) && memory.manual.get(id) === 'closed') memory.manual.set(id, 'open')
      if (hasActivity) memory.hadActivity.add(id)
      else memory.hadActivity.delete(id)
      const choice = memory.manual.get(id)
      collapsed = sub.selected ? false : choice ? choice === 'closed' : !hasActivity
      branches.set(id, {
        id, children: kids.slice(), descendants: sub.descendants, active: sub.active, collapsed, pinned: sub.selected,
      })
    }
    for (const k of kids) {
      if (ancestorCollapsed || collapsed) hidden.add(k)
      walk(k, false, ancestorCollapsed || collapsed)
    }
  }

  // Totals of the strict subtree of `id` (cycle-safe: a node is counted once)
  const measure = (id: string, kids: string[]): Totals => {
    const t: Totals = { descendants: 0, active: 0, selected: false }
    const visited = new Set<string>([id])
    const stack = [...kids]
    while (stack.length) {
      const k = stack.pop() as string
      if (visited.has(k)) continue
      visited.add(k)
      const a = agents.get(k)
      if (!a) continue
      t.descendants++
      if (!isInactiveAgent(a)) t.active++
      if (selected.has(k)) t.selected = true
      for (const c of children.get(k) ?? []) stack.push(c)
    }
    return t
  }

  for (const r of roots) if (!seen.has(r)) walk(r, true, false)

  // Forget choices of agents that are gone (bounded memory)
  for (const id of memory.manual.keys()) if (!agents.has(id)) memory.manual.delete(id)
  for (const id of memory.hadActivity) if (!agents.has(id)) memory.hadActivity.delete(id)

  return { branches, hidden }
}

/** Agents to draw; returns `agents` itself when nothing is hidden (no allocation, stable identity). */
export function applyCollapse(agents: Map<string, Agent>, view: CollapseView): Map<string, Agent> {
  if (view.hidden.size === 0) return agents
  const out = new Map<string, Agent>()
  for (const [id, a] of agents) if (!view.hidden.has(id)) out.set(id, a)
  return out
}

/**
 * Tool cards and discoveries follow their agent: those of an agent hidden by a collapsed ancestor are
 * not drawn, hit-tested nor navigable. Returns the inputs themselves when nothing is hidden.
 */
export function applyCollapseToContent(
  toolCalls: Map<string, ToolCallNode>,
  discoveries: Discovery[],
  view: CollapseView,
): { toolCalls: Map<string, ToolCallNode>; discoveries: Discovery[] } {
  if (view.hidden.size === 0) return { toolCalls, discoveries }
  const tools = new Map<string, ToolCallNode>()
  for (const [id, t] of toolCalls) if (!view.hidden.has(t.agentId)) tools.set(id, t)
  return { toolCalls: tools, discoveries: discoveries.filter(d => !view.hidden.has(d.agentId)) }
}

/** Agents that must stay visible for the selection: the selected agent and the owner of a selected card. */
export function selectionOwners(
  selectedAgentId: string | null,
  selectedToolCallId: string | null,
  selectedDiscoveryId: string | null,
  toolCalls: Map<string, ToolCallNode>,
  discoveries: Discovery[],
): Array<string | null> {
  return [
    selectedAgentId,
    selectedToolCallId ? toolCalls.get(selectedToolCallId)?.agentId ?? null : null,
    selectedDiscoveryId ? discoveries.find(d => d.id === selectedDiscoveryId)?.agentId ?? null : null,
  ]
}

/** User choice: flip the branch. No effect on a branch held open by the selection or on a non-branch. */
export function toggleBranch(memory: CollapseMemory, view: CollapseView, id: string): void {
  const info = view.branches.get(id)
  if (!info || info.pinned) return
  memory.manual.set(id, info.collapsed ? 'open' : 'closed')
}

export interface BranchBadge {
  /** 'count': grey "+N" hidden agents; 'active': green count of active hidden agents */
  kind: 'count' | 'active'
  text: string
  /** Accessible wording of the badge */
  label: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Indicator of a collapsed branch. */
export function branchBadge(info: Pick<BranchInfo, 'descendants' | 'active'>): BranchBadge {
  const hiddenText = plural(info.descendants, 'hidden agent', 'hidden agents')
  if (info.active > 0) return { kind: 'active', text: String(info.active), label: `${info.active} active of ${hiddenText}` }
  return { kind: 'count', text: `+${info.descendants}`, label: hiddenText }
}

export type TreeKeyAction = { kind: 'toggle'; id: string } | { kind: 'focus'; id: string }

/**
 * Tree-style navigation on the focused agent (WAI-ARIA tree pattern). Null leaves the key to the
 * default graph navigation (leaves, roots, and every key other than Left / Right).
 */
export function treeKeyAction(
  key: string,
  focusedId: string,
  agents: Map<string, Agent>,
  view: CollapseView,
): TreeKeyAction | null {
  const info = view.branches.get(focusedId)
  if (key === 'ArrowRight') {
    if (!info) return null
    if (info.collapsed) return { kind: 'toggle', id: focusedId }
    const first = info.children.find(c => agents.has(c) && !view.hidden.has(c))
    return first ? { kind: 'focus', id: first } : null
  }
  if (key === 'ArrowLeft') {
    if (info && !info.collapsed && !info.pinned) return { kind: 'toggle', id: focusedId }
    const parent = agents.get(focusedId)?.parentId
    return parent && agents.has(parent) && !view.hidden.has(parent) ? { kind: 'focus', id: parent } : null
  }
  return null
}

// ─── Badge geometry (shared by drawing and hit testing) ──────────────────────

/** Badge height and per-character width (world px); text is drawn centred in the rect */
export const BADGE = { h: 14, charW: 6.5, padX: 8, font: 10 } as const

/** Text the badge width is computed from: the active badge also holds its green dot. */
export function badgeSizeText(badge: Pick<BranchBadge, 'kind' | 'text'>): string {
  return badge.kind === 'active' ? `  ${badge.text}` : badge.text
}

/** World rect of the badge of a collapsed node: on its lower right, outside the hexagon. */
export function badgeRect(
  agent: Pick<Agent, 'x' | 'y' | 'archived' | 'scale' | 'isMain' | 'kind'>,
  text: string,
): { x: number; y: number; w: number; h: number } {
  const r = agentDrawRadius(agent)
  const w = Math.round(text.length * BADGE.charW + BADGE.padX)
  return { x: agent.x + r * 0.55, y: agent.y + r * 0.55, w, h: BADGE.h }
}
