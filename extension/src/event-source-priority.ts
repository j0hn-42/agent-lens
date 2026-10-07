/**
 * Reconciliation of the two event sources: Claude Code hooks (live, pushed over HTTP)
 * and the JSONL transcript (read from disk, history + tail).
 *
 * Both sources describe the same activity, so their streams overlap. Principle (epic #73):
 * never show an event twice and never lose one; when the sources disagree, one of them is
 * authoritative for the kind of fact at stake.
 *
 * WHICH SOURCE WINS ON CONTRADICTION (see resolveConflict, table EVENT_SOURCE_PRIORITY)
 *  - JSONL is authoritative for CONTENT and ORDERING: messages, tool calls and their results,
 *    token/context numbers, model, subagent identity and names. The transcript is the durable
 *    record and has the real names/ids; hook copies are summaries.
 *  - HOOKS are authoritative for PERMISSION PROMPTS and LIVENESS: `permission_requested`,
 *    `agent_idle`, `agent_complete`. Only Claude Code itself knows a prompt is on screen or that
 *    a session stopped; the transcript can only guess from silence.
 *  - Two events from the SAME source never conflict: both are kept (a repeat is real activity).
 *
 * HOW THE RECONCILER WORKS (EventReconciler)
 *  1. The live flow is subscribed BEFORE history is loaded.
 *  2. While history loads (`withHistory`), every event is held instead of delivered.
 *  3. When the load ends the held events are replayed in order; an event whose derived id
 *     (deriveEventId) matches an event of the OTHER source collapses with it, the winner being
 *     chosen by resolveConflict and placed at the position of the first one.
 *  4. Delivered ids are remembered (bounded) so a copy that arrives later from the other
 *     source (a late JSONL line, a late hook) is dropped; what was delivered cannot be retracted,
 *     so for late arrivals the first delivery stands.
 */
import * as crypto from 'crypto'
import type { AgentEvent, AgentEventType } from './protocol'
import {
  EVENT_ID_TIME_BUCKET_S, EVENT_ID_HASH_INPUT_MAX, EVENT_ID_EXPLICIT_MAX,
  EVENT_DEDUP_MAX_PER_SESSION, EVENT_DEDUP_MAX_SESSIONS, EVENT_HOLD_MAX,
} from './constants'

export type EventSource = 'jsonl' | 'hook'

export interface SourcedEvent {
  event: AgentEvent
  source: EventSource
}

/** Source that wins when both describe the same event; types absent from the table use DEFAULT_PRIORITY. */
export const DEFAULT_PRIORITY: EventSource = 'jsonl'
export const EVENT_SOURCE_PRIORITY: Readonly<Partial<Record<AgentEventType, EventSource>>> = {
  permission_requested: 'hook',
  agent_idle: 'hook',
  agent_complete: 'hook',
}

/** Pure: the winner of two descriptions of the same event. Ties (same source) keep `a`. */
export function resolveConflict(a: SourcedEvent, b: SourcedEvent): SourcedEvent {
  if (a.source === b.source) return a
  const authority = EVENT_SOURCE_PRIORITY[a.event.type] ?? DEFAULT_PRIORITY
  return b.source === authority ? b : a
}

