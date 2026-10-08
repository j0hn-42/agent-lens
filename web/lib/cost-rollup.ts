/**
 * Token and cost totals per branch (an agent plus all its sub-agents) and per family (the sessions of
 * a team), each agent counted once (issue #58). Pure (no React/DOM). Principle: a total is never
 * presented as complete when a link is unknown - unknown token counts are skipped and flagged, never
 * turned into 0.
 */
import { agentCost } from './cost'
import { USAGE_LABELS } from './usage'
import { formatCost, formatTokens } from './utils'
import type { AgentLike, AgentNode, SessionRow } from './session-tree'
import type { SessionInfo } from './bridge-types'

/** Deeper branches are cut and the total flagged incomplete (also keeps the walk bounded). */
export const ROLLUP_MAX_DEPTH = 64
/** Walk budget (agents) for one total; beyond it the total is flagged incomplete. */
export const ROLLUP_MAX_AGENTS = 20_000

export const ROLLUP_UNKNOWN_TEXT = 'unknown'
export const ROLLUP_INCOMPLETE_TEXT = '(incomplete)'
/** Accessible explanation of the incomplete badge. */
export const ROLLUP_INCOMPLETE_HELP =
  'Incomplete total: some agents have an unknown token count, a missing parent, a session of the family has no data, or branches are nested too deeply, so the real figure is higher.'

export interface RollupTotal {
  tokens: number
  cost: number
  /** Agents counted (whether or not their tokens are known) */
  agents: number
  /** Agents whose token count is known and included in the sums */
  known: number
  /** Agents whose token count is unknown (skipped, not counted as 0) */
  unknown: number
  /** False when a gap (unknown count, cycle, depth cut, missing parent) can make the sums too low */
  complete: boolean
  /** True when a counted figure is an estimate, not an announced count */
  estimated: boolean
}

type CostAgent = AgentLike & { model?: string }

function emptyTotal(): RollupTotal {
  return { tokens: 0, cost: 0, agents: 0, known: 0, unknown: 0, complete: true, estimated: false }
}

/**
 * Walk `roots` iteratively (no recursion limit), adding into `total`. `seen` is shared across calls
 * so an agent reachable twice (a background agent listed under two parents, or a cycle) counts once.
 */
function walk(roots: ReadonlyArray<AgentNode<CostAgent>>, total: RollupTotal, seen: Set<string>): void {
  const onPath = new Set<string>()
  type Frame = { node: AgentNode<CostAgent>; depth: number; exit: boolean }
  const stack: Frame[] = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 1, exit: false })
  while (stack.length > 0) {
    const { node, depth, exit } = stack.pop()!
    const id = node.agent.id
    if (exit) { onPath.delete(id); continue }
    if (onPath.has(id)) { total.complete = false; continue }   // cycle
    if (seen.has(id)) continue                                 // already counted elsewhere: no double counting
    if (depth > ROLLUP_MAX_DEPTH || total.agents >= ROLLUP_MAX_AGENTS) { total.complete = false; continue }
    seen.add(id)
    total.agents++
    // Known only when an event reported it: tokensUsed starts at 0 on spawn, which is not a measure
    const t = node.agent.tokensUsed as unknown
    if (node.agent.tokensReported === true && typeof t === 'number' && Number.isFinite(t) && t >= 0) {
      total.known++
      if (node.agent.tokensEstimated === true) total.estimated = true
      total.tokens += t
      total.cost += agentCost(t, node.agent.model)
    } else {
      total.unknown++
      total.complete = false
    }
    if (node.children.length > 0) {
      onPath.add(id)
      stack.push({ node, depth, exit: true })
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1, exit: false })
    }
  }
}

/** Total of an orchestrator and all its sub-agents. */
export function rollupBranch(root: AgentNode<CostAgent>): RollupTotal {
  const total = emptyTotal()
  walk([root], total, new Set())
  return total
}

/**
 * Total of several branches (the sessions of a family) with one shared "already counted" set. A root
 * whose parent is declared but absent from the data means a link is missing: the family is incomplete.
 */
export function rollupFamily(roots: ReadonlyArray<AgentNode<CostAgent>>): RollupTotal {
  const total = emptyTotal()
  const seen = new Set<string>()
  walk(roots, total, seen)
  const ids = new Set<string>()
  const collect = (nodes: ReadonlyArray<AgentNode<CostAgent>>) => {
    const stack = [...nodes]
    let budget = ROLLUP_MAX_AGENTS
    while (stack.length > 0 && budget-- > 0) {
      const n = stack.pop()!
      if (ids.has(n.agent.id)) continue
      ids.add(n.agent.id)
      stack.push(...n.children)
    }
  }
  collect(roots)
  for (const r of roots) if (r.agent.parentKey && !ids.has(r.agent.parentKey)) total.complete = false
  return total
}

/**
 * Totals for the rows of the sessions panel, by row id: a session row gets its session's total, a
 * team row the total of the whole family (all its member sessions) counting each agent once.
 */
export function rollupRows(
  rows: ReadonlyArray<SessionRow>,
  /**
   * Whole data the rows were cut from. With it a team total covers every member session, not only the
   * listed rows (an 'Active only' filter or a single-session view hides some), and is flagged incomplete
   * when a member session has no agent data at all.
   */
  whole?: { sessions: ReadonlyArray<SessionInfo>; forests: ReadonlyMap<string, AgentNode[]> },
): Map<string, RollupTotal> {
  const out = new Map<string, RollupTotal>()
  const byTeam = new Map<string, AgentNode[]>()
  for (const row of rows) {
    if (row.kind !== 'session') continue
    out.set(row.id, rollupFamily(row.roots))
    if (row.teamName) {
      const list = byTeam.get(row.teamName)
      if (list) list.push(...row.roots)
      else byTeam.set(row.teamName, [...row.roots])
    }
  }
  for (const row of rows) {
    if (row.kind !== 'team' || !row.teamName) continue
    if (!whole) { out.set(row.id, rollupFamily(byTeam.get(row.teamName) ?? [])); continue }
    const members = whole.sessions.filter(s => s.teamName === row.teamName)
    const total = rollupFamily(members.flatMap(s => whole.forests.get(s.id) ?? []))
    // A member session without any agent data is a missing link, not a zero
    if (members.some(s => (whole.forests.get(s.id) ?? []).length === 0)) total.complete = false
    out.set(row.id, total)
  }
  return out
}

/** "$0.123 · 4.2k", plus the incomplete badge; "unknown" when no agent had a known token count. */
export function formatRollup(total: RollupTotal): string {
  if (total.known === 0) return ROLLUP_UNKNOWN_TEXT
  const text = `${formatCost(total.cost)} · ${formatTokens(total.tokens)}${total.estimated ? ` ${USAGE_LABELS.estimated}` : ''}`
  return total.complete ? text : `${text} ${ROLLUP_INCOMPLETE_TEXT}`
}
