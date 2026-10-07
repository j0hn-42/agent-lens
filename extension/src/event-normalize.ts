/**
 * The single normalization module for everything the extension ingests: hook payloads, Claude
 * JSONL lines and Codex rollout lines are all untrusted. Pure (no vscode, no I/O), so it is
 * unit-testable and mirrored by web/lib/event-normalize.ts.
 *
 * Principle: never display a state or a number that cannot be proven. Every field that is
 * altered or discarded is counted in a per-session {@link NormalizationStats}; the counters are
 * exposed to the UI as a `normalization_stats` event, which drives the "graph truncated" banner.
 *
 * Caps (see the NORM_* constants): text/id length, number magnitude, timestamp range, payload
 * depth/array/key counts, children per agent, nodes per session, events per batch, line length.
 *
 * A spawn whose parent was never seen becomes a detached "orphan" node (`orphan: true`, no
 * `parent`): the parent is never guessed.
 */
import type { AgentEvent, AgentEventType, NormalizationStats } from './protocol'
import {
  NORM_TEXT_MAX, NORM_ID_MAX, NORM_NUM_MAX, NORM_EVENT_TIME_MAX_S, NORM_TS_MAX_MS,
  NORM_MAX_DEPTH, NORM_MAX_ARRAY, NORM_MAX_KEYS,
  NORM_MAX_CHILDREN_PER_AGENT, NORM_MAX_NODES_PER_SESSION, NORM_MAX_EVENTS_PER_BATCH,
  NORM_MAX_LINE_CHARS, NORM_MAX_SEEN_KEYS, NORM_MAX_DROPPED_NAMES, NORM_STATS_MIN_INTERVAL_MS,
  ORCHESTRATOR_NAME,
} from './constants'

/** Every event type the UI understands; anything else is ignored (forward compatible). */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'agent_spawn', 'agent_complete', 'agent_idle', 'message', 'context_update', 'model_detected',
  'tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return', 'permission_requested',
  'error', 'agent_link', 'message_sent', 'team_info', 'agent_activity', 'normalization_stats',
]

/** Keys that must never be copied from untrusted data (prototype pollution). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Payload keys holding epoch-ms timestamps (validated with {@link ts}). */
const TS_KEYS: ReadonlySet<string> = new Set(['joinedAt', 'startTime', 'lastActivityTime', 'timestamp'])

/** Payload keys holding identifiers / names (capped at NORM_ID_MAX, no newlines). */
const ID_KEYS: ReadonlySet<string> = new Set([
  'name', 'agent', 'parent', 'child', 'from', 'to', 'tool', 'toolUseId', 'linkId', 'sessionId',
  'label', 'teamName', 'model', 'subagentType', 'memberSessionId', 'leadSessionId', 'leadName',
  'agentType', 'backendType', 'kind', 'role', 'activity', 'color',
])

export function createStats(): NormalizationStats {
  return { ignoredEvents: 0, clampedFields: 0, droppedByCap: 0, malformed: 0, duplicateEvents: 0 }
}

/** True when something that shapes the graph was discarded (duplicates and clamping alone do not count). */
export function isTruncated(s: NormalizationStats): boolean {
  return s.ignoredEvents + s.droppedByCap + s.malformed > 0
}

function bump(stats: NormalizationStats | undefined, key: keyof NormalizationStats, n = 1): void {
  if (stats) stats[key] += n
}

// ─── Leaf helpers ────────────────────────────────────────────────────────────

// C0 controls except TAB / LF / CR, DEL, and the bidi/line-separator hazards.
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F\u2028\u2029]/g

/**
 * Bounded string: control characters stripped, length capped at `max`. Non-strings give
 * undefined. `multiline` keeps TAB/LF/CR (free text); identifiers lose them too. Counts one
 * clamped field when the value was altered.
 */
export function ostr(v: unknown, max: number, stats?: NormalizationStats, multiline = false): string | undefined {
  if (typeof v !== 'string') return undefined
  // Cut first so a huge string is never scanned in full.
  let out = v.length > max ? v.slice(0, max) : v
  const cleaned = out.replace(multiline ? CONTROL_TEXT : CONTROL_ALL, '')
  if (cleaned !== out || v.length > max) bump(stats, 'clampedFields')
  out = cleaned
  return out
}

