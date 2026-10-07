/**
 * Message protocol between VS Code extension host and webview.
 *
 * Extension → Webview: agent events, state updates, connection status
 * Webview → Extension: user commands (inject, connect/disconnect)
 */

// ─── Agent Event Types (from real agent sessions) ────────────────────────────

export type AgentEventType =
  | 'agent_spawn'
  | 'agent_complete'
  | 'agent_idle'
  | 'message'
  | 'context_update'
  | 'model_detected'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'permission_requested'
  | 'error'
  | 'agent_link'
  | 'message_sent'

/** Why two agents are linked (agent_link event) */
export type AgentLinkKind = 'teammate' | 'spawn'

/** Payload of an `agent_link` event: a communication/spawn edge between two agents. */
export interface AgentLinkPayload {
  from: string
  to: string
  kind: AgentLinkKind
  /** Stable id of the link, shared with the message_sent events travelling on it */
  linkId: string
  sessionId: string
}

/** Payload of a `message_sent` event: one message from an agent to a teammate. */
export interface MessageSentPayload {
  from: string
  to: string
  linkId: string
  /** Untrusted text: control characters stripped, capped at TEAM_MESSAGE_MAX chars */
  content: string
  toolUseId?: string
  sessionId: string
}

export interface AgentEvent {
  time: number
  type: AgentEventType
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

// ─── Extension → Webview Messages ────────────────────────────────────────────

/** Connection status shown in the UI. 'connecting' is the initial state before the first attempt
 *  (web only mirrors it; the extension may also send it while a source is being attached). */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'watching'

export type ExtensionToWebviewMessage =
  | { type: 'connection-status'; status: ConnectionStatus; source: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'agent-event-batch'; events: AgentEvent[] }
  | { type: 'reset'; reason: string }
  | { type: 'config'; config: Partial<VisualizerConfig> }
  | { type: 'session-list'; sessions: SessionInfo[] }
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-ended'; sessionId: string }
  | { type: 'session-updated'; sessionId: string; label: string }

export interface VisualizerConfig {
  mode: 'live' | 'replay'
  autoPlay: boolean
  showMockData: boolean
  disable1MContext: boolean
  /** True when Agent Lens hooks are present in ~/.claude/settings.json (or the workspace's
   *  .claude/settings.local.json). Drives the empty-state checklist. */
  hooksConfigured: boolean
}

/** Response of the relay's GET /status endpoint (small, no secrets, no paths beyond the workspace). */
export interface RelayStatus {
  relayVersion: string
  workspace: string
  /** Runtimes the relay is watching, e.g. ['claude', 'codex'] */
  runtimes: string[]
  hooksConfigured: boolean
  sessionCount: number
  allWorkspaces: boolean
}

// ─── Webview → Extension Messages ────────────────────────────────────────────

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'request-connect' }
  | { type: 'request-disconnect' }
  | { type: 'open-file'; filePath: string; line?: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

// ─── Transcript Types (from Claude Code JSONL files) ─────────────────────────

export interface TranscriptEntry {
  sessionId: string
  type: string
  uuid?: string
  message: {
    role: string
    model?: string
    content: Array<TranscriptContentBlock> | string
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  name: string
  id: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ text?: string; type?: string }>
  /** Structured error flag set by Claude Code when the tool call failed */
  is_error?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export type TranscriptContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | TextBlock
  | { type: string; [key: string]: unknown }

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/** Minimal emitter interface used by {@link emitSubagentSpawn}. */
export interface AgentEventEmitter {
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
}

/** Optional fields carried by subagent_dispatch (all backward compatible). */
export interface SubagentDispatchExtra {
  prompt?: string
  subagentType?: string
  model?: string
  /** tool_use_id of the dispatching Agent/Task call — the subagent's stable identity */
  toolUseId?: string
  /** Human-readable label (the description); the unique agent name may carry a ' #n' suffix */
  label?: string
}

/**
 * Emit the paired subagent_dispatch + agent_spawn events.
 *
 * This two-event sequence is required every time a subagent is spawned and was
 * previously duplicated in SessionWatcher and TranscriptParser.
 */
export function emitSubagentSpawn(
  emitter: AgentEventEmitter,
  parent: string,
  child: string,
  task: string,
  sessionId?: string,
  /** Optional rich dispatch data (prompt, subagentType, model, toolUseId) */
  extra?: SubagentDispatchExtra,
): void {
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'subagent_dispatch',
    payload: { parent, child, task, ...extra },
  }, sessionId)
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'agent_spawn',
    payload: {
      name: child, parent, task,
      ...(extra?.toolUseId ? { toolUseId: extra.toolUseId } : {}),
      ...(extra?.label ? { label: extra.label } : {}),
    },
  }, sessionId)
}

// ─── Shared Internal Types ───────────────────────────────────────────────────

/** A tool call that has started but not yet received its result */
export interface PendingToolCall {
  name: string
  args: string
  filePath?: string
  startTime: number
}

// ─── Session Types ──────────────────────────────────────────────────────────

export interface SubagentState {
  watcher: import('fs').FSWatcher | null
  fileSize: number
  agentName: string
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  spawnEmitted: boolean
  /** agent_id parsed from the transcript file name (agent-<id>.jsonl) */
  agentId?: string
}

/** State tracked for a single watched Claude Code session */
export interface WatchedSession {
  sessionId: string
  filePath: string
  fileWatcher: import('fs').FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  sessionStartTime: number
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
  sessionDetected: boolean
  sessionCompleted: boolean
  lastActivityTime: number
  inactivityTimer: NodeJS.Timeout | null
  subagentWatchers: Map<string, SubagentState>
  /** Names of subagents already spawned (by transcript parser or file watcher) — prevents duplicate spawns */
  spawnedSubagents: Set<string>
  /** Subagent names currently receiving inline progress events — file watcher skips these */
  inlineProgressAgents: Set<string>
  subagentsDirWatcher: import('fs').FSWatcher | null
  subagentsDir: string | null
  label: string
  labelSet: boolean
  model: string | null
  /** Maps agent names to their last emitted model ID — re-emits on model change */
  modelDetectedAgents: Map<string, string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  contextBreakdown: {
    systemPrompt: number
    userMessages: number
    toolResults: number
    reasoning: number
    subagentResults: number
  }
}

// ─── Claude Settings Types ──────────────────────────────────────────────────

export interface ClaudeHookDef {
  type?: string
  url?: string
  command?: string
  timeout?: number
}

export interface ClaudeHookEntry {
  hooks?: ClaudeHookDef[]
}

