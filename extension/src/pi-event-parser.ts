/**
 * Parser for Pi coding agent session files at ~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl
 *
 * Format checked against pi's docs/session-format.md and docs/message-types.md (#238): the first
 * line is a `session` header (`version`, `id`, `cwd`), every other line an entry
 * `{ type, id, parentId, timestamp, ... }`. Versions 1 to 3 are known: v1 entries have no
 * `id`/`parentId`, v2 adds them, v3 renames the `hookMessage` role to `custom` (neither is read
 * here). An unknown or non-numeric version stops the parser: nothing is emitted, one warning.
 *
 * Handled entries (the rest is ignored, forward-compatible):
 *   message / role user        — a prompt (string or text blocks); labels the session
 *   message / role assistant   — `thinking`, `text` and `toolCall` blocks; `model` is the model
 *                                that answered, the only model shown
 *   message / role toolResult  — the result of a toolCall, paired by toolCallId
 *   compaction                 — `tokensBefore`, reported as context_compacted
 *   session_info               — the user-given session name, which replaces the label
 *
 * Not shown, on purpose: `model_change` (a selection, possibly a virtual model, not the model that
 * answered), system / custom / bashExecution messages, usage. Pi documents no sub-agents: every
 * event belongs to the orchestrator and no child is ever created.
 */

import type { AgentEvent } from './protocol'
import {
  ORCHESTRATOR_NAME, MESSAGE_MAX, NORM_ID_MAX, PREVIEW_MAX, RESULT_MAX,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery,
} from './tool-summarizer'
import { estimateTokenCost } from './token-estimator'
import { SessionNormalizer } from './event-normalize'

/** Highest session format version this parser was checked against (pi CURRENT_SESSION_VERSION). */
export const PI_SESSION_VERSION_MAX = 3

/** True for a header `version` this parser knows: absent (v1) or an integer from 1 to the max. */
export function isSupportedPiVersion(raw: unknown): boolean {
  const version = raw === undefined ? 1 : raw
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= PI_SESSION_VERSION_MAX
}

// ─── State ─────────────────────────────────────────────────────────────────

interface PendingPiToolCall {
  name: string
  filePath?: string
}

export interface PiEventState {
  /** Header version (1 when the header has none); null until the header is read. */
  version: number | null
  /** Header id and cwd. */
  sessionId: string | null
  cwd: string | null
  /** Set once the header announced a version this parser does not know: nothing is emitted. */
  unsupported: boolean
  /** Model of the last assistant message (emitted once per change). */
  model: string | null
  /** Current label and whether it comes from a user-given session name. */
  label: string | null
  labelFromName: boolean
  /** Pending tool calls, keyed by toolCall id. */
  pendingToolCalls: Map<string, PendingPiToolCall>
  /** Entry ids already processed (a file may be re-read after a rewrite). */
  seenEntryIds: Set<string>
  spawnEmitted: boolean
}

