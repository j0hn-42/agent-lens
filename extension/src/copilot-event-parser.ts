/**
 * Parser for GitHub Copilot session logs at ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * Every line is `{ type, data, id, timestamp, parentId }`. Handled types (the rest is ignored,
 * forward-compatible):
 *
 *   session.start / session.resume — carry the working context and the selected model
 *   session.model_change           — the model changed mid-session
 *   user.message                   — a user prompt (content; transformedContent is the injected
 *                                    variant and is never displayed)
 *   assistant.message              — assistant text; its toolRequests mirror the
 *                                    tool.execution_start events and are not read twice
 *   assistant.reasoning            — plaintext thinking, when the model exposes it
 *   tool.execution_start / _complete — a tool call and its result
 *   subagent.started / .completed / .failed — sub-agent lifecycle
 *
 * Sub-agents: a child is spawned only from subagent.started, parented to the orchestrator. A tool
 * call is attributed to a child only when it carries a parentToolCallId naming that sub-agent;
 * otherwise it stays on the orchestrator — the parent of a node is never guessed.
 */

import { AgentEvent, emitSubagentSpawn } from './protocol'
import {
  ORCHESTRATOR_NAME, HASH_PREFIX_MAX, MESSAGE_MAX, PREVIEW_MAX, RESULT_MAX, TASK_MAX,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery, detectError,
} from './tool-summarizer'
import { estimateTokenCost } from './token-estimator'
import { SessionNormalizer } from './event-normalize'

// ─── State ─────────────────────────────────────────────────────────────────

interface PendingCopilotToolCall {
  name: string
  agent: string
  filePath?: string
  startTime: number
}

interface ActiveSubagent {
  name: string
  startTime: number
}

export interface CopilotEventState {
  /** Most recent model announced by the session (emitted once per change). */
  model: string | null
  /** Cwd read from session.start / session.resume. */
  cwd: string | null
  /** Label derived from the first user message. */
  label: string | null
  /** Pending tool calls, keyed by toolCallId. */
  pendingToolCalls: Map<string, PendingCopilotToolCall>
  /** Running sub-agents, keyed by the toolCallId of the dispatching call. */
  subagents: Map<string, ActiveSubagent>
  /** Sub-agent names already used, to keep spawned names unique. */
  subagentNames: Map<string, number>
  /** Ids of events already processed (the log may be replayed after a rewrite). */
  seenEventIds: Set<string>
  /** Content hashes of already-emitted messages. */
  seenMessageHashes: Set<string>
  spawnEmitted: boolean
}

export function createCopilotEventState(): CopilotEventState {
  return {
    model: null,
    cwd: null,
    label: null,
    pendingToolCalls: new Map(),
    subagents: new Map(),
    subagentNames: new Map(),
    seenEventIds: new Set(),
    seenMessageHashes: new Set(),
    spawnEmitted: false,
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface CopilotParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when a session label is derived from the first user message. */
  setLabel?(label: string): void
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Bound on remembered event ids / hashes per session. */
const SEEN_MAX = 5000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function remember(set: Set<string>, value: string): boolean {
  if (set.has(value)) return false
  if (set.size >= SEEN_MAX) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(value)
  return true
}

/** Copilot tool arguments use `path`/`command`/`pattern`; map them to the keys the shared
 *  summarizer reads, without renaming the tool shown in the UI. */
function summarizerView(name: string, args: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  const path = args.path ?? args.file_path
  switch (name) {
    case 'bash': case 'powershell': case 'shell':
      return { tool: 'Bash', input: { command: args.command ?? args.cmd } }
    case 'view':
      return { tool: 'Read', input: { file_path: path } }
    case 'edit': case 'str_replace_editor': case 'str_replace':
      return { tool: 'Edit', input: { file_path: path } }
    case 'create':
      return { tool: 'Write', input: { file_path: path } }
    case 'glob':
      return { tool: 'Glob', input: { pattern: args.pattern } }
    case 'grep':
      return { tool: 'Grep', input: { pattern: args.pattern } }
    case 'web_fetch':
      return { tool: 'WebFetch', input: { url: args.url } }
    case 'task':
      return { tool: 'Task', input: { description: args.description, prompt: args.prompt } }
    case 'report_intent':
      return { tool: name, input: { intent: args.intent } }
    default:
      return { tool: name, input: args }
  }
}

function summarizeCopilotArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'report_intent') return String(args.intent ?? '').slice(0, TASK_MAX)
  const { tool, input } = summarizerView(name, args)
  return summarizeInput(tool, input)
}

