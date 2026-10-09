/**
 * The typed "observations" action (#72): what Agent Lens currently sees, exposed to Claude itself.
 *
 * Everything returned is built field by field from a whitelist (never by copying an input object), so a
 * prompt, a message, a tool argument or a file path cannot leak by being added to an event later:
 * - sessions: id, runtime, status, timestamps, age and freshness;
 * - agents: a sanitized, unique name and a lifecycle state tracked from spawn / idle / complete / activity events.
 * Session labels (derived from prompts), cwd and workspace are deliberately NOT part of the output.
 * Counts are honest: whatever is capped or skipped is reported in `truncated` / `omittedSessions`.
 */
import type { AgentEvent, SessionInfo } from './protocol'
import {
  OBSERVATIONS_MAX_SESSIONS, OBSERVATIONS_MAX_AGENTS_PER_SESSION, OBSERVATIONS_NAME_MAX, SNAPSHOT_STALE_AFTER_MS,
} from './constants'

export const OBSERVATIONS_SCHEMA_VERSION = 1

export type ObservedFreshness = 'fresh' | 'stale' | 'closed'
export type ObservedAgentState = 'active' | 'idle' | 'complete'

export interface ObservedAgent { name: string; state: ObservedAgentState }

export interface ObservedSession {
  id: string
  runtime: 'claude' | 'codex' | 'copilot' | 'unknown'
  status: 'active' | 'completed'
  startedAt: number
  lastActivityAt: number
  ageMs: number
  freshness: ObservedFreshness
  agentCount: number
  agents?: ObservedAgent[]
  agentsTruncated?: boolean
  /** The agent list may miss agents (history dropped by the tracker): count and states are lower bounds */
  agentsIncomplete?: boolean
}

export interface Observations {
  schema: typeof OBSERVATIONS_SCHEMA_VERSION
  generatedAt: number
  sessions: ObservedSession[]
  /** Sessions beyond the cap, not listed */
  truncated: boolean
  /** Sessions left out because their id is not a plain identifier */
  omittedSessions: number
}

export interface ObservationsInput {
  /** Restrict to one session id */
  session?: string
  /** Include the per-session agent list (default true) */
  includeAgents?: boolean
}

export const OBSERVATIONS_SESSION_ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$'
const SESSION_ID_RE = new RegExp(OBSERVATIONS_SESSION_ID_PATTERN)