export function createPiEventState(): PiEventState {
  return {
    version: null,
    sessionId: null,
    cwd: null,
    unsupported: false,
    model: null,
    label: null,
    labelFromName: false,
    pendingToolCalls: new Map(),
    seenEntryIds: new Set(),
    spawnEmitted: false,
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface PiParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when the session label changes (first prompt, then a user-given name). */
  setLabel?(label: string): void
  /** Called once when the file cannot be read safely (unknown version). */
  warn?(message: string): void
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Bound on remembered entry ids and pending tool calls per session. */
const SEEN_MAX = 5000

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

/** Text of a `string | (TextContent | ImageContent)[]` content: text blocks joined, images dropped. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Pi's built-in tools (core/tools/*.ts) take `path`/`command`/`pattern`; map them to the keys the
 *  shared summarizer reads, without renaming the tool shown in the UI. */
function summarizerView(name: string, args: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  switch (name) {
    case 'bash': case 'powershell':
      return { tool: 'Bash', input: { command: args.command } }
    case 'read':
      return { tool: 'Read', input: { file_path: args.path } }
    case 'edit':
      return { tool: 'Edit', input: { file_path: args.path } }
    case 'write':
      return { tool: 'Write', input: { file_path: args.path } }
    case 'grep':
      return { tool: 'Grep', input: { pattern: args.pattern } }
    case 'find':
      return { tool: 'Glob', input: { pattern: args.pattern } }
    default:
      return { tool: name, input: args }
  }
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class PiEventParser {
  /** Input normalizer of this session (one parser per session): every emitted event goes through it. */
  readonly normalizer: SessionNormalizer
  private readonly delegate: PiParserDelegate

  constructor(rawDelegate: PiParserDelegate) {
    this.normalizer = new SessionNormalizer(undefined, { onTrailing: event => rawDelegate.emit(event) })
    this.delegate = {
      emit: event => { for (const out of this.normalizer.process(event)) rawDelegate.emit(out) },
      elapsed: () => rawDelegate.elapsed(),
      ...(rawDelegate.setLabel ? { setLabel: (label: string) => rawDelegate.setLabel?.(label) } : {}),
      ...(rawDelegate.warn ? { warn: (message: string) => rawDelegate.warn?.(message) } : {}),
    }
  }

  /** Parse a single JSONL line. Silently skips unparseable/unknown lines. */
  processLine(line: string, state: PiEventState): void {
    if (state.unsupported) return
    const trimmed = line.trim()
    if (!trimmed) return

    const record = this.normalizer.parseLine(trimmed)
    if (!record) return

    try {
      if (record.type === 'session') return this.handleHeader(record, state)
      // No header yet: the version is unknown, so nothing read here can be trusted
      if (state.version === null) return
      if (str(record.id) && !idStr(record.id)) { this.normalizer.noteMalformed(); return }
      const id = idStr(record.id)
      if (id && !remember(state.seenEntryIds, id)) { this.normalizer.stats.duplicateEvents++; return }
      this.dispatch(record, state)
    } catch {
      // Untrusted input must never take the watcher down: count it and move on
      this.normalizer.noteMalformed()
    }
  }

  private handleHeader(record: Record<string, unknown>, state: PiEventState): void {
    if (state.version !== null) return
    const raw = record.version
    if (!isSupportedPiVersion(raw)) {
      state.unsupported = true
      this.delegate.warn?.(
        `Pi session format version ${String(raw).slice(0, 16)} is not supported (known: 1 to ${PI_SESSION_VERSION_MAX}): session not shown.`,
      )
      return
    }
    state.version = raw === undefined ? 1 : raw as number
    state.sessionId = str(record.id) ?? null
    state.cwd = str(record.cwd) ?? null
  }

  private dispatch(record: Record<string, unknown>, state: PiEventState): void {
    switch (record.type) {
      case 'message': {
        const message = isRecord(record.message) ? record.message : undefined
        if (!message) return
        switch (message.role) {
          case 'user': return this.handleUser(message, state)
          case 'assistant': return this.handleAssistant(message, state)
          case 'toolResult': return this.handleToolResult(message, state)
        }
        return
      }
      case 'compaction':
        return this.handleCompaction(record, state)
      case 'session_info':
        return this.handleSessionInfo(record, state)
    }
  }

  // ─── Orchestrator lifecycle ──────────────────────────────────────────────

  private ensureSpawned(state: PiEventState): void {
    if (state.spawnEmitted) return
    state.spawnEmitted = true
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: 'Pi session', runtime: 'pi' },
    })
  }

  private setLabel(state: PiEventState, label: string, fromName: boolean): void {
    if (label === state.label) return
    state.label = label
    state.labelFromName = fromName
    this.delegate.setLabel?.(label)
  }

  // ─── Messages ────────────────────────────────────────────────────────────

  private emitMessage(role: 'user' | 'assistant' | 'thinking', text: string): void {
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
    })
  }

  private handleUser(message: Record<string, unknown>, state: PiEventState): void {
    const text = textOf(message.content).trim()
    if (!text) return
    this.ensureSpawned(state)
    if (!state.label) this.setLabel(state, text.slice(0, PREVIEW_MAX), false)
    this.emitMessage('user', text)
  }

  private handleAssistant(message: Record<string, unknown>, state: PiEventState): void {
    this.ensureSpawned(state)
    const model = str(message.model)
    if (model && model !== state.model) {
      state.model = model
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'model_detected',
        payload: { agent: ORCHESTRATOR_NAME, model },
      })
    }

    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === 'thinking') {
        // A redacted block keeps no readable text: nothing to show
        const text = str(block.thinking)?.trim()
        if (text) this.emitMessage('thinking', text)
      } else if (block.type === 'text') {
        const text = str(block.text)?.trim()
        if (text) this.emitMessage('assistant', text)
      } else if (block.type === 'toolCall') {
        this.handleToolCall(block, state)
      }
    }
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  private handleToolCall(block: Record<string, unknown>, state: PiEventState): void {
    const callId = idStr(block.id)
    if (!callId) return
    // A call id seen twice is a replay of the same call, not a second call
    if (state.pendingToolCalls.has(callId)) { this.normalizer.stats.duplicateEvents++; return }

    const name = str(block.name)?.slice(0, NORM_ID_MAX) ?? 'unknown'
    const args = isRecord(block.arguments) ? block.arguments : {}
    const view = summarizerView(name, args)
    const argsSummary = summarizeInput(view.tool, view.input)

    if (state.pendingToolCalls.size >= SEEN_MAX) {
      const oldest = state.pendingToolCalls.keys().next().value
      if (oldest !== undefined) state.pendingToolCalls.delete(oldest)
    }
    state.pendingToolCalls.set(callId, { name, filePath: extractFilePath(view.input)?.slice(0, 4096) })

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(view.tool, view.input),
        toolUseId: callId,
      },
    })
  }

  private handleToolResult(message: Record<string, unknown>, state: PiEventState): void {
    const callId = idStr(message.toolCallId)
    if (!callId) return
    const pending = state.pendingToolCalls.get(callId)
    if (!pending) return
    state.pendingToolCalls.delete(callId)

    const output = textOf(message.content)
    const resultSummary = summarizeResult(output).slice(0, RESULT_MAX)
    // The file says whether the call failed: no guess from the output text
    const isError = message.isError === true
    const discovery = buildDiscovery(summarizerView(pending.name, {}).tool, pending.filePath, output)

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: ORCHESTRATOR_NAME,
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

  // ─── Session entries ─────────────────────────────────────────────────────

  private handleCompaction(record: Record<string, unknown>, state: PiEventState): void {
    this.ensureSpawned(state)
    const before = record.tokensBefore
    const preTokens = typeof before === 'number' && Number.isSafeInteger(before) && before > 0 ? before : undefined
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'context_compacted',
      payload: { agent: ORCHESTRATOR_NAME, ...(preTokens !== undefined ? { preTokens } : {}) },
    })
  }

  private handleSessionInfo(record: Record<string, unknown>, state: PiEventState): void {
    const name = str(record.name)?.trim()
    if (name) this.setLabel(state, name.slice(0, PREVIEW_MAX), true)
  }
}
