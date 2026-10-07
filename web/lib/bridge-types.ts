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
}

/** Pseudo session id of the 'All' tab: union of every session (never sent to or by the extension). */
export const ALL_SESSIONS_ID = '__all__'

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
}

export function isConnectionStatus(v: unknown): v is ConnectionStatus {
  return typeof v === 'string' && CONNECTION_STATUSES.includes(v)
}