/** The typed action: name, description and JSON Schemas of its input and output. */
export const OBSERVATIONS_ACTION = {
  name: 'observations',
  description:
    'What Agent Lens currently observes: watched sessions (runtime, status, timestamps, freshness) and the '
    + 'lifecycle state of their agents. Read only. Never contains prompts, messages or file paths.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      session: { type: 'string', pattern: OBSERVATIONS_SESSION_ID_PATTERN, description: 'Only this session id' },
      includeAgents: { type: 'boolean', default: true, description: 'Include the agent list of each session' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'generatedAt', 'sessions', 'truncated', 'omittedSessions'],
    properties: {
      schema: { const: OBSERVATIONS_SCHEMA_VERSION },
      generatedAt: { type: 'integer', description: 'ms since epoch' },
      truncated: { type: 'boolean' },
      omittedSessions: { type: 'integer', minimum: 0 },
      sessions: {
        type: 'array',
        maxItems: OBSERVATIONS_MAX_SESSIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'runtime', 'status', 'startedAt', 'lastActivityAt', 'ageMs', 'freshness', 'agentCount'],
          properties: {
            id: { type: 'string', pattern: OBSERVATIONS_SESSION_ID_PATTERN },
            runtime: { enum: ['claude', 'codex', 'copilot', 'unknown'] },
            status: { enum: ['active', 'completed'] },
            startedAt: { type: 'integer' },
            lastActivityAt: { type: 'integer' },
            ageMs: { type: 'integer', minimum: 0, description: 'Time since the last activity' },
            freshness: { enum: ['fresh', 'stale', 'closed'] },
            agentCount: { type: 'integer', minimum: 0 },
            agentsTruncated: { type: 'boolean' },
            agentsIncomplete: { type: 'boolean' },
            agents: {
              type: 'array',
              maxItems: OBSERVATIONS_MAX_AGENTS_PER_SESSION,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'state'],
                properties: {
                  name: { type: 'string', maxLength: OBSERVATIONS_NAME_MAX },
                  state: { enum: ['active', 'idle', 'complete'] },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

/** Strict parse of the action input; unknown keys and wrong types are errors, not ignored. */
export function parseObservationsInput(raw: unknown): { ok: true; input: ObservationsInput } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, input: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'input must be an object' }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'session' && k !== 'includeAgents') return { ok: false, error: `unknown input key: ${k}` }
  const input: ObservationsInput = {}
  if (o.session !== undefined) {
    if (typeof o.session !== 'string' || !SESSION_ID_RE.test(o.session)) return { ok: false, error: 'session must match ' + OBSERVATIONS_SESSION_ID_PATTERN }
    input.session = o.session
  }
  if (o.includeAgents !== undefined) {
    if (typeof o.includeAgents !== 'boolean') return { ok: false, error: 'includeAgents must be a boolean' }
    input.includeAgents = o.includeAgents
  }
  return { ok: true, input }
}

/**
 * Agent names can be user-written (subagent descriptions): single line, capped, and replaced by a
 * placeholder when they look like a path, since paths never leave through this action.
 */
export function safeAgentName(raw: unknown): string {
  if (typeof raw !== 'string') return 'agent'
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return 'agent'
  if (/[\\/]/.test(clean) || /^[A-Za-z]:/.test(clean) || clean.startsWith('~')) return 'agent'
  return clean.slice(0, OBSERVATIONS_NAME_MAX)
}

/** Bounds of the tracker itself (it must not grow without limit either). */
const TRACKER_MAX_SESSIONS = 200
const TRACKER_MAX_AGENTS_PER_SESSION = 500
const TRACKER_MAX_LOST_SESSIONS = 1000
const TRACKER_KEY_MAX = 256

interface TrackedSession { agents: Map<string, ObservedAgentState>; overflowed: boolean }

/** What the tracker knows of one session: agents with display names, and whether that list is the whole truth. */
export interface TrackedAgents { agents: ObservedAgent[]; complete: boolean }

function trackerKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, TRACKER_KEY_MAX) : ''
}

/**
 * Agent lifecycle kept incrementally, fed with every delivered event. It is independent of the relay's
 * replay buffer, which evicts chatter (agent_idle / agent_complete included) and whole sessions: here an
 * eviction is never mistaken for "no agents" or "still active". Agents are keyed by their raw identity, so
 * two names that sanitize to the same text stay two agents; only the display is cleaned.
 * When the tracker itself has to drop something (too many sessions or agents), `complete` turns false.
 */
export class AgentStateTracker {
  private readonly sessions = new Map<string, TrackedSession>()
  private readonly lost = new Set<string>()

  ingest(e: AgentEvent): void {
    const sid = e.sessionId
    if (typeof sid !== 'string' || !sid) return
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (e.type === 'agent_spawn') {
      const t = this.session(sid)
      const key = trackerKey(p.name)
      if (!t.agents.has(key) && t.agents.size >= TRACKER_MAX_AGENTS_PER_SESSION) { t.overflowed = true; return }
      t.agents.set(key, 'active')
      return
    }
    const t = this.sessions.get(sid)
    if (!t) return
    if (e.type === 'agent_idle' || e.type === 'agent_complete') {
      const key = trackerKey(p.agent ?? p.name)
      if (t.agents.has(key)) t.agents.set(key, e.type === 'agent_idle' ? 'idle' : 'complete')
    } else if (e.type === 'agent_activity') {
      // Teammates never get agent_complete: their lifecycle is the explicit activity of the payload
      const key = trackerKey(p.name ?? p.agent)
      const next = p.activity === 'done' ? 'complete' : p.activity === 'idle' ? 'idle' : p.activity === 'working' ? 'active' : undefined
      if (next && t.agents.has(key)) t.agents.set(key, next)
    } else if (e.type === 'tool_call_start' || e.type === 'tool_call_end' || e.type === 'message') {
      // Later work of an idle agent: it is active again
      const key = trackerKey(p.agent ?? p.name)
      if (t.agents.get(key) === 'idle') t.agents.set(key, 'active')
    }
  }

