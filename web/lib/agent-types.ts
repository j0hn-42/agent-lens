// Agent Visualizer Types — Holographic Edition v2
// Now with actual information visibility

export type AgentState = 'idle' | 'thinking' | 'tool_calling' | 'complete' | 'error' | 'paused' | 'waiting_permission'

// Context window composition — the key insight
export interface ContextBreakdown {
  systemPrompt: number   // fixed cost, always there
  userMessages: number   // user input
  toolResults: number    // the expensive ones — file contents, search results
  reasoning: number      // the agent's own thinking
  subagentResults: number // results from child agents
}

export interface Agent {
  /** Unique key across sessions: equals `agentKey` (sessionId + ':' + localId). Maps and edges use it. */
  id: string
  /** Same value as `id`; explicit name for code that talks about cross-session identity */
  agentKey: string
  /** Session this agent belongs to ('default' for events without a session id) */
  sessionId: string
  /** Human-readable session label (set by the app for the feed's session chip) */
  sessionLabel?: string
  /** Name the event stream uses for this agent inside its session (unique per session) */
  localId: string
  /** Label shown in the UI (description of a sub-agent, first prompt of a main agent) */
  displayName: string
  /** Display label; kept equal to `displayName` for existing consumers */
  name: string
  /** agentKey of the real parent (null for a root agent); kept equal to `parentId` */
  parentKey: string | null
  /** tool_use_id of the dispatching Agent/Task call, when the agent is a sub-agent */
  toolUseId?: string
  state: AgentState
  /** 'main' | 'subagent' | 'teammate' (Agent Team member). Defaults from isMain/parent when absent. */
  kind?: 'main' | 'subagent' | 'teammate'
  /** Agent Team the agent belongs to */
  teamName?: string
  /** Layout cluster: team name when the agent belongs to a team, else its session id */
  clusterKey?: string
  /** Team color, validated '#rrggbb' only */
  teamColor?: string
  /** Role reported by the team config (e.g. 'general-purpose'), for teammates */
  agentType?: string
  /** Teammate backend ('in-process' | 'tmux' | ...) */
  backend?: string
  /** Teammate activity; idle teammates stay visible */
  activity?: 'working' | 'idle' | 'done'
  /** Finished agents kept on screen (reduced, dashed) so their conversation stays reachable */
  archived?: boolean
  parentId: string | null
  tokensUsed: number
  tokensMax: number
  contextBreakdown: ContextBreakdown
  toolCalls: number
  timeAlive: number
  x: number
  y: number
  vx: number
  vy: number
  pinned: boolean
  isMain: boolean
  /** Which agent runtime produced this agent — used to pick the brand logo.
   *  Optional for forward compat with events that don't carry it (defaults to 'claude'). */
  runtime?: 'claude' | 'codex'
  /** Model ID last reported for this agent (agent_spawn / model_detected).
   *  Drives context-window sizing and the per-family cost rate. */
  model?: string
  currentTool?: string
  task?: string
  spawnTime: number
  completeTime?: number
  opacity: number
  scale: number
  /** Queued text bubbles shown on canvas — newest pushed to end */
  messageBubbles: MessageBubble[]
}

export interface MessageBubble {
  text: string
  time: number
  role: 'assistant' | 'thinking' | 'user'
  /** Cached bubble dimensions (set during draw, used by hit-detection) */
  _cachedW?: number
  _cachedH?: number
  _cachedLines?: number
  /** Cached word-wrapped lines (avoids re-wrapping every frame) */
  _cachedWrappedLines?: string[]
  _cachedWrappedFont?: string
}

// Rich tool call with actual content
export interface ToolCallNode {
  id: string
  agentId: string
  toolName: string
  /** Set when toolName is an MCP tool (`mcp__<server>__<tool>`) */
  mcp?: { server: string; tool: string }
  state: 'running' | 'complete' | 'error'
  args: string          // human-readable argument summary
  result?: string       // human-readable result summary
  tokenCost?: number    // how many tokens this result consumed
  inputData?: Record<string, unknown>  // rich tool input (diffs, todos, commands)
  /** tool_use_id from the transcript/hook — correlates start/end and dispatch/return */
  toolUseId?: string
  errorMessage?: string // error description when state === 'error'
  x: number
  y: number
  startTime: number
  completeTime?: number // when the tool call completed (for minimum display duration)
  opacity: number
}

// Discovery — something the agent found and "pinned"
export interface Discovery {
  id: string
  agentId: string
  type: 'file' | 'pattern' | 'finding' | 'code'
  label: string
  content: string       // short preview
  x: number
  y: number
  targetX: number       // final resting position (discovery animates from tool call → target)
  targetY: number
  opacity: number
  timestamp: number
}

// File attention tracking
export interface FileAttention {
  path: string
  reads: number
  edits: number
  totalTokens: number   // how much context this file consumed
  lastAccessed: number
  agents: string[]      // which agents touched this file
}

