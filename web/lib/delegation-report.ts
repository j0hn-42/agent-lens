/**
 * Delegation report (#233): for each direct sub-agent of an agent, its tokens, the files it read, how long the
 * delegation took and what it returned. Every value is either proven by the events or said to be unknown:
 * - tokens: the sub-agent's own counter, qualified like everywhere else ("not reported", "at least", "estimated");
 * - files read: files whose Read call by this sub-agent was observed to succeed; reads not seen to succeed are
 *   counted apart as "not confirmed", never as read;
 * - duration: only the one of a live return: measured between the dispatch and the return as the relay or the
 *   extension observed them, or "recorded" when a background completion notice gives its own (#365). A replayed
 *   or imported return was measured at parse time, so its duration is dropped when the event is handled;
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
  | { kind: 'measured'; seconds: number }
  | { kind: 'recorded'; seconds: number }
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
  durationSource?: unknown,
): DelegationReturn {
  const excerpt = summary.slice(0, REPORT_EXCERPT_LEN)
  const validDuration = typeof durationS === 'number' && Number.isFinite(durationS) && durationS >= 0
  return {
    excerpt,
    truncated: cutChars > 0 || summary.length > REPORT_EXCERPT_LEN,
    isError,
    ...(trustDuration && validDuration ? { durationS, ...(durationSource === 'recorded' ? { durationRecorded: true } : {}) } : {}),
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
  if (ret.durationS === undefined) return { kind: 'not-reported' }
  return { kind: ret.durationRecorded ? 'recorded' : 'measured', seconds: ret.durationS }
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

/** "3 files", "1 file, 2 not confirmed", "none observed" (never "0 files"). `lost`: events the relay could not replay (#366), counts then read "at least". */
export function filesReadText(row: Pick<DelegationRow, 'filesReadCount' | 'readsNotConfirmed'>, lost = 0): string {
  const bounded = lost > 0 ? 'at least ' : ''
  if (row.filesReadCount === 0 && row.readsNotConfirmed === 0) return bounded ? 'none observed (incomplete)' : 'none observed'
  const read = row.filesReadCount > 0 ? `${bounded}${pluralize(row.filesReadCount, 'file')}` : 'none confirmed'
  return row.readsNotConfirmed > 0 ? `${read}, ${bounded}${row.readsNotConfirmed} not confirmed` : read
}

/** "3 sub-agents"; "at least 3 sub-agents" when events may be missing (#366) */
export function delegationCountText(n: number, lost = 0): string {
  return `${lost > 0 ? 'at least ' : ''}${pluralize(n, 'sub-agent')}`
}

export function durationText(d: DelegationDuration, lost = 0): string {
  switch (d.kind) {
    case 'measured': return `${formatDuration(d.seconds)} (measured)`
    case 'recorded': return `${formatDuration(d.seconds)} (recorded)`
    case 'not-reported': return USAGE_LABELS.unavailable
    case 'not-returned': return lost > 0 ? 'no return observed (incomplete)' : 'no return observed'
  }
}

export function resultText(r: DelegationResult, lost = 0): string {
  if (r.kind === 'not-returned') {
    if (lost > 0) return 'No return observed (incomplete)'
    return r.finished ? 'Finished, no return observed' : 'No return observed yet'
  }
  const text = r.excerpt.trim() ? `${r.excerpt}${r.truncated ? '…' : ''}` : 'empty report'
  return r.kind === 'error' ? `Error: ${text}` : r.excerpt.trim() ? text : 'Returned an empty report'
}