  private session(sid: string): TrackedSession {
    let t = this.sessions.get(sid)
    if (t) return t
    t = { agents: new Map(), overflowed: false }
    this.sessions.set(sid, t)
    while (this.sessions.size > TRACKER_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined || oldest === sid) break
      this.sessions.delete(oldest)
      this.lost.add(oldest)
      if (this.lost.size > TRACKER_MAX_LOST_SESSIONS) this.lost.delete(this.lost.values().next().value as string)
    }
    return t
  }

  /** Agents of a session with unique display names ("name", "name#2"...). */
  get(sid: string): TrackedAgents {
    const t = this.sessions.get(sid)
    const complete = !this.lost.has(sid) && !(t?.overflowed ?? false)
    if (!t) return { agents: [], complete }
    const used = new Map<string, number>()
    const agents: ObservedAgent[] = []
    for (const [key, state] of t.agents) {
      const base = safeAgentName(key)
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      const suffix = n > 1 ? `#${n}` : ''
      agents.push({ name: base.slice(0, OBSERVATIONS_NAME_MAX - suffix.length) + suffix, state })
    }
    return { agents, complete }
  }

  clear(): void { this.sessions.clear(); this.lost.clear() }
}

export interface ObservationsSource {
  sessions: readonly SessionInfo[]
  agents: Pick<AgentStateTracker, 'get'>
}

/** Project the relay state through the whitelist. Pure. */
export function buildObservations(
  source: ObservationsSource, input: ObservationsInput = {}, now = Date.now(), staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
): Observations {
  const includeAgents = input.includeAgents !== false
  let omitted = 0
  const candidates: SessionInfo[] = []
  for (const s of source.sessions) {
    if (typeof s.id !== 'string' || !SESSION_ID_RE.test(s.id)) { omitted++; continue }
    if (input.session !== undefined && s.id !== input.session) continue
    candidates.push(s)
  }
  // Most recently active first, so the cap drops the oldest
  candidates.sort((a, b) => b.lastActivityTime - a.lastActivityTime)
  const sessions: ObservedSession[] = candidates.slice(0, OBSERVATIONS_MAX_SESSIONS).map(s => {
    const ageMs = Math.max(0, Math.trunc(now - s.lastActivityTime))
    const tracked = source.agents.get(s.id)
    const agents = tracked.agents
    const out: ObservedSession = {
      id: s.id,
      runtime: s.runtime === 'claude' || s.runtime === 'codex' || s.runtime === 'copilot' ? s.runtime : 'unknown',
      status: s.status === 'completed' ? 'completed' : 'active',
      startedAt: Math.trunc(s.startTime),
      lastActivityAt: Math.trunc(s.lastActivityTime),
      ageMs,
      freshness: s.status === 'completed' ? 'closed' : (ageMs <= staleAfterMs ? 'fresh' : 'stale'),
      agentCount: agents.length,
    }
    // The list is not the whole truth once the tracker had to drop sessions or agents: say so, don't show 0
    if (!tracked.complete) out.agentsIncomplete = true
    if (includeAgents) {
      out.agents = agents.slice(0, OBSERVATIONS_MAX_AGENTS_PER_SESSION)
      if (agents.length > OBSERVATIONS_MAX_AGENTS_PER_SESSION) out.agentsTruncated = true
    }
    return out
  })
  return {
    schema: OBSERVATIONS_SCHEMA_VERSION,
    generatedAt: Math.trunc(now),
    sessions,
    truncated: candidates.length > OBSERVATIONS_MAX_SESSIONS,
    omittedSessions: omitted,
  }
}

export type ObservationsRunResult =
  | { ok: true; result: Observations }
  | { ok: false; error: string }

export interface ObservationsAction {
  readonly definition: typeof OBSERVATIONS_ACTION
  run(rawInput?: unknown): ObservationsRunResult
  /** Stop answering; idempotent. */
  dispose(): void
  readonly disposed: boolean
}

/** The action bound to a live source of relay state. After `dispose` every call answers an error. */
export function createObservationsAction(getSource: () => ObservationsSource, now: () => number = Date.now): ObservationsAction {
  let disposed = false
  return {
    definition: OBSERVATIONS_ACTION,
    run(rawInput) {
      if (disposed) return { ok: false, error: 'observations action is shut down' }
      const parsed = parseObservationsInput(rawInput)
      if (!parsed.ok) return parsed
      try {
        return { ok: true, result: buildObservations(getSource(), parsed.input, now()) }
      } catch {
        return { ok: false, error: 'observations unavailable' }
      }
    },
    dispose() { disposed = true },
    get disposed() { return disposed },
  }
}
