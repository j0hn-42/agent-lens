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
  | 'team_info'
  | 'agent_activity'
  | 'normalization_stats'
  | 'context_compacted'

/** The files a Glob's structured result proves it listed (#451), as `tool_call_end` carries them in `listing` */
export interface SearchListingPayload {
  /** The first files of the list, in the tool's order (at most SEARCH_LISTING_MAX_FILES) */
  files: string[]
  /** The number of files the tool returned, equal to the length of the list it returned */
  count: number
}

/** Payload of `tool_call_end`: the fields below are optional and added only when proven (the rest is untyped) */
export interface ToolCallEndPayload {
  agent: string
  tool: string
  result: string
  toolUseId?: string
  /** Present only on a successful Glob whose structured result is whole and consistent (#451) */
  listing?: SearchListingPayload
}

/** Payload of `context_compacted` (#232): only what the transcript proves; an unproven field is absent. */
export interface ContextCompactedPayload {
  agent: string
  /** Claude Code's compactMetadata.trigger, kept only when 'auto' or 'manual' */
  trigger?: 'auto' | 'manual'
  /** Claude Code's compactMetadata.preTokens: context size before the compaction, a positive safe integer */
  preTokens?: number
}

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
  /** 'inbox' when the message was read from ~/.claude/teams/<team>/inboxes (absent for transcript sources) */
  source?: 'inbox'
  sessionId: string
}

/** Kind of an agent node. 'teammate' = a member of a Claude Code Agent Team. */
export type AgentKind = 'main' | 'subagent' | 'teammate'

/** What a teammate is doing right now. Idle teammates stay on screen. */
export type AgentActivity = 'working' | 'idle' | 'done'

/** 'team' = Claude Code Agent Team (default); 'workflow' = one Workflow tool run (#79). */
export type TeamKind = 'team' | 'workflow'

/** Extra fields an `agent_spawn` payload carries for teammates (all optional, untrusted strings). */
export interface TeammateSpawnExtras {
  kind: 'teammate'
  teamName: string
  /** Group flavour; absent = 'team' */
  teamKind?: TeamKind
  /** Team color as '#rrggbb' only; anything else must be dropped by the consumer */
  color?: string
  /** Role reported by the team config (e.g. 'general-purpose', 'team-lead') */
  agentType?: string
  backendType?: 'in-process' | 'tmux' | string
  /** Session the teammate runs in, when it is a separate session (tmux backend) */
  memberSessionId?: string
}

/** Payload of `agent_activity`: a teammate went idle / back to work / finished. */
export interface AgentActivityPayload {
  name: string
  activity: AgentActivity
}

/** Payload of `team_info`: one Agent Team as read from ~/.claude/teams/<team>/config.json. */
export interface TeamInfoPayload {
  teamName: string
  /** Group flavour; absent = 'team' */
  teamKind?: TeamKind
  leadSessionId: string
  leadName?: string
  members: Array<{
    name: string
    agentType?: string
    color?: string
    backendType?: string
    /** Session id when the member is a separate session */
    sessionId?: string
    joinedAt?: number
    /** Workflow groups only: phase label of the agent (capped at 40 chars) */
    phase?: string
  }>
}

/**
 * Counters of what the input normalizer discarded or altered for one session. Carried as the
 * payload of the `normalization_stats` event; a counter is only incremented for something that
 * really happened, so a non-zero value proves that data was left out.
 */
export interface NormalizationStats {
  /** Well-formed events discarded in whole (unsupported type, event of a dropped node, events past the batch cap) */
  ignoredEvents: number
  /** Fields altered in place: text truncated or stripped of control characters, number or timestamp clamped, forbidden key removed */
  clampedFields: number
  /** Nodes (agent spawns) dropped because the per-session node cap or the per-agent children cap was reached */
  droppedByCap: number
  /** Lines or events that could not be understood (invalid JSON, not an object, oversized line, invalid shape) */
  malformed: number
  /** Exact repeats of an already-seen event (harmless: they never truncate the graph) */
  duplicateEvents: number
  /**
   * Updates the source holds but the reader did not read (an OpenCode row changed after the reader
   * stopped following it, #420): the graph may show an older state. A lower bound.
   */
  missedUpdates: number
}

