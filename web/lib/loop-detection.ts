/**
 * Loop detection and health verdict (#230). Pure (no React, no path aliases: node:test imports it).
 * Reads the tool calls kept in an agent's conversation and reports only what they prove:
 * - `repeat`: the same tool called REPEAT_THRESHOLD times or more in a row with the same input;
 * - `edit-cycle`: read → edit → failure on the same file, CYCLE_THRESHOLD times in a row.
 * A call without input data is never assumed identical; an outcome that was not observed is never a failure.
 * When earlier messages were dropped (MAX_CONVERSATION_MESSAGES) the verdict says the history is partial.
 */
import type { ConversationMessage } from '../hooks/simulation/types'

export const REPEAT_THRESHOLD = 3
export const CYCLE_THRESHOLD = 3

const READ_TOOLS = new Set(['Read'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export type LoopFinding =
  | { kind: 'repeat'; agentKey?: string; toolName: string; count: number; atLeast: boolean; toolUseIds: string[] }
  | { kind: 'edit-cycle'; agentKey?: string; path: string; count: number; atLeast: boolean; toolUseIds: string[] }

/** loop: a finding is proven; clear: every call observed and comparable, no loop; incomplete: no loop in the part seen; unknown: nothing to judge */
export type HealthStatus = 'loop' | 'clear' | 'incomplete' | 'unknown'

export interface HealthVerdict {
  status: HealthStatus
  findings: LoopFinding[]
  /** Tool calls observed in the kept history */
  calls: number
  /** Calls whose input is known (the only ones that can be compared) */
  comparable: number
  /** Conversation messages dropped before the kept history */
  dropped: number
}

type Outcome = 'ok' | 'error' | 'unknown'

interface ObservedCall {
  toolName: string
  signature: string | null
  path: string | null
  toolUseId?: string
  outcome: Outcome
}

/** JSON with sorted object keys, so two equal inputs give the same text whatever their key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function filePathOf(input: Record<string, unknown> | undefined): string | null {
  const p = input?.file_path ?? input?.notebook_path
  return typeof p === 'string' && p ? p : null
}

/** Tool calls of one conversation in order, each with its observed outcome (paired by tool_use_id, else by tool name in order). */
function observedCalls(messages: readonly ConversationMessage[]): ObservedCall[] {
  const calls: ObservedCall[] = []
  const byId = new Map<string, ObservedCall>()
  const pendingNoId = new Map<string, ObservedCall[]>()
  for (const m of messages) {
    if (m.type === 'tool_call' && m.toolName) {
      const input = m.inputData && typeof m.inputData === 'object' ? m.inputData : undefined
      const c: ObservedCall = {
        toolName: m.toolName,
        signature: input ? `${m.toolName}:${stableStringify(input)}` : null,
        path: filePathOf(input),
        ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}),
        outcome: 'unknown',
      }
      calls.push(c)
      if (m.toolUseId) byId.set(m.toolUseId, c)
      else pendingNoId.set(m.toolName, [...(pendingNoId.get(m.toolName) ?? []), c])
    } else if (m.type === 'tool_result' && m.toolName) {
      let c: ObservedCall | undefined
      if (m.toolUseId) c = byId.get(m.toolUseId)
      else c = pendingNoId.get(m.toolName)?.shift()
      if (c && c.outcome === 'unknown') c.outcome = m.isError ? 'error' : 'ok'
    }
  }
  return calls
}

function findRepeats(calls: ObservedCall[], dropped: number): LoopFinding[] {
  const out: LoopFinding[] = []
  let start = 0
  const flush = (end: number) => {
    const run = calls.slice(start, end)
    if (run.length >= REPEAT_THRESHOLD && run[0].signature !== null) {
      out.push({
        kind: 'repeat', toolName: run[0].toolName, count: run.length,
        atLeast: dropped > 0 && start === 0,
        toolUseIds: run.flatMap(c => c.toolUseId ? [c.toolUseId] : []),
      })
    }
  }
  for (let i = 1; i <= calls.length; i++) {
    if (i === calls.length || calls[i].signature === null || calls[i].signature !== calls[start].signature) {
      flush(i)
      start = i
    }
  }
  return out
}

interface CycleState {
  /** 1: read seen, 2: edited after the read, 3: failure seen after the edit */
  phase: 0 | 1 | 2 | 3
  count: number
  ids: string[]
  /** No reset yet: the streak may have begun before the kept history */
  fromStart: boolean
}

