/**
 * The typed "observations" action (#72): what Agent Lens currently sees, exposed to Claude itself.
 *
 * Everything returned is built field by field from a whitelist (never by copying an input object), so a
 * prompt, a message, a tool argument or a file path cannot leak by being added to an event later:
 * - sessions: id, runtime, status, timestamps, age and freshness;
 * - agents: a sanitized name and a lifecycle state derived from spawn / idle / complete events.
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
  runtime: 'claude' | 'codex' | 'unknown'
  status: 'active' | 'completed'
  startedAt: number
  lastActivityAt: number
  ageMs: number
  freshness: ObservedFreshness
  agentCount: number
  agents?: ObservedAgent[]
  agentsTruncated?: boolean
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
            runtime: { enum: ['claude', 'codex', 'unknown'] },
            status: { enum: ['active', 'completed'] },
            startedAt: { type: 'integer' },
            lastActivityAt: { type: 'integer' },
            ageMs: { type: 'integer', minimum: 0, description: 'Time since the last activity' },
            freshness: { enum: ['fresh', 'stale', 'closed'] },
            agentCount: { type: 'integer', minimum: 0 },
            agentsTruncated: { type: 'boolean' },
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

/** Lifecycle of each agent of a session, from its buffered events (insertion order = first seen). */
function agentsOf(events: readonly AgentEvent[]): ObservedAgent[] {
  const states = new Map<string, ObservedAgentState>()
  for (const e of events) {
    const p = e.payload ?? {}
    if (e.type === 'agent_spawn') {
      states.set(safeAgentName(p.name), 'active')
    } else if (e.type === 'agent_idle' || e.type === 'agent_complete') {
      const name = safeAgentName(p.agent ?? p.name)
      if (states.has(name)) states.set(name, e.type === 'agent_idle' ? 'idle' : 'complete')
    }
  }
  return [...states].map(([name, state]) => ({ name, state }))
}

export interface ObservationsSource {
  sessions: readonly SessionInfo[]
  events: ReadonlyMap<string, readonly AgentEvent[]>
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
    const agents = agentsOf(source.events.get(s.id) ?? [])
    const out: ObservedSession = {
      id: s.id,
      runtime: s.runtime === 'claude' || s.runtime === 'codex' ? s.runtime : 'unknown',
      status: s.status === 'completed' ? 'completed' : 'active',
      startedAt: Math.trunc(s.startTime),
      lastActivityAt: Math.trunc(s.lastActivityTime),
      ageMs,
      freshness: s.status === 'completed' ? 'closed' : (ageMs <= staleAfterMs ? 'fresh' : 'stale'),
      agentCount: agents.length,
    }
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