export interface AgentEvent {
  time: number
  type: AgentEventType
  payload: Record<string, unknown>
  sessionId?: string
  /** Event of an imported transcript (#294): read from a file, never seen live */
  imported?: boolean
  /** Event read from a transcript history (attach catch-up, import), not seen live: its wall-clock timing is unknown (#361) */
  replayed?: boolean
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** True when lastActivityTime only stands for the start: usable to sort, never to display */
  lastActivityUnknown?: boolean
  /** Start of the session as its transcript records it; `startTime` stays the origin of the event times */
  recordedStartTime?: number
  /** True when no start is recorded and `startTime` is only when watching began: a duration from it is a lower bound */
  startTimeWatched?: boolean
  /** Agent Team the session belongs to (lead or tmux member), when known */
  teamName?: string
  /** Team member name when the session is a separate teammate session (or the lead's name) */
  memberName?: string
  /** 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode' */
  runtime?: string
  /** Workspace root the session was discovered for (untrusted, capped) */
  workspace?: string
  /** Working directory read from the transcript (untrusted, capped) */
  cwd?: string
  /** Session that launched this one (Task), when the source declares it (untrusted, capped) */
  parentSessionId?: string
  /** Listed only from the read-only session index: not watched live, so it has no events to replay and is never auto-selected */
  indexedOnly?: boolean
  /** Read once from an imported transcript (#294, --import / AGENT_LENS_IMPORT): not observed live, never 'active' */
  imported?: boolean
  /** When the relay read the imported transcript (ms since epoch) */
  importedAt?: number
  /** Hash of the repository's git common dir: shared by all worktrees of a repo; absent outside git */
  projectId?: string
  /** Folder name of the repository's main checkout, shown as the group title (untrusted, capped) */
  projectName?: string
  /** Git branch recorded at the head of the session transcript (untrusted, capped); absent when unrecorded or detached */
  branch?: string
}

// ─── Extension → Webview Messages ────────────────────────────────────────────

/** Connection status shown in the UI. 'connecting' is the initial state before the first attempt
 *  (web only mirrors it; the extension may also send it while a source is being attached). */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'watching'

export type ExtensionToWebviewMessage =
  | { type: 'connection-status'; status: ConnectionStatus; source: string }
  /** `seq` (relay only, #366): the number of the event for this relay process, see `relay-cursor` */
  | { type: 'agent-event'; event: AgentEvent; seq?: number }
  | { type: 'agent-event-batch'; events: AgentEvent[] }
  | { type: 'reset'; reason: string }
  /** Sent by the relay once per /events connection, before the replay (#366). `evicted`: per session, events the
   *  relay can no longer replay (buffer or replay cap), totals since the relay started: REPLACE the previous value,
   *  never add. It says what the replay lacks, not what this client missed: a client that stayed connected got them live.
   *  `otherEvents`: the same count for sessions no longer listed individually. Absent when nothing was lost.
   *  `gap`: only for a client back with `?since=` from this relay process, per session, the events numbered after
   *  `since` that it will never receive (evicted, or left out by this replay's cap): a lower bound, to ADD to what the
   *  client already knows it lacks.
   *  The VS Code extension (no relay, #592) sends it after `reset` and the agents it re-sends: per session, the events
   *  emitted before that page was ready that it will never receive (see panel-loss.ts); then again, lower (REPLACE),
   *  while that page is open, each time a session's history read again reaches it. Never `otherEvents` (sessions past
   *  its cap are dropped from the figure) and no `gap`: a page lives as long as its panel, there is no cut link to resume. */
  | { type: 'event-loss'; evicted: Record<string, number>; otherEvents?: number; gap?: Record<string, number> }
  /** Relay only, once per /events connection after `event-loss` and before the replay (#366): the relay process and
   *  the number of the last event it delivered. A client sends it back as `?since=<instance>.<seq>` when it reconnects,
   *  updated with the `seq` of each live `agent-event` it receives. */
  | { type: 'relay-cursor'; instance: string; seq: number }
  | { type: 'config'; config: Partial<VisualizerConfig> }
  | { type: 'session-list'; sessions: SessionInfo[] }
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-ended'; sessionId: string }
  /** A label, team or place learnt after the start; `cwd`, `projectId`/`projectName` (both or none) and `branch` when the
   *  transcript gave them late (its head held no cwd when the session was found) */
  | { type: 'session-updated'; sessionId: string; label: string; teamName?: string; memberName?: string; cwd?: string; projectId?: string; projectName?: string; branch?: string }
  /** Operator control (#240), sent only to a panel that sent `permission-surface` ready: a PermissionRequest waits for a decision */
  | { type: 'permission-request'; request: PermissionRequestMessage }
  /** The request ended: `sent` = the decision was handed to Claude Code (not proof it was applied); the others had no decision */
  | { type: 'permission-closed'; nonce: string; sessionId: string; toolUseId: string | null; outcome: string }
  /** Answer to a `permission-decision`: accepted, or why not */
  | { type: 'permission-result'; nonce: string | null; ok: boolean; reason?: string }

