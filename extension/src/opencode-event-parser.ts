/**
 * Parser for OpenCode sessions, read from the rows of its SQLite database (#346).
 *
 * Format checked against OpenCode v1.19.0 (packages/core/src/session/sql.ts and
 * packages/schema/src/v1/session.ts). Three tables are read; `time_*` columns are epoch
 * milliseconds and `data` is a JSON text column:
 *
 *   session — one row per session; a child session (`parent_id` set) is created by the `task` tool
 *   message — `data.role` is `user` or `assistant`; an assistant message carries `modelID`,
 *             `tokens`, `time.completed`, `finish` and `error`
 *   part    — the content of a message: `text`, `reasoning`, `tool`, `compaction`, ... (the rest is
 *             ignored, forward-compatible)
 *
 * Rows are updated in place (a tool part goes pending → running → completed), so the same row is
 * read again after each update: every event below is emitted once per row and per state.
 *
 * One parser per root session. A child session is a sub-agent of the agent that owns its parent
 * session; its rows are fed to the parser of the root. The watcher feeds, within one read,
 * sessions, then messages, then parts: a part whose message is unknown is ignored.
 *
 * Not in the database, so never emitted: a pending permission (the part stays `running`), the end
 * of the root session (no agent_complete for it), text being streamed (a text or reasoning part is
 * shown once its `time.end` is set).
 */

import { AgentEvent, emitSubagentSpawn } from './protocol'
import {
  ORCHESTRATOR_NAME, MESSAGE_MAX, NORM_ID_MAX, PREVIEW_MAX, RESULT_MAX, TASK_MAX,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery,
} from './tool-summarizer'
import { estimateTokenCost } from './token-estimator'
import { SessionNormalizer } from './event-normalize'

// ─── Rows ──────────────────────────────────────────────────────────────────

/** Columns of the `session` table read by the parser. */
export interface OpenCodeSessionRow {
  id: string
  parent_id: string | null
  directory: string | null
  title: string | null
  agent?: string | null
  time_created: number
  time_updated: number
}