/** The text of a tool result: `result.content` (or `detailedContent`), or the error message. */
function resultText(data: Record<string, unknown>): string {
  const result = data.result
  if (isRecord(result)) {
    const text = str(result.content) ?? str(result.detailedContent)
    if (text) return text
  }
  if (isRecord(data.error)) return str(data.error.message) ?? ''
  return str(data.error) ?? ''
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class CopilotEventParser {
  /** Input normalizer of this session (one parser per session): every emitted event goes through it. */
  readonly normalizer: SessionNormalizer
  private readonly delegate: CopilotParserDelegate

  constructor(rawDelegate: CopilotParserDelegate) {
    this.normalizer = new SessionNormalizer(undefined, { onTrailing: event => rawDelegate.emit(event) })
    this.delegate = {
      emit: event => { for (const out of this.normalizer.process(event)) rawDelegate.emit(out) },
      elapsed: () => rawDelegate.elapsed(),
      ...(rawDelegate.setLabel ? { setLabel: (label: string) => rawDelegate.setLabel?.(label) } : {}),
    }
  }

  /** Parse a single JSONL line. Silently skips unparseable/unknown lines. */
  processLine(line: string, state: CopilotEventState): void {
    const trimmed = line.trim()
    if (!trimmed) return

    const record = this.normalizer.parseLine(trimmed)
    if (!record) return

    try {
      const id = str(record.id)
      if (id && !remember(state.seenEventIds, id)) { this.normalizer.stats.duplicateEvents++; return }
      this.dispatch(record, state)
    } catch {
      // Untrusted input must never take the watcher down: count it and move on
      this.normalizer.noteMalformed()
    }
  }

  private dispatch(record: Record<string, unknown>, state: CopilotEventState): void {
    const data = isRecord(record.data) ? record.data : {}
    this.ensureSpawned(state)

    switch (record.type) {
      case 'session.start':
        return this.handleSessionContext(data, state, str(data.selectedModel))
      case 'session.resume':
        return this.handleSessionContext(data, state, str(data.selectedModel))
      case 'session.model_change':
        return this.noteModel(state, str(data.newModel) ?? str(data.model))
      case 'user.message':
        return this.handleUserMessage(data, state)
      case 'assistant.message':
        return this.handleAssistantMessage(data, state)
      case 'assistant.reasoning':
        return this.handleReasoning(data, state)
      case 'tool.execution_start':
        return this.handleToolStart(data, state)
      case 'tool.execution_complete':
        return this.handleToolComplete(data, state)
      case 'subagent.started':
        return this.handleSubagentStarted(data, state)
      case 'subagent.completed':
        return this.handleSubagentEnded(data, state, false)
      case 'subagent.failed':
        return this.handleSubagentEnded(data, state, true)
    }
  }

  // ─── Orchestrator lifecycle ──────────────────────────────────────────────

  private ensureSpawned(state: CopilotEventState): void {
    if (state.spawnEmitted) return
    state.spawnEmitted = true
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: 'Copilot session', runtime: 'copilot' },
    })
  }

  private handleSessionContext(data: Record<string, unknown>, state: CopilotEventState, model: string | undefined): void {
    const context = isRecord(data.context) ? data.context : undefined
    const cwd = str(context?.cwd)
    if (cwd) state.cwd = cwd
    this.noteModel(state, model)
  }

  private noteModel(state: CopilotEventState, model: string | undefined): void {
    if (!model || model === state.model) return
    state.model = model
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'model_detected',
      payload: { agent: ORCHESTRATOR_NAME, model },
    })
  }

  // ─── Messages ────────────────────────────────────────────────────────────

  private handleUserMessage(data: Record<string, unknown>, state: CopilotEventState): void {
    const text = str(data.content)?.trim()
    if (!text) return
    if (!remember(state.seenMessageHashes, `user:${str(data.interactionId) ?? text.slice(0, HASH_PREFIX_MAX)}`)) return

    if (!state.label) {
      state.label = text.slice(0, PREVIEW_MAX)
      this.delegate.setLabel?.(state.label)
    }
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent: ORCHESTRATOR_NAME, role: 'user', content: text.slice(0, MESSAGE_MAX) },
    })
  }

  private handleAssistantMessage(data: Record<string, unknown>, state: CopilotEventState): void {
    // Thinking first (it precedes the answer), then the visible text. The toolRequests list is
    // deliberately not read: tool.execution_start is the single source of tool calls.
    const reasoning = str(data.reasoningText)?.trim()
    if (reasoning) this.emitThinking(reasoning, str(data.messageId), state)

    const text = str(data.content)?.trim()
    if (!text) return
    if (!remember(state.seenMessageHashes, `assistant:${str(data.messageId) ?? text.slice(0, HASH_PREFIX_MAX)}`)) return
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent: this.agentFor(str(data.parentToolCallId), state), role: 'assistant', content: text.slice(0, MESSAGE_MAX) },
    })
  }

  private handleReasoning(data: Record<string, unknown>, state: CopilotEventState): void {
    const text = (str(data.content) ?? str(data.text))?.trim()
    if (text) this.emitThinking(text, str(data.reasoningId), state)
  }

  private emitThinking(text: string, id: string | undefined, state: CopilotEventState): void {
    if (!remember(state.seenMessageHashes, `thinking:${id ?? text.slice(0, HASH_PREFIX_MAX)}`)) return
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent: ORCHESTRATOR_NAME, role: 'thinking', content: text.slice(0, MESSAGE_MAX) },
    })
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  /** The agent a record belongs to: the sub-agent named by its parentToolCallId, else the orchestrator. */
  private agentFor(parentToolCallId: string | undefined, state: CopilotEventState): string {
    return (parentToolCallId && state.subagents.get(parentToolCallId)?.name) || ORCHESTRATOR_NAME
  }

  private handleToolStart(data: Record<string, unknown>, state: CopilotEventState): void {
    const callId = str(data.toolCallId)
    if (!callId) return
    // A toolCallId seen twice is a replay of the same call, not a second call
    if (state.pendingToolCalls.has(callId)) { this.normalizer.stats.duplicateEvents++; return }

    const name = str(data.toolName) ?? 'unknown'
    const args = isRecord(data.arguments) ? data.arguments : {}
    const agent = this.agentFor(str(data.parentToolCallId), state)
    const argsSummary = summarizeCopilotArgs(name, args)
    const view = summarizerView(name, args)

    state.pendingToolCalls.set(callId, { name, agent, filePath: extractFilePath(view.input), startTime: Date.now() })

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
  }

  private handleToolComplete(data: Record<string, unknown>, state: CopilotEventState): void {
    const callId = str(data.toolCallId)
    if (!callId) return
    const pending = state.pendingToolCalls.get(callId)
    if (!pending) return
    state.pendingToolCalls.delete(callId)

    const output = resultText(data)
    const resultSummary = summarizeResult(output).slice(0, RESULT_MAX)
    const isError = data.success === false || detectError(output)
    const discovery = buildDiscovery(summarizerView(pending.name, {}).tool, pending.filePath, output)

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: pending.agent,
        tool: pending.name,
        result: resultSummary,
        tokenCost: estimateTokenCost(pending.name, output),
        tokenSource: 'estimated',
        toolUseId: callId,
        ...(isError ? { isError: true, errorMessage: resultSummary } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })
  }

  // ─── Sub-agents ──────────────────────────────────────────────────────────

  private handleSubagentStarted(data: Record<string, unknown>, state: CopilotEventState): void {
    const callId = str(data.toolCallId)
    if (!callId || state.subagents.has(callId)) return

    const base = str(data.agentDisplayName) ?? str(data.agentName) ?? 'subagent'
    const seen = (state.subagentNames.get(base) ?? 0) + 1
    state.subagentNames.set(base, seen)
    const name = seen === 1 ? base : `${base} #${seen}`
    const task = (str(data.agentDescription) ?? base).slice(0, TASK_MAX)

    state.subagents.set(callId, { name, startTime: Date.now() })
    emitSubagentSpawn(
      { emit: e => this.delegate.emit(e), elapsed: () => this.delegate.elapsed() },
      ORCHESTRATOR_NAME, name, task, undefined,
      { toolUseId: callId, label: base, ...(str(data.agentName) ? { subagentType: str(data.agentName) } : {}) },
      { runtime: 'copilot' },
    )
  }

  private handleSubagentEnded(data: Record<string, unknown>, state: CopilotEventState, failed: boolean): void {
    const callId = str(data.toolCallId)
    const sub = callId ? state.subagents.get(callId) : undefined
    if (!callId || !sub) return
    state.subagents.delete(callId)

    const summary = (failed ? (str(data.error) ?? (isRecord(data.error) ? str(data.error.message) : undefined)) : undefined)
      ?? (failed ? 'Sub-agent failed' : 'Sub-agent completed')
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'subagent_return',
      payload: {
        child: sub.name,
        parent: ORCHESTRATOR_NAME,
        summary: summary.slice(0, MESSAGE_MAX),
        toolUseId: callId,
        isError: failed,
        durationS: Math.round((Date.now() - sub.startTime) / 100) / 10,
        tokenCost: 0,
      },
    })
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_complete',
      payload: { name: sub.name },
    })
  }
}
