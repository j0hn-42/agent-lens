/**
 * Repeated reads and identical calls (#234). Pure (no React/DOM), computed from the tool events already
 * received. Principle: only what is proven is reported.
 *
 * What counts as a repeat, per agent (each agent has its own context, so two agents reading one file is not a repeat):
 * - Read: the same file, offset and limit, with no Edit/Write/patch seen on that file since the previous read.
 * - Glob: the same pattern and path, with no write seen in the session since the previous call.
 * - Bash / exec_command: the same command, run again right after itself (nothing else between).
 * Only tools whose input summary keeps every argument are compared: Grep and the others drop arguments, so two
 * "equal" summaries would not prove two equal calls. A call of a compared tool that carries no usable input is
 * counted apart (`uncompared`), never guessed. Edits made through Bash or outside the agent are not seen.
 * Tokens are the cost of the repeats only (the first call is not waste); a repeat whose cost was not reported
 * makes the figure a lower bound, never 0. The ledger is bounded: past the limit new calls are not tracked
 * and the summary says it is a lower bound.
 */
import { isValue, formatTokenUsage, USAGE_LABELS, type TokenSource, type UsageTotal } from './usage'

/** Calls, ids and written paths tracked at once; findings are capped at MAX_WASTE_FINDINGS. */
export const MAX_WASTE_TRACKED = 4000
export const MAX_WASTE_FINDINGS = 500
/** Longest path, pattern or command compared; a longer one is not held and counts as not compared. */
export const MAX_WASTE_TARGET_LEN = 1000

export type WasteKind = 'reread' | 'identical'

export interface WasteItem {
  /** Agent key (`session:name`) */
  agentId: string
  kind: WasteKind
  toolName: string
  /** File path, glob pattern or command */
  target: string
  /** Calls beyond the first that repeated it (3 reads = 2 repeats) */
  repeats: number
  lastAt: number
  /** Sum of the known costs of the repeats */
  tokens: number
  costsKnown: number
  /** Repeats whose cost was not reported (or whose end was not seen) */
  costsUnknown: number
  estimated: boolean
}

export interface WasteLedger {
  /** Findings by call signature */
  items: ReadonlyMap<string, WasteItem>
  /** Signature -> write epoch at its last call */
  seen: ReadonlyMap<string, number>
  /** Write counters: per session, per path, and per session for writes whose path is unknown */
  writes: ReadonlyMap<string, number>
  /** Last call signature of each agent ('' when it was not a command) */
  last: ReadonlyMap<string, string>
  /** tool_use_ids already counted (a replayed event is not counted twice) */
  ids: ReadonlySet<string>
  /** Repeat calls waiting for their cost: tool call id -> signature */
  pending: ReadonlyMap<string, string>
  /** Calls of a compared tool that had no usable input */
  uncompared: number
  limitReached: boolean
  /**
   * Batch that may still mutate this ledger's tables in place: a ledger that was published (or belongs to
   * another batch) is never mutated, it is copied first. Without a token every record copies.
   */
  token?: object
}

export function emptyWasteLedger(): WasteLedger {
  return { items: new Map(), seen: new Map(), writes: new Map(), last: new Map(), ids: new Set(), pending: new Map(), uncompared: 0, limitReached: false }
}

