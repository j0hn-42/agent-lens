/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
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
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching' | 'connecting'

/** Non-blocking user-facing notice raised by the bridge (parse failure, reset, relay state). */
export interface BridgeNotice {
  id: number
  kind: 'parse-error' | 'reset' | 'relay-down' | 'relay-up'
  message: string
}
