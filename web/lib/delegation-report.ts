/**
 * Delegation report (#233): for each direct sub-agent of an agent, its tokens, the files it read, how long the
 * delegation took and what it returned. Every value is either proven by the events or said to be unknown:
 * - tokens: the sub-agent's own counter, qualified like everywhere else ("not reported", "at least", "estimated");
 * - files read: files whose Read call by this sub-agent was observed to succeed; reads not seen to succeed are
 *   counted apart as "not confirmed", never as read;
 * - duration: only the one the runtime reported on a live return (a replayed or imported return was measured at
 *   parse time, so it is dropped when the event is handled);
 * - result: the start of the returned report, an error said in words, or that no return was observed.
 * Pure and bounded. Imports are relative (not "@/"): the root test runner has no path aliases.
 */
import type { Agent, Edge, FileAttention, DelegationReturn } from './agent-types'
import { usageFromAgent, formatTokenUsage, USAGE_LABELS, type UsageTotal } from './usage'
import { formatDuration, pluralize } from './utils'

/** Characters of a returned report kept on the sub-agent */
export const REPORT_EXCERPT_LEN = 280
/** File paths listed per sub-agent (the count stays complete) */
export const FILES_LISTED = 20

export type DelegationDuration =
  | { kind: 'reported'; seconds: number }
  | { kind: 'not-reported' }
  | { kind: 'not-returned' }

export type DelegationResult =
  | { kind: 'returned' | 'error'; excerpt: string; truncated: boolean }
  | { kind: 'not-returned'; finished: boolean }

export interface DelegationRow {
  agentId: string
  name: string
  subagentType?: string
  /** False when the parent-child link is not proven by the events (drawn dashed on the canvas) */
  linkVerified: boolean
  tokens: UsageTotal
  /** Files read with an observed success, sorted, at most FILES_LISTED */
  filesRead: string[]
  /** Number of distinct files read with an observed success */
  filesReadCount: number
  /** Distinct files whose Read was started but never seen to succeed */
  readsNotConfirmed: number
  duration: DelegationDuration
  result: DelegationResult
}

/** The return to keep on the sub-agent; `trustDuration` is false for replayed or imported events. */
export function makeDelegationReturn(
  summary: string, cutChars: number, isError: boolean, durationS: unknown, time: number, trustDuration: boolean,
): DelegationReturn {
  const excerpt = summary.slice(0, REPORT_EXCERPT_LEN)
  const validDuration = typeof durationS === 'number' && Number.isFinite(durationS) && durationS >= 0
  return {
    excerpt,
    truncated: cutChars > 0 || summary.length > REPORT_EXCERPT_LEN,
    isError,
    ...(trustDuration && validDuration ? { durationS } : {}),
    time,
  }
}

function isSubagentOf(a: Agent, parentId: string): boolean {
  return a.parentId === parentId && !a.isMain && a.kind !== 'teammate'
}

function filesOf(agentId: string, fileAttention: ReadonlyMap<string, FileAttention>): { read: string[]; notConfirmed: number } {
  const read: string[] = []
  let notConfirmed = 0
  for (const file of fileAttention.values()) {
    const r = file.readers?.find(x => x.agent === agentId)
    if (!r) continue
    if (r.succeeded > 0) read.push(file.path)
    else if (r.started > 0) notConfirmed++
  }
  read.sort()
  return { read, notConfirmed }
}

function durationOf(ret: DelegationReturn | undefined): DelegationDuration {
  if (!ret) return { kind: 'not-returned' }
  return ret.durationS !== undefined ? { kind: 'reported', seconds: ret.durationS } : { kind: 'not-reported' }
}

function resultOf(agent: Agent): DelegationResult {
  const ret = agent.delegationReturn
  if (!ret) return { kind: 'not-returned', finished: agent.state === 'complete' }
  return { kind: ret.isError ? 'error' : 'returned', excerpt: ret.excerpt, truncated: ret.truncated }
}

/** One row per direct sub-agent of `parentId` (teammates and the main agent are not delegations), in spawn order. */
export function deriveDelegationReport(
  parentId: string,
  agents: ReadonlyMap<string, Agent>,
  fileAttention: ReadonlyMap<string, FileAttention>,
  edges: ReadonlyArray<Edge>,
): DelegationRow[] {
  const children: Agent[] = []
  for (const a of agents.values()) if (isSubagentOf(a, parentId)) children.push(a)
  if (children.length === 0) return []
  children.sort((a, b) => a.spawnTime - b.spawnTime || (a.id < b.id ? -1 : 1))
  const unverified = new Set<string>()
  for (const e of edges) if (e.type === 'parent-child' && e.from === parentId && e.verified === false) unverified.add(e.to)
  return children.map(child => {
    const files = filesOf(child.id, fileAttention)
    return {
      agentId: child.id,
      name: child.name,
      ...(child.subagentType ? { subagentType: child.subagentType } : {}),
      linkVerified: !unverified.has(child.id),
      tokens: usageFromAgent(child),
      filesRead: files.read.slice(0, FILES_LISTED),
      filesReadCount: files.read.length,
      readsNotConfirmed: files.notConfirmed,
      duration: durationOf(child.delegationReturn),
      result: resultOf(child),
    }
  })
}

export function tokensText(row: Pick<DelegationRow, 'tokens'>): string {
  return formatTokenUsage(row.tokens)
}

/** "3 files", "1 file, 2 not confirmed", "none observed" (never "0 files") */
export function filesReadText(row: Pick<DelegationRow, 'filesReadCount' | 'readsNotConfirmed'>): string {
  if (row.filesReadCount === 0 && row.readsNotConfirmed === 0) return 'none observed'
  const read = row.filesReadCount > 0 ? pluralize(row.filesReadCount, 'file') : 'none confirmed'
  return row.readsNotConfirmed > 0 ? `${read}, ${row.readsNotConfirmed} not confirmed` : read
}

export function durationText(d: DelegationDuration): string {
  switch (d.kind) {
    case 'reported': return `${formatDuration(d.seconds)} (reported)`
    case 'not-reported': return USAGE_LABELS.unavailable
    case 'not-returned': return 'no return observed'
  }
}

export function resultText(r: DelegationResult): string {
  if (r.kind === 'not-returned') return r.finished ? 'Finished, no return observed' : 'No return observed yet'
  const text = r.excerpt.trim() ? `${r.excerpt}${r.truncated ? '…' : ''}` : 'empty report'
  return r.kind === 'error' ? `Error: ${text}` : r.excerpt.trim() ? text : 'Returned an empty report'
}