/** A waiting PermissionRequest, as the panel is shown it (the decision must name sessionId, toolUseId and nonce) */
export interface PermissionRequestMessage {
  sessionId: string
  /** null when the hook input does not name the call and no single open call of the session matches */
  toolUseId: string | null
  nonce: string
  toolName: string
  /** Tool input as JSON text with sorted keys, cut at 64 KiB */
  inputPreview: string
  inputTruncated: boolean
  /** SHA-256 of the whole input */
  inputSha256: string
  requestedAt: number
  expiresAt: number
}

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
/** Life cycle of an agent launched from the relay (#229). Each state is set only when its fact was observed. */
export type LaunchState = 'requested' | 'started' | 'session' | 'exited' | 'stopped' | 'expired' | 'failed'

/** What the relay tells local clients about a launch (SSE `launch`, GET /status): facts only, never the command line, the output or the issue text. */
export interface LaunchView {
  id: string
  repo: string
  issue: number
  role: string
  /** `--worktree` name, also the branch name */
  worktree: string
  /** The --session-id chosen by the relay: the key that proves launch <-> session */
  sessionId: string
  state: LaunchState
  /** Present once the spawn was observed */
  pid?: number
  requestedAt: number
  startedAt?: number
  sessionSeenAt?: number
  /** A stop was asked for (or the deadline came); the end is only known from the exit */
  stopRequestedAt?: number
  stopReason?: 'stop' | 'expired' | 'relay-stopped'
  endedAt?: number
  exitCode?: number
  signal?: string
  /** Bounded code: ENOENT, EACCES..., 'spawn-error', 'exit-before-start' */
  failure?: string
  /** Absolute path of the worktree, only when it exists after the end (the work is kept there) */
  worktreePath?: string
  outputBytes: number
  outputDroppedBytes: number
}

export interface RelayStatus {
  relayVersion: string
  workspace: string
  /** Runtimes the relay is watching, e.g. ['claude', 'codex'] */
  runtimes: string[]
  hooksConfigured: boolean
  /** CLAUDE_CODE_DISABLE_1M_CONTEXT=1 in the relay's environment or Claude Code settings (#249); false when Claude Code is not watched */
  disable1MContext: boolean
  sessionCount: number
  /** Claude sessions not followed (#208, #291): watch limit reached when found, transcript past the size cap (at discovery
   *  or after growing), transcript past the per-folder cap. Distinct sessions of the current scope, bounded: read as "at least". */
  skippedSessions: { watchLimit: number; sizeLimit: number; fileLimit: number }
  /** What the scan covers RIGHT NOW (#291): false = the workspace folder only, true = every project folder. Changed by POST /scope. */
  allWorkspaces: boolean
  /** Discovery ceilings (#291): `projectDirsCapped` = more project folders exist than maxProjectDirs, the others are not scanned */
  discovery: { projectDirsCapped: boolean; maxProjectDirs: number; maxFilesPerDir: number }
  /** Watched runtimes that cannot be read right now, with the reason (#420), e.g. the OpenCode database not found.
   *  Present only when there is one; the message never carries a file path. */
  runtimeProblems?: Array<{ runtime: string; message: string }>
  /** Losses of a watched runtime that no followed session counts in its normalization_stats (#420): unreadable rows and
   *  row changes not read, in sessions not followed at the time. Lower bounds. Present only when one is above 0. */
  runtimeLosses?: Array<{ runtime: string; unreadableRows: number; missedUpdates: number }>
  /** Optional session index (#66): present only when one is configured */
  sessionIndex?: { status: 'ok' | 'degraded' | 'unavailable'; count: number; truncated: boolean; message?: string }
  /** Agent launches (#229): present only when the relay was started with --allow-launch, and never for a tunnel Host */
  launch?: { maxConcurrent: number; launches: LaunchView[] }
}