/** Lifecycle-like types whose identity is (session, type, agent) within a time bucket. */
const AGENT_KEYED_TYPES = new Set<AgentEventType>([
  'agent_spawn', 'agent_complete', 'agent_idle', 'subagent_dispatch', 'subagent_return', 'permission_requested', 'model_detected',
])

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function contentHash(payload: unknown): string {
  let text = ''
  try { text = (JSON.stringify(payload) ?? '').slice(0, EVENT_ID_HASH_INPUT_MAX) } catch { /* unserialisable: empty */ }
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Stable id of an event, identical for the hook copy and the JSONL copy of the same fact.
 *  - explicit `payload.eventId`/`payload.id` (bounded string) wins;
 *  - else a tool_use_id (unique per tool call): session + type + tool_use_id (no time needed);
 *  - else lifecycle types: session + type + agent + time bucket;
 *  - else (free text, numbers): session + type + content hash, so only an exact repeat matches
 *    and two distinct messages are never merged.
 */
export function deriveEventId(event: AgentEvent, bucketS = EVENT_ID_TIME_BUCKET_S): string {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const sid = event.sessionId ?? ''
  const explicit = str(p.eventId) ?? str(p.id)
  if (explicit && explicit.length <= EVENT_ID_EXPLICIT_MAX) return `${sid}|id|${explicit}`
  const toolUseId = str(p.toolUseId) ?? str(p.tool_use_id)
  if (toolUseId) return `${sid}|${event.type}|${toolUseId}`
  if (AGENT_KEYED_TYPES.has(event.type)) {
    const agent = str(p.agent) ?? str(p.name) ?? str(p.child) ?? ''
    const t = Number.isFinite(event.time) ? event.time : 0
    return `${sid}|${event.type}|${agent}|${Math.floor(t / bucketS)}`
  }
  return `${sid}|${event.type}|h:${contentHash(event.payload)}`
}

export interface ReconcilerOptions {
  /** Receives every event that survives deduplication, in order, with the source of the surviving copy. */
  deliver: (event: AgentEvent, source: EventSource) => void
  maxPerSession?: number
  maxSessions?: number
  maxHeld?: number
}

export interface SubmitOptions {
  source: EventSource
}

export class EventReconciler {
  private readonly deliverFn: (event: AgentEvent, source: EventSource) => void
  private readonly maxPerSession: number
  private readonly maxSessions: number
  private readonly maxHeld: number
  private loading = 0
  private held: SourcedEvent[] = []
  /** session -> (id -> source of the delivered copy), insertion-ordered for bounded eviction */
  private readonly delivered = new Map<string, Map<string, EventSource>>()

  constructor(opts: ReconcilerOptions) {
    this.deliverFn = opts.deliver
    this.maxPerSession = opts.maxPerSession ?? EVENT_DEDUP_MAX_PER_SESSION
    this.maxSessions = opts.maxSessions ?? EVENT_DEDUP_MAX_SESSIONS
    this.maxHeld = opts.maxHeld ?? EVENT_HOLD_MAX
  }

  /** Number of events currently held (history load in progress). */
  get heldCount(): number { return this.held.length }
  get isLoading(): boolean { return this.loading > 0 }
  /** Number of sessions whose delivered ids are remembered (diagnostics and tests). */
  get rememberedSessions(): number { return this.delivered.size }

  /** Submit one event from a source. Delivered now, or held while history loads. */
  submit(event: AgentEvent, opts: SubmitOptions): void {
    const sourced: SourcedEvent = { event, source: opts.source }
    if (this.loading > 0) {
      this.held.push(sourced)
      if (this.held.length >= this.maxHeld) this.flush()
      return
    }
    this.process([sourced])
  }

  /**
   * Run a history load. Events submitted meanwhile (the history's own and the live ones) are held
   * and replayed, deduplicated, when the outermost load ends, also when `load` throws.
   */
  withHistory<T>(load: () => T): T {
    this.loading++
    try {
      return load()
    } finally {
      this.loading--
      if (this.loading === 0) this.flush()
    }
  }

  /** Forget what was delivered for a session (it was unwatched). */
  forgetSession(sessionId: string): void { this.delivered.delete(sessionId) }

  clear(): void { this.held = []; this.delivered.clear() }

  private flush(): void {
    const batch = this.held
    this.held = []
    this.process(batch)
  }

  /** Collapse cross-source duplicates inside the batch, drop copies already delivered, deliver the rest. */
  private process(batch: SourcedEvent[]): void {
    const out: SourcedEvent[] = []
    const index = new Map<string, number>()
    for (const item of batch) {
      const id = deriveEventId(item.event)
      const at = index.get(id)
      if (at !== undefined && out[at].source !== item.source) {
        out[at] = resolveConflict(out[at], item)
        continue
      }
      // Same-source repeats are real activity: kept (index keeps pointing at the first copy)
      if (at === undefined) index.set(id, out.length)
      out.push(item)
    }
    for (const item of out) {
      if (this.alreadyDelivered(item)) continue
      this.remember(item)
      this.deliverFn(item.event, item.source)
    }
  }

  private alreadyDelivered(item: SourcedEvent): boolean {
    const sid = item.event.sessionId ?? ''
    const src = this.delivered.get(sid)?.get(deriveEventId(item.event))
    return src !== undefined && src !== item.source
  }

  private remember(item: SourcedEvent): void {
    const sid = item.event.sessionId ?? ''
    let ids = this.delivered.get(sid)
    if (!ids) {
      ids = new Map()
      this.delivered.set(sid, ids)
      while (this.delivered.size > this.maxSessions) {
        const oldest = this.delivered.keys().next().value
        if (oldest === undefined || oldest === sid) break
        this.delivered.delete(oldest)
      }
    }
    // alreadyDelivered() has dropped any copy of a different source, so an id seen here is either new
    // or a same-source repeat: recording the source of this copy never changes a remembered source.
    ids.set(deriveEventId(item.event), item.source)
    while (ids.size > this.maxPerSession) {
      const oldest = ids.keys().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
  }
}