export interface WasteCall {
  sessionId: string
  agentId: string
  toolName: string
  inputData?: Record<string, unknown>
  toolUseId?: string
  /** Id of the tool call node, to match its end */
  toolCallId: string
  time: number
}

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'])
const COMMAND_TOOLS = new Set(['Bash', 'exec_command'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' && v.length <= MAX_WASTE_TARGET_LEN ? v : undefined)
const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

interface Draft {
  items: Map<string, WasteItem>
  seen: Map<string, number>
  writes: Map<string, number>
  last: Map<string, string>
  ids: Set<string>
  pending: Map<string, string>
  uncompared: number
  limitReached: boolean
  token?: object
}

/** The ledger to write into: itself when `token` owns it, else a copy owned by `token`. */
const draftOf = (l: WasteLedger, token?: object): Draft =>
  token !== undefined && l.token === token
    ? l as Draft
    : {
        items: new Map(l.items), seen: new Map(l.seen), writes: new Map(l.writes), last: new Map(l.last),
        ids: new Set(l.ids), pending: new Map(l.pending), uncompared: l.uncompared, limitReached: l.limitReached,
        token,
      }

/** The result of a record: a new object (so a reference check sees the change) over the same tables. */
const done = (d: Draft): WasteLedger => ({ ...d })

const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1)

/** A write was seen: it excuses later reads of that path (or of the whole session when its path is unknown). */
function recordWrite(d: Draft, call: WasteCall): void {
  bump(d.writes, `s\0${call.sessionId}`)
  const path = str(call.inputData?.file_path)
  if (path && (d.writes.has(`p\0${call.sessionId}\0${path}`) || d.writes.size < MAX_WASTE_TRACKED)) {
    bump(d.writes, `p\0${call.sessionId}\0${path}`)
  } else {
    if (path) d.limitReached = true
    bump(d.writes, `u\0${call.sessionId}`)
  }
}

interface Signature { sig: string; kind: WasteKind; target: string; epoch: number | null }

/** The comparable identity of a call, or null when its tool is not compared / carries no usable input. */
function signatureOf(writes: ReadonlyMap<string, number>, call: WasteCall): { sig: Signature } | { skipped: true } | null {
  const { toolName, agentId, sessionId, inputData } = call
  if (toolName === 'Read') {
    const path = str(inputData?.file_path)
    if (!path) return { skipped: true }
    const epoch = (writes.get(`p\0${sessionId}\0${path}`) ?? 0) + (writes.get(`u\0${sessionId}`) ?? 0)
    return { sig: { sig: `read\0${agentId}\0${path}\0${num(inputData?.offset)}\0${num(inputData?.limit)}`, kind: 'reread', target: path, epoch } }
  }
  if (toolName === 'Glob') {
    const pattern = str(inputData?.pattern)
    if (!pattern) return { skipped: true }
    const path = typeof inputData?.path === 'string' ? inputData.path.slice(0, MAX_WASTE_TARGET_LEN) : ''
    return { sig: { sig: `glob\0${agentId}\0${pattern}\0${path}`, kind: 'identical', target: pattern, epoch: writes.get(`s\0${sessionId}`) ?? 0 } }
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = str(inputData?.command)
    if (!command) return { skipped: true }
    const workdir = typeof inputData?.workdir === 'string' ? inputData.workdir.slice(0, MAX_WASTE_TARGET_LEN) : ''
    return { sig: { sig: `cmd\0${agentId}\0${toolName}\0${command}\0${workdir}`, kind: 'identical', target: command, epoch: null } }
  }
  return null
}

/**
 * Account for the start of a tool call. Returns `ledger` itself when the call changes nothing, so a caller
 * comparing references does not re-render.
 */
export function recordToolStart(ledger: WasteLedger, call: WasteCall, token?: object): WasteLedger {
  const isWrite = WRITE_TOOLS.has(call.toolName)
  const relevant = isWrite || call.toolName === 'Read' || call.toolName === 'Glob' || COMMAND_TOOLS.has(call.toolName)
  if (!relevant) {
    // Any other call breaks a run of identical commands
    const prev = ledger.last.get(call.agentId)
    if (prev === undefined || prev === '') return ledger
    const d = draftOf(ledger, token)
    d.last.set(call.agentId, '')
    return done(d)
  }
  if (call.toolUseId && ledger.ids.has(call.toolUseId)) return ledger
  const d = draftOf(ledger, token)
  if (call.toolUseId) {
    if (d.ids.size < MAX_WASTE_TRACKED) d.ids.add(call.toolUseId)
    else d.limitReached = true
  }
  const setLast = (value: string) => {
    if (d.last.has(call.agentId) || d.last.size < MAX_WASTE_TRACKED) d.last.set(call.agentId, value)
    else d.limitReached = true
  }
  if (isWrite) {
    recordWrite(d, call)
    setLast('')
    return done(d)
  }
  const found2 = signatureOf(d.writes, call)
  if (!found2 || 'skipped' in found2) {
    d.uncompared++
    setLast('')
    return done(d)
  }
  const { sig, kind, target, epoch } = found2.sig
  const repeated = epoch === null ? d.last.get(call.agentId) === sig : d.seen.get(sig) === epoch
  if (epoch === null) setLast(sig)
  else {
    setLast('')
    if (d.seen.has(sig) || d.seen.size < MAX_WASTE_TRACKED) d.seen.set(sig, epoch)
    else d.limitReached = true
  }
  if (!repeated) return done(d)
  const prev = d.items.get(sig)
  if (!prev && d.items.size >= MAX_WASTE_FINDINGS) {
    d.limitReached = true
    return done(d)
  }
  d.items.set(sig, {
    ...(prev ?? { agentId: call.agentId, kind, toolName: call.toolName, target, repeats: 0, lastAt: call.time, tokens: 0, costsKnown: 0, costsUnknown: 0, estimated: false }),
    repeats: (prev?.repeats ?? 0) + 1,
    lastAt: call.time,
    costsUnknown: (prev?.costsUnknown ?? 0) + 1,
  })
  if (d.pending.size < MAX_WASTE_FINDINGS) d.pending.set(call.toolCallId, sig)
  return done(d)
}

/** Account for the end of a tool call: the cost of a repeat, when the runtime reported one. */
export function recordToolEnd(ledger: WasteLedger, toolCallId: string, tokenCost: number | null, source: TokenSource, token?: object): WasteLedger {
  const sig = ledger.pending.get(toolCallId)
  if (sig === undefined) return ledger
  const d = draftOf(ledger, token)
  d.pending.delete(toolCallId)
  const item = d.items.get(sig)
  if (!item || !isValue(tokenCost)) return done(d)   // stays unknown: never 0
  d.items.set(sig, {
    ...item,
    tokens: item.tokens + tokenCost,
    costsKnown: item.costsKnown + 1,
    costsUnknown: Math.max(0, item.costsUnknown - 1),
    estimated: item.estimated || source === 'estimated',
  })
  return done(d)
}

/** Qualified token cost of the repeats of one finding. */
export function wasteUsage(item: WasteItem): UsageTotal {
  if (item.costsKnown === 0) return { value: null, status: 'unavailable', estimated: false }
  return { value: item.tokens, status: item.costsUnknown > 0 ? 'partial' : 'available', estimated: item.estimated }
}

/** What was observed, as a fact (no verdict: a repeat may be intended). */
export function describeWaste(item: WasteItem): string {
  const times = `${item.repeats} ${item.repeats === 1 ? 'time' : 'times'}`
  if (item.kind === 'reread') return `read again ${times}, no edit seen in between`
  if (item.toolName === 'Glob') return `same Glob run again ${times}, no edit seen in between`
  return `same ${item.toolName} command run again ${times}, right after itself`
}

/** Tokens of the repeats of one finding, qualified ("at least 400 tokens", "tokens not reported"). */
export function formatWasteTokens(item: WasteItem): string {
  const usage = wasteUsage(item)
  return usage.value === null ? `tokens ${USAGE_LABELS.unavailable}` : `${formatTokenUsage(usage)} tokens`
}

/** Findings, costliest first (known tokens, then repeats, then most recent). */
export function listWaste(ledger: WasteLedger): WasteItem[] {
  return Array.from(ledger.items.values()).sort((a, b) => b.tokens - a.tokens || b.repeats - a.repeats || b.lastAt - a.lastAt)
}

export interface WasteSummary {
  items: WasteItem[]
  /** Repeat calls over all findings */
  repeats: number
  uncompared: number
  limitReached: boolean
}

export function wasteSummary(ledger: WasteLedger): WasteSummary {
  const items = listWaste(ledger)
  return { items, repeats: items.reduce((s, i) => s + i.repeats, 0), uncompared: ledger.uncompared, limitReached: ledger.limitReached }
}