function findEditCycles(calls: ObservedCall[], dropped: number): LoopFinding[] {
  const out: LoopFinding[] = []
  const states = new Map<string, CycleState>()
  const stateOf = (p: string) => {
    let s = states.get(p)
    if (!s) { s = { phase: 0, count: 0, ids: [], fromStart: true }; states.set(p, s) }
    return s
  }
  const close = (path: string, s: CycleState) => {
    if (s.count >= CYCLE_THRESHOLD) {
      out.push({ kind: 'edit-cycle', path, count: s.count, atLeast: dropped > 0 && s.fromStart, toolUseIds: s.ids })
    }
    s.count = 0
    s.ids = []
    s.fromStart = false
  }
  const push = (s: CycleState, c: ObservedCall) => { if (c.toolUseId) s.ids.push(c.toolUseId) }
  // File edited after its read and still waiting for the call that decides the cycle
  let editing: string | null = null

  for (const c of calls) {
    const isEdit = EDIT_TOOLS.has(c.toolName)
    if (editing !== null && !isEdit) {
      // The first call after the edits decides: a failure completes the cycle, anything else breaks the streak
      const s = stateOf(editing)
      if (c.outcome === 'error') { push(s, c); s.count++; s.phase = 3 }
      else { close(editing, s); s.phase = 0 }
      editing = null
    }
    if (!c.path) continue
    const s = stateOf(c.path)
    if (READ_TOOLS.has(c.toolName)) {
      if (s.phase === 0 || s.phase === 3) { if (s.count === 0) s.ids = []; push(s, c) }
      if (s.phase !== 2) s.phase = 1
    } else if (isEdit && (s.phase === 1 || s.phase === 2)) {
      push(s, c)
      if (c.outcome === 'error') { s.count++; s.phase = 3; if (editing === c.path) editing = null }
      else { s.phase = 2; editing = c.path }
    }
  }
  for (const [path, s] of states) close(path, s)
  return out
}

function statusOf(findings: number, calls: number, comparable: number, dropped: number): HealthStatus {
  if (findings > 0) return 'loop'
  if (comparable === 0) return 'unknown'
  if (dropped > 0 || comparable < calls) return 'incomplete'
  return 'clear'
}

/** Verdict for one agent's kept conversation; `dropped` = messages lost before it. */
export function detectLoops(messages: readonly ConversationMessage[], dropped = 0): HealthVerdict {
  const calls = observedCalls(messages)
  const findings = [...findRepeats(calls, dropped), ...findEditCycles(calls, dropped)]
  const comparable = calls.filter(c => c.signature !== null).length
  return { status: statusOf(findings.length, calls.length, comparable, dropped), findings, calls: calls.length, comparable, dropped }
}

export interface HealthSummary {
  byAgent: Map<string, HealthVerdict>
  bySession: Map<string, HealthVerdict>
}

/** Verdict per agent and per session (the union of its agents). An agent of unknown session is judged alone. */
export function assessHealth(
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
  droppedMessages: ReadonlyMap<string, number>,
  sessionOf: (agentKey: string) => string | undefined,
): HealthSummary {
  const byAgent = new Map<string, HealthVerdict>()
  const bySession = new Map<string, HealthVerdict>()
  for (const [agentKey, messages] of conversations) {
    const v = detectLoops(messages, droppedMessages.get(agentKey) ?? 0)
    v.findings = v.findings.map(f => ({ ...f, agentKey }))
    byAgent.set(agentKey, v)
    const sessionId = sessionOf(agentKey)
    if (sessionId === undefined) continue
    const s = bySession.get(sessionId) ?? { status: 'unknown', findings: [], calls: 0, comparable: 0, dropped: 0 }
    s.findings = [...s.findings, ...v.findings]
    s.calls += v.calls
    s.comparable += v.comparable
    s.dropped += v.dropped
    s.status = statusOf(s.findings.length, s.calls, s.comparable, s.dropped)
    bySession.set(sessionId, s)
  }
  return { byAgent, bySession }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One sentence for the verdict, never a bare "healthy". */
export function healthText(v: HealthVerdict): string {
  switch (v.status) {
    case 'loop': return 'Loop observed'
    case 'unknown': return 'Not enough activity to judge'
    case 'clear': return `No loop observed (${plural(v.calls, 'tool call')})`
    case 'incomplete': {
      const parts = [v.comparable < v.calls ? `${v.comparable} of ${plural(v.calls, 'tool call')} comparable` : plural(v.calls, 'tool call')]
      if (v.dropped > 0) parts.push('earlier history dropped')
      return `No loop in the observed part (${parts.join('; ')})`
    }
  }
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

/** One finding as text: what repeated, how often ("at least" when the start may have been dropped). */
export function findingText(f: LoopFinding): string {
  const times = `${f.atLeast ? 'at least ' : ''}${f.count}×`
  return f.kind === 'repeat'
    ? `${f.toolName} called ${times} in a row with the same input`
    : `read → edit → failure ${times} on ${baseName(f.path)}`
}

/** Text of the session row: only a proven loop speaks up there; null otherwise. */
export function sessionHealthText(v: HealthVerdict | undefined): string | null {
  return v?.status === 'loop' ? 'loop observed' : null
}