/** Finite number clamped to [min, max]. NaN/Infinity/non-numbers give undefined. */
export function num(v: unknown, stats?: NormalizationStats, min = -NORM_NUM_MAX, max = NORM_NUM_MAX): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  if (v < min) { bump(stats, 'clampedFields'); return min }
  if (v > max) { bump(stats, 'clampedFields'); return max }
  return v
}

/** Member of `allowed`, else undefined. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && v.length === 36 && UUID_RE.test(v)
}

/** Epoch-ms timestamp: finite, within [0, NORM_TS_MAX_MS] (clamped); anything else undefined. */
export function ts(v: unknown, stats?: NormalizationStats): number | undefined {
  return num(v, stats, 0, NORM_TS_MAX_MS)
}

/** First `max` items of an array (counts one clamped field when cut); non-arrays give undefined. */
export function boundedArray<T>(v: unknown, max: number, stats?: NormalizationStats): T[] | undefined {
  if (!Array.isArray(v)) return undefined
  if (v.length > max) { bump(stats, 'clampedFields'); return v.slice(0, max) as T[] }
  return v as T[]
}

/** Own enumerable entries of a plain object, forbidden keys removed and the count bounded. */
export function boundedEntries(v: unknown, max: number, stats?: NormalizationStats): Array<[string, unknown]> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Array<[string, unknown]> = []
  let cut = false
  for (const key of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(key)) { bump(stats, 'clampedFields'); continue }
    if (out.length >= max) { cut = true; break }
    out.push([key, (v as Record<string, unknown>)[key]])
  }
  if (cut) bump(stats, 'clampedFields')
  return out
}

/**
 * Deep-clean an untrusted JSON value: strings capped and stripped, numbers finite and clamped,
 * forbidden keys removed, depth/array/key counts bounded. Undefined = drop the value.
 */
export function sanitizeValue(v: unknown, stats?: NormalizationStats, key = '', depth = 0): unknown {
  if (v === null || v === undefined) return undefined
  switch (typeof v) {
    case 'string': {
      if (TS_KEYS.has(key)) return undefined
      return ID_KEYS.has(key) ? ostr(v, NORM_ID_MAX, stats) : ostr(v, NORM_TEXT_MAX, stats, true)
    }
    case 'number': {
      const n = TS_KEYS.has(key) ? ts(v, stats) : num(v, stats)
      if (n === undefined) bump(stats, 'clampedFields') // NaN / Infinity: the field is dropped
      return n
    }
    case 'boolean':
      return v
    case 'object': {
      if (depth >= NORM_MAX_DEPTH) { bump(stats, 'clampedFields'); return undefined }
      if (Array.isArray(v)) {
        const items = boundedArray<unknown>(v, NORM_MAX_ARRAY, stats) ?? []
        return items.map(item => sanitizeValue(item, stats, '', depth + 1)).filter(item => item !== undefined)
      }
      const out: Record<string, unknown> = {}
      for (const [k, val] of boundedEntries(v, NORM_MAX_KEYS, stats) ?? []) {
        const clean = sanitizeValue(val, stats, k, depth + 1)
        if (clean !== undefined) out[k] = clean
        else if (val !== null && val !== undefined) bump(stats, 'clampedFields')
      }
      return out
    }
    default:
      bump(stats, 'clampedFields') // function / symbol / bigint: not JSON
      return undefined
  }
}

// ─── Line parsing ────────────────────────────────────────────────────────────

/**
 * Parse one JSONL line into a plain object. Blank lines give undefined silently; oversized,
 * unparseable and non-object lines give undefined and count as malformed.
 */