/** Columns of the `message` table read by the parser. */
export interface OpenCodeMessageRow {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

/** Columns of the `part` table read by the parser. */
export interface OpenCodePartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

// ─── State ─────────────────────────────────────────────────────────────────

interface KnownMessage {
  role: 'user' | 'assistant'
  agent: string
}

interface ToolCallState {
  name: string
  agent: string
  filePath?: string
  ended: boolean
}

export interface OpenCodeEventState {
  /** Id of the root session this parser renders. */
  readonly rootSessionId: string
  /** Directory of the root session. */
  cwd: string | null
  /** Current label and whether it is the session title (a title wins over the first prompt). */
  label: string | null
  labelFromTitle: boolean
  spawnEmitted: boolean
  /** Agent name of every known session (root → orchestrator, child → its sub-agent). */
  sessionAgents: Map<string, string>
  /** Sub-agent names already used, to keep spawned names unique. */
  subagentNames: Map<string, number>
  /** Child session of each task call, from the call's `state.metadata.sessionId`. */
  taskChildren: Map<string, string>
  /** Messages seen, keyed by message id. */
  messages: Map<string, KnownMessage>
  /** Last model and last context size reported, per agent. */
  models: Map<string, string>
  contextTokens: Map<string, number>
  /** Tool calls started, keyed by callID. */
  toolCalls: Map<string, ToolCallState>
  /** Row-level facts already emitted (`<kind>:<id>`): text parts, idle messages, errors, compactions. */
  emitted: Set<string>
}

export function createOpenCodeEventState(rootSessionId: string): OpenCodeEventState {
  return {
    rootSessionId,
    cwd: null,
    label: null,
    labelFromTitle: false,
    spawnEmitted: false,
    sessionAgents: new Map(),
    subagentNames: new Map(),
    taskChildren: new Map(),
    messages: new Map(),
    models: new Map(),
    contextTokens: new Map(),
    toolCalls: new Map(),
    emitted: new Set(),
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface OpenCodeParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when the session label changes (title, or first prompt while the title is a default). */
  setLabel?(label: string): void
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Bound on remembered ids per session (maps and sets). */
const SEEN_MAX = 5000

/** Titles OpenCode gives before generating one (session/index.ts createDefaultTitle). */
const DEFAULT_TITLE_RE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** An identifier kept in bounded state: refused (undefined) past NORM_ID_MAX characters. */
function idStr(v: unknown): string | undefined {
  const s = str(v)
  return s && s.length <= NORM_ID_MAX ? s : undefined
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0
}

/** Adds to a bounded set (oldest evicted); false when already present. */
function remember(set: Set<string>, value: string): boolean {
  if (set.has(value)) return false
  if (set.size >= SEEN_MAX) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(value)
  return true
}

/** Sets a key in a bounded map (oldest evicted). */
function put<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= SEEN_MAX) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** OpenCode's built-in tools (packages/opencode/src/tool/*.ts) take `filePath`/`command`/`pattern`;
 *  map them to the keys the shared summarizer reads, without renaming the tool shown in the UI. */
function summarizerView(name: string, args: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  switch (name) {
    case 'bash':
      return { tool: 'Bash', input: { command: args.command } }
    case 'read':
      return { tool: 'Read', input: { file_path: args.filePath } }
    case 'edit': case 'multiedit':
      return { tool: 'Edit', input: { file_path: args.filePath } }
    case 'write':
      return { tool: 'Write', input: { file_path: args.filePath } }
    case 'glob':
      return { tool: 'Glob', input: { pattern: args.pattern } }
    case 'grep':
      return { tool: 'Grep', input: { pattern: args.pattern } }
    case 'list':
      return { tool: 'Read', input: { path: args.path } }
    case 'webfetch':
      return { tool: 'WebFetch', input: { url: args.url } }
    case 'todowrite':
      return { tool: 'TodoWrite', input: { todos: args.todos } }
    case 'task':
      return { tool: 'Task', input: { description: args.description, prompt: args.prompt } }
    default:
      return { tool: name, input: args }
  }
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class OpenCodeEventParser {
  /** Input normalizer of this session (one parser per root session): every emitted event goes through it. */
  readonly normalizer: SessionNormalizer
  private readonly delegate: OpenCodeParserDelegate

  constructor(rawDelegate: OpenCodeParserDelegate) {
    this.normalizer = new SessionNormalizer(undefined, { onTrailing: event => rawDelegate.emit(event) })
    this.delegate = {
      emit: event => { for (const out of this.normalizer.process(event)) rawDelegate.emit(out) },
      elapsed: () => rawDelegate.elapsed(),
      ...(rawDelegate.setLabel ? { setLabel: (label: string) => rawDelegate.setLabel?.(label) } : {}),
    }
  }

  /** A row of the `session` table: the root session, or a child of a known session. */
  processSession(row: OpenCodeSessionRow, state: OpenCodeEventState): void {
    try {
      const id = idStr(row.id)
      if (!id) return
      if (id === state.rootSessionId) return this.handleRoot(row, state)
      const parentAgent = row.parent_id ? state.sessionAgents.get(row.parent_id) : undefined
      // The parent of a node is never guessed: a session outside this tree is not ours
      if (!parentAgent || state.sessionAgents.has(id)) return
      this.spawnChild(id, row, parentAgent, state)
    } catch {
      // Untrusted input must never take the watcher down: count it and move on
      this.normalizer.noteMalformed()
    }
  }

  /** A row of the `message` table. */
  processMessage(row: OpenCodeMessageRow, state: OpenCodeEventState): void {
    const agent = state.sessionAgents.get(row.session_id)
    if (!agent) return
    const data = this.parseData(row.data)
    if (!data) return
    try {
      const id = idStr(row.id)
      if (!id) { this.normalizer.noteMalformed(); return }
      if (data.role === 'user') return put(state.messages, id, { role: 'user', agent })
      if (data.role === 'assistant') {
        put(state.messages, id, { role: 'assistant', agent })
        this.handleAssistant(id, agent, data, state)
      }
    } catch {
      this.normalizer.noteMalformed()
    }
  }

  /** A row of the `part` table. */
  processPart(row: OpenCodePartRow, state: OpenCodeEventState): void {
    const msg = state.messages.get(row.message_id)
    if (!msg) return
    const data = this.parseData(row.data)
    if (!data) return
    try {
      const id = idStr(row.id)
      if (!id) { this.normalizer.noteMalformed(); return }
      switch (data.type) {
        case 'text': return this.handleText(id, msg, data, state)
        case 'reasoning': return this.handleReasoning(id, msg, data, state)
        case 'tool': return this.handleTool(msg, data, state)
        case 'compaction': return this.handleCompaction(id, msg, data, state)
      }
    } catch {
      this.normalizer.noteMalformed()
    }
  }

  private parseData(raw: unknown): Record<string, unknown> | undefined {
    return this.normalizer.parseLine(raw)
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  private handleRoot(row: OpenCodeSessionRow, state: OpenCodeEventState): void {
    if (!state.spawnEmitted) {
      state.spawnEmitted = true
      state.sessionAgents.set(state.rootSessionId, ORCHESTRATOR_NAME)
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'agent_spawn',
        payload: { name: ORCHESTRATOR_NAME, isMain: true, task: 'OpenCode session', runtime: 'opencode' },
      })
    }
    const cwd = str(row.directory)
    if (cwd) state.cwd = cwd
    const title = str(row.title)?.trim()
    if (title && !DEFAULT_TITLE_RE.test(title)) this.setLabel(state, title.slice(0, PREVIEW_MAX), true)
  }

  private setLabel(state: OpenCodeEventState, label: string, fromTitle: boolean): void {
    if (label === state.label) return
    state.label = label
    state.labelFromTitle = fromTitle
    this.delegate.setLabel?.(label)
  }

  private spawnChild(id: string, row: OpenCodeSessionRow, parentAgent: string, state: OpenCodeEventState): void {
    const kind = idStr(row.agent)
    const base = kind ?? 'subagent'
    const seen = (state.subagentNames.get(base) ?? 0) + 1
    put(state.subagentNames, base, seen)
    const name = seen === 1 ? base : `${base} #${seen}`
    put(state.sessionAgents, id, name)

    const title = str(row.title)?.trim()
    const task = (title && !DEFAULT_TITLE_RE.test(title) ? title : base).slice(0, TASK_MAX)
    const callId = [...state.taskChildren].find(([, child]) => child === id)?.[0]
    emitSubagentSpawn(
      { emit: e => this.delegate.emit(e), elapsed: () => this.delegate.elapsed() },
      parentAgent, name, task, undefined,
      { label: base, ...(kind ? { subagentType: kind } : {}), ...(callId ? { toolUseId: callId } : {}) },
      { runtime: 'opencode' },
    )
  }

  // ─── Messages ────────────────────────────────────────────────────────────

  private emitMessage(agent: string, role: 'user' | 'assistant' | 'thinking', text: string): void {
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent, role, content: text.slice(0, MESSAGE_MAX) },
    })
  }

  private handleAssistant(id: string, agent: string, data: Record<string, unknown>, state: OpenCodeEventState): void {
    const model = idStr(data.modelID)
    if (model && model !== state.models.get(agent)) {
      put(state.models, agent, model)
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'model_detected',
        payload: { agent, model },
      })
    }

    // The tokens of the last step, as OpenCode wrote them; it records no context window
    const tokens = isRecord(data.tokens) ? data.tokens : undefined
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined
    const total = count(tokens?.input) + count(tokens?.output) + count(tokens?.reasoning)
      + count(cache?.read) + count(cache?.write)
    if (total > 0 && total !== state.contextTokens.get(agent)) {
      put(state.contextTokens, agent, total)
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'context_update',
        payload: { agent, tokens: total, tokenSource: 'reported' },
      })
    }

    const error = isRecord(data.error) ? data.error : undefined
    if (error && remember(state.emitted, `error:${id}`)) {
      const name = str(error.name)?.slice(0, NORM_ID_MAX)
      const message = (isRecord(error.data) ? str(error.data.message) : undefined) ?? name ?? 'Error'
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'error',
        payload: { agent, ...(name ? { name } : {}), message: message.slice(0, MESSAGE_MAX) },
      })
    }

    // A step that asked for tools is followed by another one: only the last step ends the turn
    const time = isRecord(data.time) ? data.time : undefined
    if (count(time?.completed) > 0 && data.finish !== 'tool-calls' && remember(state.emitted, `idle:${id}`)) {
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'agent_idle',
        payload: { name: agent, turnEnd: true },
      })
    }
  }

  private handleText(id: string, msg: KnownMessage, data: Record<string, unknown>, state: OpenCodeEventState): void {
    // Injected by OpenCode (file contents, reminders) or excluded from the prompt: not a message
    if (data.synthetic === true || data.ignored === true) return
    const text = str(data.text)?.trim()
    if (!text) return
    if (msg.role === 'assistant' && !this.finished(data)) return
    if (!remember(state.emitted, `text:${id}`)) return
    if (msg.role === 'user' && msg.agent === ORCHESTRATOR_NAME && !state.labelFromTitle && !state.label) {
      this.setLabel(state, text.slice(0, PREVIEW_MAX), false)
    }
    this.emitMessage(msg.agent, msg.role, text)
  }

  private handleReasoning(id: string, msg: KnownMessage, data: Record<string, unknown>, state: OpenCodeEventState): void {
    const text = str(data.text)?.trim()
    if (!text || !this.finished(data)) return
    if (!remember(state.emitted, `text:${id}`)) return
    this.emitMessage(msg.agent, 'thinking', text)
  }

  /** A text or reasoning part is complete once OpenCode set its `time.end`. */
  private finished(data: Record<string, unknown>): boolean {
    return isRecord(data.time) && count(data.time.end) > 0
  }

  private handleCompaction(id: string, msg: KnownMessage, data: Record<string, unknown>, state: OpenCodeEventState): void {
    if (!remember(state.emitted, `compaction:${id}`)) return
    const trigger = data.auto === true ? 'auto' : data.auto === false ? 'manual' : undefined
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'context_compacted',
      payload: { agent: msg.agent, ...(trigger ? { trigger } : {}) },
    })
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  private handleTool(msg: KnownMessage, data: Record<string, unknown>, state: OpenCodeEventState): void {
    const callId = idStr(data.callID)
    const toolState = isRecord(data.state) ? data.state : undefined
    if (!callId || !toolState) return
    const status = toolState.status
    // pending: the input is still being generated, nothing to show yet
    if (status !== 'running' && status !== 'completed' && status !== 'error') return

    const name = str(data.tool)?.slice(0, NORM_ID_MAX) ?? 'unknown'
    const metadata = isRecord(toolState.metadata) ? toolState.metadata : undefined
    const childId = name === 'task' ? idStr(metadata?.sessionId) : undefined
    if (childId) put(state.taskChildren, callId, childId)

    let call = state.toolCalls.get(callId)
    if (!call) call = this.startTool(callId, name, msg.agent, toolState, state)
    if (status === 'running' || call.ended) return
    call.ended = true
    this.endTool(callId, call, toolState, status === 'error', state)
  }

  private startTool(
    callId: string, name: string, agent: string, toolState: Record<string, unknown>, state: OpenCodeEventState,
  ): ToolCallState {
    const args = isRecord(toolState.input) ? toolState.input : {}
    const view = summarizerView(name, args)
    const argsSummary = summarizeInput(view.tool, view.input)
    const call: ToolCallState = { name, agent, filePath: extractFilePath(view.input)?.slice(0, 4096), ended: false }
    put(state.toolCalls, callId, call)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent,
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(view.tool, view.input),
        toolUseId: callId,
      },
    })
    return call
  }

  private endTool(
    callId: string, call: ToolCallState, toolState: Record<string, unknown>, isError: boolean, state: OpenCodeEventState,
  ): void {
    const output = (isError ? str(toolState.error) : str(toolState.output)) ?? ''
    const resultSummary = summarizeResult(output).slice(0, RESULT_MAX)
    const discovery = buildDiscovery(summarizerView(call.name, {}).tool, call.filePath, output)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: call.agent,
        tool: call.name,
        result: resultSummary,
        tokenCost: estimateTokenCost(call.name, output),
        tokenSource: 'estimated',
        toolUseId: callId,
        ...(isError ? { isError: true, errorMessage: resultSummary } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })

    const childId = state.taskChildren.get(callId)
    const child = childId ? state.sessionAgents.get(childId) : undefined
    if (!child) return
    const time = isRecord(toolState.time) ? toolState.time : undefined
    const start = count(time?.start)
    const end = count(time?.end)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'subagent_return',
      payload: {
        child,
        parent: call.agent,
        summary: (resultSummary || (isError ? 'Sub-agent failed' : 'Sub-agent completed')).slice(0, MESSAGE_MAX),
        toolUseId: callId,
        isError,
        ...(start > 0 && end >= start ? { durationS: Math.round((end - start) / 100) / 10 } : {}),
        tokenCost: 0,
      },
    })
    // The task call ended: the child's work is over, proven by its parent's tool part
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_complete',
      payload: { name: child },
    })
  }
}
