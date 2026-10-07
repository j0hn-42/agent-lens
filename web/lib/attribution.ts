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
import { agentCost } from './cost'

export type UnattributedReason = 'orphan' | 'ambiguous'

export interface UnattributedUsage {
  sessionId: string
  reason: UnattributedReason
  tokens: number
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
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const existing = map.get(key)
  if (!existing && key !== OVERFLOW_KEY && map.size >= MAX_UNATTRIBUTED_KEYS) {
    const over = map.get(OVERFLOW_KEY)
    map.set(OVERFLOW_KEY, { sessionId: '', reason: over?.reason ?? reason, tokens: (over?.tokens ?? 0) + tokens })
    return
  }
  const next = mode === 'add' && existing ? existing.tokens + tokens : tokens
  map.set(key, { sessionId, reason, tokens: next })
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
  agents: Iterable<{ tokensUsed: number; model?: string }>,
  unattributed: Iterable<{ tokens: number }>,
): CostSummary {
  let attributedTokens = 0
  let attributedCost = 0
  for (const a of agents) {
    attributedTokens += a.tokensUsed
    attributedCost += agentCost(a.tokensUsed, a.model)
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