export function parseJsonLine(line: unknown, stats?: NormalizationStats): Record<string, unknown> | undefined {
  if (typeof line !== 'string') { bump(stats, 'malformed'); return undefined }
  if (line.length > NORM_MAX_LINE_CHARS) { bump(stats, 'malformed'); return undefined }
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { bump(stats, 'malformed'); return undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { bump(stats, 'malformed'); return undefined }
  return parsed as Record<string, unknown>
}

// ─── Per-session normalizer ──────────────────────────────────────────────────

export interface SessionNormalizerOptions {
  /** Injectable clock (ms) for the stats throttle. */
  now?: () => number
  /**
   * Receives the stats event that the throttle held back, once the interval has passed, so the
   * last counters of a burst are never left unpublished. Without it, they ride on the next event.
   */
  onTrailing?: (event: AgentEvent) => void
  nodeCap?: number
  childrenCap?: number
  batchCap?: number
}

/** Events that are deduplicated by (type, toolUseId): a tool call has one start and one end. */
const DEDUPE_BY_TOOL_USE: ReadonlySet<string> = new Set(['tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return'])

function addBounded(set: Set<string>, value: string, max: number): void {
  if (set.size >= max) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(value)
}

/**
 * Normalizes the events of one session. `process` returns what to forward: the cleaned event
 * (or nothing, when it was dropped) and, when counters changed, a throttled `normalization_stats`
 * event. State is bounded by the NORM_* caps.
 */
export class SessionNormalizer {
  readonly stats: NormalizationStats = createStats()
  private readonly now: () => number
  private readonly nodeCap: number
  private readonly childrenCap: number
  private readonly batchCap: number
  /** Names of agents that exist (spawned or seen acting): valid parents. */
  private readonly known = new Set<string>([ORCHESTRATOR_NAME])
  /** Spawned nodes (counted against the node cap). */
  private readonly nodes = new Set<string>()
  private readonly children = new Map<string, Set<string>>()
  private readonly dropped = new Set<string>()
  private readonly seen = new Set<string>()
  private lastEmitted = JSON.stringify(createStats())
  private lastEmitAt = -Infinity
  private readonly onTrailing?: (event: AgentEvent) => void
  private trailingTimer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly sessionId?: string, opts: SessionNormalizerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.onTrailing = opts.onTrailing
    this.nodeCap = opts.nodeCap ?? NORM_MAX_NODES_PER_SESSION
    this.childrenCap = opts.childrenCap ?? NORM_MAX_CHILDREN_PER_AGENT
    this.batchCap = opts.batchCap ?? NORM_MAX_EVENTS_PER_BATCH
  }

  /** Parse a raw JSONL line with this session's counters (see {@link parseJsonLine}). */
  parseLine(line: unknown): Record<string, unknown> | undefined {
    return parseJsonLine(line, this.stats)
  }

  /** Record `n` inputs that could not be understood. */
  noteMalformed(n = 1): void { this.stats.malformed += n }

  /** Normalize one event; returns the events to forward (0, 1 or 2 with a stats event). */
  process(raw: unknown): AgentEvent[] {
    const out: AgentEvent[] = []
    const clean = this.normalize(raw)
    if (clean) out.push(clean)
    const statsEvent = this.statsEvent(false)
    if (statsEvent) out.push(statsEvent)
    else this.scheduleTrailing()
    return out
  }

  /** Normalize a batch: only the first `batchCap` events are considered, the rest are ignored. */
  processBatch(raw: unknown): AgentEvent[] {
    if (!Array.isArray(raw)) { this.stats.malformed++; const s = this.statsEvent(false); return s ? [s] : [] }
    const out: AgentEvent[] = []
    const limit = Math.min(raw.length, this.batchCap)
    for (let i = 0; i < limit; i++) {
      const clean = this.normalize(raw[i])
      if (clean) out.push(clean)
    }
    this.stats.ignoredEvents += raw.length - limit
    const statsEvent = this.statsEvent(false)
    if (statsEvent) out.push(statsEvent)
    else this.scheduleTrailing()
    return out
  }

  /** Stop the trailing timer (the session is gone). */
  dispose(): void {
    if (this.trailingTimer) { clearTimeout(this.trailingTimer); this.trailingTimer = null }
  }

  private scheduleTrailing(): void {
    if (!this.onTrailing || this.trailingTimer || JSON.stringify(this.stats) === this.lastEmitted) return
    const wait = Math.max(0, NORM_STATS_MIN_INTERVAL_MS - (this.now() - this.lastEmitAt))
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null
      const event = this.statsEvent(true)
      if (event) this.onTrailing?.(event)
    }, wait)
    this.trailingTimer.unref?.()
  }

  /** Stats event for the current counters if they changed since the last one (ignores the throttle). */
  flush(): AgentEvent | null { return this.statsEvent(true) }

  private statsEvent(force: boolean): AgentEvent | null {
    const key = JSON.stringify(this.stats)
    if (key === this.lastEmitted) return null
    const t = this.now()
    if (!force && t - this.lastEmitAt < NORM_STATS_MIN_INTERVAL_MS) return null
    this.lastEmitted = key
    this.lastEmitAt = t
    return {
      time: 0,
      type: 'normalization_stats',
      payload: { ...this.stats },
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    }
  }

  private normalize(raw: unknown): AgentEvent | null {
    const stats = this.stats
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { stats.malformed++; return null }
    const r = raw as Record<string, unknown>
    if (typeof r.type !== 'string') { stats.malformed++; return null }
    const type = oneOf(r.type, AGENT_EVENT_TYPES)
    if (!type) { stats.ignoredEvents++; return null }
    // The stats event is produced here, never accepted from a producer.
    if (type === 'normalization_stats') { stats.ignoredEvents++; return null }
    if (r.payload === null || typeof r.payload !== 'object' || Array.isArray(r.payload)) { stats.malformed++; return null }

    const payload = sanitizeValue(r.payload, stats) as Record<string, unknown>

    // time: seconds since session start; invalid => 0, absurd => clamped.
    let time = num(r.time, stats, 0, NORM_EVENT_TIME_MAX_S)
    if (time === undefined) { time = 0; if (r.time !== undefined) stats.clampedFields++ }
    const sessionId = ostr(r.sessionId, NORM_ID_MAX, stats)

    // Events of a node that was dropped by a cap are dropped with it.
    const actor = (type === 'agent_spawn' ? undefined : (stringOf(payload.agent) ?? stringOf(payload.name) ?? stringOf(payload.child)))
    if (actor !== undefined && this.dropped.has(actor)) { stats.ignoredEvents++; return null }

    if (DEDUPE_BY_TOOL_USE.has(type)) {
      const id = stringOf(payload.toolUseId)
      if (id) {
        const key = `${type}:${id}`
        if (this.seen.has(key)) { stats.duplicateEvents++; return null }
        addBounded(this.seen, key, NORM_MAX_SEEN_KEYS)
      }
    }

    if (type === 'agent_spawn' && !this.admitSpawn(payload)) return null
    // A dispatch announces its child: it counts against the same caps, so no dispatch is left
    // pointing at a spawn that the caps will drop.
    if (type === 'subagent_dispatch' && !this.admitChild(stringOf(payload.child), stringOf(payload.parent))) return null
    if (actor !== undefined && type !== 'agent_spawn' && type !== 'subagent_dispatch') this.noteAgent(actor)

    return { time, type, payload, ...(sessionId ? { sessionId } : {}) }
  }

  /** Declare an agent that demonstrably exists (it is acting), so it is a valid parent. */
  noteAgent(name: string): void {
    if (this.known.size < this.nodeCap * 2) this.known.add(name)
  }

  /** Apply the node/children caps and the orphan rule to a spawn payload (mutates it). */
  private admitSpawn(payload: Record<string, unknown>): boolean {
    const stats = this.stats
    const name = stringOf(payload.name)
    if (!name) { stats.malformed++; return false }
    if (this.dropped.has(name)) { stats.ignoredEvents++; return false }

    let parent = stringOf(payload.parent)
    if (parent !== undefined && !this.known.has(parent)) {
      // Never guess a parent: the node stays, detached.
      delete payload.parent
      payload.orphan = true
      parent = undefined
    } else if (parent === undefined && 'parent' in payload) {
      delete payload.parent
    }

    return this.admitChild(name, parent)
  }

  /**
   * Register `name` as a node under `parent` (when `parent` is a known agent), enforcing the node
   * and children caps. False = dropped by a cap (counted, and its later events are ignored).
   */
  private admitChild(name: string | undefined, parent: string | undefined): boolean {
    if (!name) return true
    const stats = this.stats
    if (parent !== undefined && !this.known.has(parent)) parent = undefined
    if (!this.nodes.has(name)) {
      const siblings = parent !== undefined ? this.children.get(parent) : undefined
      const overNodes = this.nodes.size >= this.nodeCap
      const overChildren = siblings !== undefined && !siblings.has(name) && siblings.size >= this.childrenCap
      if (overNodes || overChildren) {
        stats.droppedByCap++
        addBounded(this.dropped, name, NORM_MAX_DROPPED_NAMES)
        return false
      }
      this.nodes.add(name)
      if (parent !== undefined) {
        let set = this.children.get(parent)
        if (!set) { set = new Set(); this.children.set(parent, set) }
        set.add(name)
      }
    }
    this.noteAgent(name)
    return true
  }
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
