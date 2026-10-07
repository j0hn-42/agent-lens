/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 * Exception: ConnectionStatus adds the web-only 'connecting' value (initial state
 * before the relay answers); the extension never sends it.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Agent runtime of the session, when the extension reports it */
  runtime?: 'claude' | 'codex'
  /** Workspace name/path of the session, when known */
  workspace?: string
  /** Working directory of the session, when known */
  cwd?: string
  /** Agent Team this session belongs to (tmux teammate sessions), when known */
  teamName?: string
  /** Teammate name inside the team, when the session is a team member */
  memberName?: string
}

/** Pseudo session id of the 'All' tab: union of every session (never sent to or by the extension). */
export const ALL_SESSIONS_ID = '__all__'

/** Prefix of the pseudo session ids that select one whole Agent Team ('team:<name>'). */
export const TEAM_SELECTION_PREFIX = 'team:'

/** Pseudo session id selecting the union of a team's sessions (never sent to or by the extension). */
export function teamSelectionId(teamName: string): string {
  return `${TEAM_SELECTION_PREFIX}${teamName}`
}

/** Team name when `id` is a team pseudo selection, else null. */
export function parseTeamSelection(id: string | null | undefined): string | null {
  return typeof id === 'string' && id.startsWith(TEAM_SELECTION_PREFIX) && id.length > TEAM_SELECTION_PREFIX.length
    ? id.slice(TEAM_SELECTION_PREFIX.length)
    : null
}

/** True for the 'All' tab and for team pseudo selections: views that union several sessions. */
export function isUnionSelection(id: string | null | undefined): boolean {
  return id === ALL_SESSIONS_ID || parseTeamSelection(id) !== null
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching' | 'connecting'

/** Non-blocking user-facing notice raised by the bridge (parse failure, reset, relay state). */
export interface BridgeNotice {
  id: number
  kind: 'parse-error' | 'reset' | 'relay-down' | 'relay-up'
  message: string
}

// ─── Runtime validation (messages are untrusted: relay, hooks and window.postMessage) ───

const CONNECTION_STATUSES: readonly string[] = ['connected', 'disconnected', 'watching', 'connecting']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isAgentEvent(v: unknown): v is AgentEvent {
  return isRecord(v)
    && typeof v.time === 'number' && Number.isFinite(v.time)
    && typeof v.type === 'string'
    && isRecord(v.payload)
    && (v.sessionId === undefined || typeof v.sessionId === 'string')
}

export function isSessionInfo(v: unknown): v is SessionInfo {
  return isRecord(v)
    && typeof v.id === 'string'
    && typeof v.label === 'string'
    && (v.status === 'active' || v.status === 'completed')
    && typeof v.startTime === 'number'
    && typeof v.lastActivityTime === 'number'
    && (v.runtime === undefined || v.runtime === 'claude' || v.runtime === 'codex')
    && (v.workspace === undefined || typeof v.workspace === 'string')
    && (v.cwd === undefined || typeof v.cwd === 'string')
    && (v.teamName === undefined || typeof v.teamName === 'string')
    && (v.memberName === undefined || typeof v.memberName === 'string')
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Max length of a team / member name (same as the team tracker) */
export const MAX_NAME_LEN = 80

/** Untrusted single-line text: control characters removed, trimmed, capped. */
export function cleanLine(v: unknown, max = MAX_NAME_LEN): string {
  if (typeof v !== 'string') return ''
  return v.replace(CONTROL_CHARS, '').trim().slice(0, max)
}

/**
 * SessionInfo with its team fields sanitised exactly like the team tracker does (so team tab ids,
 * cluster keys and tracker names agree); an empty result drops the field.
 */
export function sanitizeSessionInfo(s: SessionInfo): SessionInfo {
  const { teamName, memberName, ...rest } = s
  const team = cleanLine(teamName)
  const member = cleanLine(memberName)
  return { ...rest, ...(team ? { teamName: team } : {}), ...(member ? { memberName: member } : {}) }
}

export function isConnectionStatus(v: unknown): v is ConnectionStatus {
  return typeof v === 'string' && CONNECTION_STATUSES.includes(v)
}