// ─── Webview → Extension Messages ────────────────────────────────────────────

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'request-connect' }
  | { type: 'request-disconnect' }
  | { type: 'open-file'; filePath: string; line?: number }
  /** Open a terminal in the working directory of a session (#240): the webview names the session, never a directory */
  | { type: 'open-terminal'; sessionId: string }
  /** The page can show and answer permission requests (#240); sent again with ready:false when it can no longer */
  | { type: 'permission-surface'; ready: boolean }
  /** The operator's decision for one waiting request (#240); a redirect carries its text */
  | { type: 'permission-decision'; sessionId: string; toolUseId: string | null; nonce: string; action: 'approve' | 'deny' | 'redirect'; message?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Native notification asked for by a rule of the webview (#225); validated by parseNotifyMessage */
  | { type: 'notify'; trigger: string; title: string; body: string }

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
  /** Text, content blocks, or a structured object (summarizeResult reads its text fields) */
  content: string | Array<{ text?: string; type?: string }> | Record<string, unknown>
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
  /** Extra agent_spawn payload fields (teammate extras, model) */
  spawnExtras?: Record<string, unknown>,
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
      // What the dispatching call asked for; the UI ranks it below configured and runtime models (#60)
      ...(extra?.model ? { requestedModel: extra.model } : {}),
      // The role behind the agent:<role> issue labels (#63)
      ...(extra?.subagentType ? { subagentType: extra.subagentType } : {}),
      ...(spawnExtras ?? {}),
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
  /** fs.watch failed (ENOSPC/EMFILE): the watch is not tried again at every read, the poll reads the file */
  watchFailed?: boolean
  fileSize: number
  /** Fragment de ligne non terminée de la lecture précédente (voir readTrackedLines) */
  fileTail: string
  agentName: string
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  spawnEmitted: boolean
  /** When the file was last written as far as we know (mtime at start, then the last read with new bytes): idle subagents lose their watcher (#654) */
  lastWriteMs?: number
  /** Its dispatch was read from the history at attach and shows no end: its spawn is still owed (#446) */
  catchUpSpawn?: boolean
  /** agent_id parsed from the transcript file name (agent-<id>.jsonl) */
  agentId?: string
  /** Set for in-process Agent Team teammates (see teammate.ts) */
  teammate?: import('./teammate').TeammateRuntime
}

/** State tracked for a single watched Claude Code session */
export interface WatchedSession {
  sessionId: string
  filePath: string
  fileWatcher: import('fs').FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  /** Fragment de ligne non terminée de la lecture précédente (voir readTrackedLines) */
  fileTail: string
  /** When watching began: the origin of the event times (`time`, seconds), not the start of the session */
  sessionStartTime: number
  /** Start of the session as its transcript records it (first timestamped entry); absent when none is recorded */
  recordedStartTime?: number
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
  sessionDetected: boolean
  /** The end of the session was observed (SessionEnd hook). A silence never sets it (#360) */
  sessionCompleted: boolean
  lastActivityTime: number
  subagentWatchers: Map<string, SubagentState>
  /** Names of subagents already spawned (by transcript parser or file watcher) — prevents duplicate spawns */
  spawnedSubagents: Set<string>
  /** agent_spawn emitted at attach for subagents launched in the history (#446), bounded by SUBAGENT_CATCH_UP_SPAWNS_MAX */
  catchUpSpawns?: number
  /** Subagent names currently receiving inline progress events — file watcher skips these */
  inlineProgressAgents: Set<string>
  subagentsDirWatcher: import('fs').FSWatcher | null
  subagentsDir: string | null
  label: string
  labelSet: boolean
  /** Rank of the session title the label came from (see SESSION_TITLE_RANK); unset = first prompt */
  titleRank?: number
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

