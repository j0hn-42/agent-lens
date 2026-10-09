import type {
  Agent,
  ToolCallNode,
  Particle,
  Edge,
  Discovery,
  FileAttention,
  TeamSummary,
  TimelineEntry,
  SimulationEvent,
} from '../../lib/agent-types'
import type { SessionProjects } from './fleet-layout'
import type { UnattributedUsage } from '../../lib/attribution'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'

export interface SimulationState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: Particle[]
  edges: Edge[]
  discoveries: Discovery[]
  fileAttention: Map<string, FileAttention>
  timelineEntries: Map<string, TimelineEntry>
  conversations: Map<string, ConversationMessage[]>
  /** Communication links between agents (spawn / teammate), keyed by link id */
  links: Map<string, AgentLink>
  /** Agent Teams seen in this view (from team_info events), keyed by team name */
  teams: Map<string, TeamSummary>
  /** Usage that belongs to no single agent (orphan or ambiguous target), by addressed agentKey; see lib/attribution */
  unattributed: Map<string, UnattributedUsage>
  /** Per agentKey: conversation messages dropped because of MAX_CONVERSATION_MESSAGES */
  droppedMessages: Map<string, number>
  /** Events dropped from the front of eventLog because of MAX_EVENT_LOG */
  droppedEvents: number
  currentTime: number
  isPlaying: boolean
  speed: number
  eventIndex: number
  eventLog: SimulationEvent[]
  /** Highest currentTime ever reached (for scrubber range in live mode) */
  maxTimeReached: number
}

/** Create an empty simulation state, optionally preserving specific fields */
export function createEmptyState(overrides?: Partial<SimulationState>): SimulationState {
  return {
    agents: new Map(),
    toolCalls: new Map(),
    particles: [],
    edges: [],
    discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map(),
    conversations: new Map(),
    links: new Map(),
    teams: new Map(),
    unattributed: new Map(),
    droppedMessages: new Map(),
    droppedEvents: 0,
    currentTime: 0,
    isPlaying: false,
    speed: 1,
    eventIndex: 0,
    eventLog: [],
    maxTimeReached: 0,
    ...overrides,
  }
}

let _msgIdCounter = 0
export function nextMsgId(): string { return `msg-${_msgIdCounter++}` }

export interface ConversationMessage {
  id: string
  /** 'dispatch' / 'return' carry the full subagent prompt / report between two agents; 'message' is a teammate message */
  type: 'tool_call' | 'tool_result' | 'assistant' | 'user' | 'thinking' | 'dispatch' | 'return' | 'message'
  content: string
  timestamp: number
  toolName?: string
  inputData?: Record<string, unknown>
  /** dispatch/return/message: agentKeys of the sending and receiving agent */
  from?: string
  to?: string
  /** dispatch/return: edge id linking the pair (edgeId(parent, child)) */
  linkId?: string
  /** tool_use_id correlating a dispatch with its return and with the tool call */
  toolUseId?: string
  isError?: boolean
  /** Characters dropped from `content` by the ingestion cap (MAX_TEXT_LEN); absent when nothing was cut */
  cutChars?: number
}

export type LinkKind = 'spawn' | 'teammate'

/** Communication channel between two agents (parent/sub-agent or teammates) with its messages. */
export interface AgentLink {
  id: string
  /** agentKey of the sender side (parent for spawn links) */
  from: string
  /** agentKey of the receiver side */
  to: string
  kind: LinkKind
  sessionId: string
  messages: ConversationMessage[]
  /** Messages dropped because of MAX_LINK_MESSAGES */
  dropped: number
}

/** Max messages kept per link (oldest are dropped) */
export const MAX_LINK_MESSAGES = 200

/** Max length of an untrusted free-text field stored from an event payload */
export const MAX_TEXT_LEN = 4000

/** Max length of an untrusted identifier (agent name, link id, tool_use_id) */
export const MAX_ID_LEN = 200

/** Session id used for events that carry none */
export const DEFAULT_SESSION_ID = 'default'

/** Unique agent key across sessions */
export function agentKeyOf(sessionId: string, localId: string): string {
  return `${sessionId}:${localId}`
}

/** Max canvas message bubbles kept per agent (oldest are dropped) */
export const MAX_BUBBLES = 20