// Timeline entry for Gantt view
export interface TimelineEntry {
  id: string
  agentId: string
  agentName: string
  startTime: number
  endTime?: number
  blocks: TimelineBlock[]
}

export interface TimelineBlock {
  id: string
  type: 'thinking' | 'tool_call' | 'idle' | 'complete'
  startTime: number
  endTime?: number
  label: string
  color: string
}

export interface TimelineEvent {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'branch'
  label: string
  timestamp: number
  duration?: number
  nodeId?: string
}

export interface Edge {
  id: string
  from: string
  to: string
  type: 'parent-child' | 'tool'
  opacity: number
}

export interface Particle {
  id: string
  edgeId: string
  progress: number
  type: 'dispatch' | 'return' | 'tool_call' | 'tool_return' | 'message'
  color: string
  size: number
  trailLength: number
  /** Particle belongs to an MCP tool call (drawn with a dotted trail) */
  mcp?: boolean
  label?: string        // what's flowing (e.g., "auth.ts 142 lines")
  /** Full subagent dispatch/return data (prompt, report, ...) carried by dispatch/return particles */
  detail?: ParticleDetail
}

export interface ParticleDetail {
  prompt?: string
  subagentType?: string
  model?: string
  /** Full subagent report (return particles) */
  summary?: string
  toolUseId?: string
  isError?: boolean
  durationS?: number
}

/** An Agent Team as the UI sees it (built from team_info events). Strings are untrusted and already sanitised. */
export interface TeamSummary {
  name: string
  leadSessionId: string
  leadName?: string
  members: Array<{ name: string; agentType?: string; color?: string; backendType?: string; sessionId?: string }>
}

export interface SimulationEvent {
  time: number
  type:
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
    | 'agent_link'
    | 'message_sent'
    | 'team_info'
    | 'agent_activity'
  payload: Record<string, unknown>
  sessionId?: string
}

export interface DepthParticle {
  x: number
  y: number
  size: number
  brightness: number
  speed: number
  depth: number
}

// ─── Layout Constants ────────────────────────────────────────────────────────

export const NODE = {
  radiusMain: 28,
  radiusSub: 20,
} as const

export const CARD = {
  detail: { width: 240, height: 200 },

  chat: { width: 300, maxHeight: 360, messagesMinHeight: 100, messagesMaxHeight: 240 },
  transcript: { width: 380 },
  margin: 8,
  offsetX: 40,     // horizontal offset from agent to detail card
  offsetY: -80,    // vertical offset from agent to detail card
} as const

export const Z = {
  info: 10,
  sidePanel: 40,
  controlBar: 50,
  chatPanel: 50,
  transcriptPanel: 60,
  detailCard: 100,
  contextMenu: 200,
} as const

// ─── Animation Constants ─────────────────────────────────────────────────────

export const TIMING = {
  controlBarHideMs: 3000,
  glassAnimMs: 200,
  contextMenuDelayMs: 50,
  chatFocusDelayMs: 300,
  autoPlayDelayMs: 500,
  resumeLiveDelayMs: 20,
  seekCompleteDelayMs: 50,
  livePulseMs: 1000,
} as const

export const ANIM = {
  inertiaDecay: 0.94,
  inertiaThreshold: 0.5,
  dragLerp: 0.25,
  autoFitLerp: 0.06,
  dragThresholdPx: 5,
  viewportPadding: 120,
  breathe: {
    thinkingSpeed: 2, thinkingAmp: 0.03,
    idleSpeed: 0.7, idleAmp: 0.015,
  },
  scanline: { thinking: 40, normal: 15 },
  orbitSpeed: 1.5,
  pulseSpeed: 4,
} as const

export const FX = {
  spawnDuration: 0.8,
  completeDuration: 1.0,
  shatterDuration: 0.8,
  shatterCount: 12,
  shatterSpeed: { min: 30, range: 60 },
  shatterSize: { min: 1, range: 2 },
  trailSegments: 8,
} as const

export const BEAM = {
  curvature: 0.15,
  cp1: 0.33,
  cp2: 0.66,
  segments: 16,
  parentChild: { startW: 3, endW: 1 },
  tool: { startW: 1.5, endW: 0.5 },
  glowExtra: { startW: 3, endW: 1, alpha: 0.08 },
  idleAlpha: 0.08,
  activeAlpha: 0.3,
  wobble: { amp: 3, freq: 10, timeFreq: 3, trailOffset: 0.15 },
} as const

export const TETHER = {
  alpha: 0.7,
  strokeAlpha: '80',
  lineWidth: 1,
  dash: [6, 4] as number[],
  dotRadius: 3,
  curveOffset: 20,
} as const

// ─── Popup Dimensions ───────────────────────────────────────────────────────

export const POPUP = {
  tool: { width: 320, estimatedHeight: 200 },
  discovery: { width: 300, estimatedHeight: 160 },
  controlBarMaxWidth: 680,
} as const

// Default empty context breakdown
export function emptyContextBreakdown(): ContextBreakdown {
  return { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 }
}
