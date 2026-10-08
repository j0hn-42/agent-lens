/**
 * Cost attribution (#61). Principle: never display a number that cannot be proven.
 *
 * Rule (one, unambiguous): a usage is attributed to an agent only if the name it addresses
 * resolves to exactly one instance of the session.
 *  - `attributed`: one instance holds that local id and no other instance of the session shares the name
 *    (a later instance with the same name lives under `name@toolUseId`, which makes the plain name ambiguous);
 *  - `orphan`: no instance holds that local id (yet);
 *  - `ambiguous`: several instances share the name, so any pick would be a guess.
 * Orphan and ambiguous usages are kept in a separate, bounded "unattributed" remainder: they count in the
 * session total but never in an agent. An orphan is handed to its agent if that agent shows up later.
 */
import type { Agent } from './agent-types'
import { agentCost, agentCostUsage } from './cost'
import { combineUsage, usageFromAgent, type UsageStatus, type UsageTotal } from './usage'

export type UnattributedReason = 'orphan' | 'ambiguous'

export interface UnattributedUsage {
  sessionId: string
  reason: UnattributedReason
  tokens: number
  /** True as soon as one part of the remainder is an estimate (never claimed exact) */
  estimated: boolean
}

/** Distinct addressed names tracked apart; past it, usages fold into one overflow entry. */
export const MAX_UNATTRIBUTED_KEYS = 64
export const OVERFLOW_KEY = '*overflow*'

export type UsageTarget =
  | { kind: 'attributed'; key: string; agent: Agent }
  | { kind: 'orphan'; key: string }
  | { kind: 'ambiguous'; key: string }

/** Resolve the agent a usage addresses. `localId` is the name as it appears in the event payload. */
export function resolveUsageTarget(agents: Map<string, Agent>, sessionId: string, localId: string): UsageTarget {
  const key = `${sessionId}:${localId}`
  const agent = agents.get(key)
  if (!agent) return { kind: 'orphan', key }
  // The first holder of a name is shadowed as soon as a second instance takes `${name}@${toolUseId}`
  if (!agent.isMain && agent.localId === localId) {
    const prefix = `${localId}@`
    for (const other of agents.values()) {
      if (other.sessionId === sessionId && other.localId !== localId && other.localId.startsWith(prefix)) {
        return { kind: 'ambiguous', key }
      }
    }
  }
  return { kind: 'attributed', key, agent }
}

/**
 * Record a usage in the remainder. `add` accumulates increments (tool cost); `set` replaces the value of an
 * absolute reading (context size). Invalid or non-positive tokens are ignored. Entries are replaced, never mutated.
 */
export function addUnattributed(
  map: Map<string, UnattributedUsage>,
  sessionId: string,
  key: string,
  reason: UnattributedReason,
  tokens: number,
  mode: 'add' | 'set',
  estimated = false,
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const existing = map.get(key)
  if (!existing && key !== OVERFLOW_KEY && map.size >= MAX_UNATTRIBUTED_KEYS) {
    // The overflow entry cannot tell names apart, so an absolute reading cannot replace its predecessor: drop it
    if (mode === 'set') return
    const over = map.get(OVERFLOW_KEY)
    map.set(OVERFLOW_KEY, { sessionId: '', reason: over?.reason ?? reason, tokens: (over?.tokens ?? 0) + tokens, estimated: (over?.estimated ?? false) || estimated })
    return
  }
  const next = mode === 'add' && existing ? existing.tokens + tokens : tokens
  map.set(key, { sessionId, reason, tokens: next, estimated: mode === 'add' && existing ? existing.estimated || estimated : estimated })
}

export interface CostSummary {
  /** Tokens and cost of usages that belong to exactly one agent (the root total) */
  attributedTokens: number
  attributedCost: number
  /** Remainder that could not be attributed, priced at the default rate (the model is unknown) */
  unattributedTokens: number
  unattributedCost: number
  /** Attributed + unattributed */
  sessionTokens: number
  sessionCost: number
}

export function summarizeCosts(
  agents: Iterable<{ tokensUsed: number; model?: string; tokenStatus?: UsageStatus }>,
  unattributed: Iterable<{ tokens: number }>,
): CostSummary {
  let attributedTokens = 0
  let attributedCost = 0
  // An agent whose tokens are unknown adds nothing (never a 0 passed off as a figure); sessionUsage flags the gap
  for (const a of agents) {
    const usage = usageFromAgent(a)
    if (usage.value === null) continue
    attributedTokens += usage.value
    attributedCost += agentCost(usage.value, a.model)
  }
  let unattributedTokens = 0
  for (const u of unattributed) unattributedTokens += u.tokens
  const unattributedCost = agentCost(unattributedTokens)
  return {
    attributedTokens, attributedCost,
    unattributedTokens, unattributedCost,
    sessionTokens: attributedTokens + unattributedTokens,
    sessionCost: attributedCost + unattributedCost,
  }
}

export interface SessionUsage {
  tokens: UsageTotal
  cost: UsageTotal
  summary: CostSummary
}

/**
 * Qualified session totals: per-agent figures keep their completeness (agents with no data make the total a
 * lower bound, estimates are flagged) and the unattributed remainder (#61) counts in the session total.
 */
export function sessionUsage(agents: Iterable<Agent>, unattributed: Iterable<{ tokens: number; estimated?: boolean }>): SessionUsage {
  const list = Array.from(agents)
  const remainder = Array.from(unattributed)
  const summary = summarizeCosts(list, remainder)
  const rest = summary.unattributedTokens > 0
  const restEstimated = remainder.some(u => u.estimated === true)
  const restTokens: UsageTotal = { value: summary.unattributedTokens, status: 'available', estimated: restEstimated }
  const restCost: UsageTotal = { value: summary.unattributedCost, status: 'available', estimated: restEstimated }
  return {
    tokens: combineUsage(rest ? [...list.map(usageFromAgent), restTokens] : list.map(usageFromAgent)),
    cost: combineUsage(rest ? [...list.map(agentCostUsage), restCost] : list.map(agentCostUsage)),
    summary,
  }
}