/** Max conversation messages kept per agent (oldest are dropped) */
export const MAX_CONVERSATION_MESSAGES = 200

/** Max events kept in the event log for seeking (oldest are dropped) */
export const MAX_EVENT_LOG = 5000

/** Append a message to a conversation, creating the array if needed.
 *  Auto-assigns a unique id if not provided.
 *  Caps history at MAX_CONVERSATION_MESSAGES per agent. */
export function appendConversation(
  conversations: Map<string, ConversationMessage[]>,
  agentKey: string,
  message: Omit<ConversationMessage, 'id'> & { id?: string },
  /** When given, counts the messages dropped by the cap per agentKey */
  dropped?: Map<string, number>,
): void {
  const msg: ConversationMessage = { id: message.id ?? nextMsgId(), ...message }
  const msgs = conversations.get(agentKey) || []
  const updated = [...msgs, msg]
  if (updated.length > MAX_CONVERSATION_MESSAGES) {
    const over = updated.length - MAX_CONVERSATION_MESSAGES
    dropped?.set(agentKey, (dropped.get(agentKey) ?? 0) + over)
    conversations.set(agentKey, updated.slice(over))
  } else {
    conversations.set(agentKey, updated)
  }
}

/** Build a deterministic edge ID from two agent keys */
export function edgeId(from: string, to: string): string {
  return `edge-${from}-${to}`
}

// ── Safe payload extraction helpers ──────────────────────────────────
export function asString(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback }
/** String capped to `max` chars (untrusted input) */
export function cappedString(v: unknown, max = MAX_TEXT_LEN, fallback = ''): string {
  return typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : fallback
}
/** Characters `cappedString` drops from `v` (0 when it fits or is not a string). */
export function cutCharsOf(v: unknown, max = MAX_TEXT_LEN): number {
  return typeof v === 'string' && v.length > max ? v.length - max : 0
}
/** Spread into a message so the cut is recorded only when something was cut. */
export function cutField(cut: number): { cutChars?: number } {
  return cut > 0 ? { cutChars: cut } : {}
}
export function asNumber(v: unknown, fallback = 0): number { return typeof v === 'number' ? v : fallback }
export function asBoolean(v: unknown, fallback = false): boolean { return typeof v === 'boolean' ? v : fallback }

// ── Truncation length constants ──────────────────────────────────────
export const LABEL_LEN_SHORT = 25
export const LABEL_LEN_PARTICLE = 30
export const LABEL_LEN_TIMELINE = 40
export const LABEL_LEN_NAME = 40
export const LABEL_LEN_TASK = 120
export const LABEL_LEN_BUBBLE = 200

export interface ForceNode extends SimulationNodeDatum {
  id: string
}

export interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string
}

export interface UseAgentSimulationOptions {
  /** If true, use MOCK_SCENARIO for demo playback. Default: true */
  useMockData?: boolean
  /** External events to process (from VS Code bridge). Consumed each frame. */
  externalEvents?: readonly SimulationEvent[]
  /** Called after external events are consumed */
  onExternalEventsConsumed?: () => void
  /** If set, only process events matching this session ID */
  sessionFilter?: string | null
  /** Ref updated synchronously when session changes (avoids stale closure in rAF) */
  sessionFilterRef?: React.RefObject<string | null>
  /** True while the user reviews history (paused/scrubbing). Speed other than 1 only applies then. */
  isReviewing?: boolean
  /** Seconds to add to the event time of each session in union views ('All' / team), keyed by session id.
   *  Events carry time relative to their own session start; offsets put them on a common wall-clock axis. */
  sessionOffsetsRef?: React.RefObject<ReadonlyMap<string, number> | undefined>
  /** Repository of each session (only those whose project is known): clusters of a same project are laid out side by side */
  sessionProjects?: SessionProjects
  /** 'Hide inactive agents' is on: hidden children do not count when a parent is centred on its children (#151) */
  hideInactive?: boolean
  /** If true, CLAUDE_CODE_DISABLE_1M_CONTEXT is set — cap context window to 200k */
  disable1MContext?: boolean
  /** Time (ms) a frame gives to catching up a burst of received events (#210). Default CATCH_UP_FRAME_BUDGET_MS */
  catchUpFrameBudgetMs?: number
}
