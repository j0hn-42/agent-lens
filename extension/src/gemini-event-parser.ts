/**
 * Parser for Gemini CLI chat files, `<gemini dir>/tmp/<project>/chats/session-<timestamp>-<id>.jsonl`.
 *
 * Format checked against the sources of google-gemini/gemini-cli (#238):
 * packages/core/src/services/chatRecordingService.ts and chatRecordingTypes.ts. The file is an
 * append-only log, one JSON record per line:
 *   - the first record is the metadata: `sessionId`, `projectHash`, `startTime`, `lastUpdated`
 *     (optional `kind`, `directories`). There is no working-directory field and no version field;
 *   - a message `{ id, timestamp, type, content, ... }`. The CLI appends the WHOLE message again each
 *     time it changes (tool call finished, tokens known), under the same `id`: the parser keeps what
 *     it already showed per message id and emits only what is new;
 *   - `{ $set: {...} }` updates metadata (`summary`, `lastUpdated`, ...);
 *   - `{ $patch: {...} }` edits earlier messages (`content`, tool call `result`, `removeIds`,
 *     `orderIds`);
 *   - `{ $rewindTo: "<message id>" }` drops that message and every later one.
 *
 * Handled (the rest is ignored, forward-compatible):
 *   user message      — a prompt (text parts); labels the session. Empty content, `/` and `?`
 *                       commands, `<session_context>` and `<hook_context>` are skipped, the same rule
 *                       as gemini-cli's isIgnoredUserContent
 *   gemini message    — `content` text, `thoughts` (subject and description), `toolCalls`; `model` is
 *                       the model that answered
 *   toolCalls         — start when first seen; end when `status` is `success`, `error` or `cancelled`
 *   $set.summary      — replaces the label
 *   $rewindTo / $patch.removeIds — the messages are forgotten (state only)
 *
 * Not shown, on purpose: tokens and cost (not read yet), info / error / warning messages, any
 * unknown message type. Sub-agent chat files (`kind: "subagent"`, under the parent's directory) are
 * not read, so no parent/child link is ever guessed: every event belongs to the orchestrator. A
 * rewound or patched message is not retracted: what was shown did happen.
 */

import * as crypto from 'crypto'
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

/** Project hash written in the metadata record: sha256 hex of the project root (gemini-cli
 *  utils/paths.ts getProjectHash). The directory name under tmp/ is NOT this hash any more (it is a
 *  registry short id), so matching goes through the metadata record, never the directory name. */
export function geminiProjectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex')
}

// ─── State ─────────────────────────────────────────────────────────────────

interface ShownMessage {
  textShown: boolean
  thoughtsShown: number
  /** Tool call ids started / ended for this message. */
  started: Set<string>
  ended: Set<string>
}

interface PendingGeminiToolCall {
  name: string
  filePath?: string
}

export interface GeminiEventState {
  sessionId: string | null
  projectHash: string | null
  /** Model of the last gemini message (emitted once per change). */
  model: string | null
  label: string | null
  labelFromSummary: boolean
  /** Messages already shown, by id, in file order (bounded). */
  messages: Map<string, ShownMessage>
  messageOrder: string[]
  pendingToolCalls: Map<string, PendingGeminiToolCall>
  spawnEmitted: boolean
}

export function createGeminiEventState(): GeminiEventState {
  return {
    sessionId: null,
    projectHash: null,
    model: null,
    label: null,
    labelFromSummary: false,
    messages: new Map(),
    messageOrder: [],
    pendingToolCalls: new Map(),
    spawnEmitted: false,
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface GeminiParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when the session label changes (first prompt, then the summary). */
  setLabel?(label: string): void
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Bound on remembered messages and pending tool calls per session. */
const SEEN_MAX = 5000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function idStr(v: unknown): string | undefined {
  const s = str(v)
  return s && s.length <= NORM_ID_MAX ? s : undefined
}

/** Text of a PartListUnion (string, part, or parts): text parts joined, the rest dropped. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join('\n')
  if (isRecord(content) && typeof content.text === 'string') return content.text
  return ''
}

/** Output of a tool call `result` (parts holding a functionResponse) or, failing that, nothing. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join('\n')
  if (!isRecord(result)) return ''
  if (typeof result.text === 'string') return result.text
  const fr = result.functionResponse
  if (isRecord(fr) && isRecord(fr.response)) {
    const r = fr.response
    for (const key of ['output', 'error', 'content']) {
      if (typeof r[key] === 'string') return r[key] as string
    }
  }
  return ''
}

/** gemini-cli tool names (tools/definitions/base-declarations.ts) mapped to the keys the shared
 *  summarizer reads, without renaming the tool shown in the UI. */
function summarizerView(name: string, args: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  switch (name) {
    case 'run_shell_command':
      return { tool: 'Bash', input: { command: args.command } }
    case 'read_file':
      return { tool: 'Read', input: { file_path: args.file_path } }
    case 'replace':
      return { tool: 'Edit', input: { file_path: args.file_path } }
    case 'write_file':
      return { tool: 'Write', input: { file_path: args.file_path } }
    case 'grep_search':
      return { tool: 'Grep', input: { pattern: args.pattern } }
    case 'glob':
      return { tool: 'Glob', input: { pattern: args.pattern } }
    case 'google_web_search':
      return { tool: 'WebSearch', input: { query: args.query } }
    default:
      return { tool: name, input: args }
  }
}

/** Same rule as gemini-cli's isIgnoredUserContent (utils/sessionUtils.ts). */
function isIgnoredUserText(trimmed: string): boolean {
  return trimmed.length === 0 || trimmed.startsWith('/') || trimmed.startsWith('?')
    || trimmed.startsWith('<session_context>') || trimmed.startsWith('<hook_context>')
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class GeminiEventParser {
  /** Input normalizer of this session (one parser per session): every emitted event goes through it. */
  readonly normalizer: SessionNormalizer
  private readonly delegate: GeminiParserDelegate

  constructor(rawDelegate: GeminiParserDelegate) {
    this.normalizer = new SessionNormalizer(undefined, { onTrailing: event => rawDelegate.emit(event) })
    this.delegate = {
      emit: event => { for (const out of this.normalizer.process(event)) rawDelegate.emit(out) },
      elapsed: () => rawDelegate.elapsed(),
      ...(rawDelegate.setLabel ? { setLabel: (label: string) => rawDelegate.setLabel?.(label) } : {}),
    }
  }

  /** Parse a single JSONL line. Silently skips unparseable/unknown lines. */
  processLine(line: string, state: GeminiEventState): void {
    const trimmed = line.trim()
    if (!trimmed) return

    const record = this.normalizer.parseLine(trimmed)
    if (!record) return

    try {
      if (isRecord(record.$set)) return this.handleSet(record.$set, state)
      if (typeof record.$rewindTo === 'string') return this.forgetFrom(record.$rewindTo, state)
      if (isRecord(record.$patch)) return this.handlePatch(record.$patch, state)
      if (typeof record.sessionId === 'string' && typeof record.projectHash === 'string' && record.id === undefined) {
        return this.handleHeader(record, state)
      }
      if (str(record.id) && !idStr(record.id)) { this.normalizer.noteMalformed(); return }
      if (idStr(record.id) && typeof record.type === 'string') this.handleMessage(record, state)
    } catch {
      // Untrusted input must never take the watcher down: count it and move on
      this.normalizer.noteMalformed()
    }
  }

  private handleHeader(record: Record<string, unknown>, state: GeminiEventState): void {
    // A metadata record is also written again when a session is resumed: the first one wins
    if (state.sessionId !== null) return
    state.sessionId = str(record.sessionId) ?? null
    state.projectHash = str(record.projectHash) ?? null
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  private handleSet(set: Record<string, unknown>, state: GeminiEventState): void {
    const summary = str(set.summary)?.trim()
    if (summary) this.setLabel(state, summary.slice(0, PREVIEW_MAX), true)
  }

  /** `$rewindTo`: that message and all the later ones are gone; an unknown id clears everything
   *  (what gemini-cli itself does). Nothing already shown is retracted. */
  private forgetFrom(id: string, state: GeminiEventState): void {
    const idx = state.messageOrder.indexOf(id)
    const removed = idx >= 0 ? state.messageOrder.splice(idx) : state.messageOrder.splice(0)
    for (const m of removed) state.messages.delete(m)
  }

  private handlePatch(patch: Record<string, unknown>, state: GeminiEventState): void {
    // `content` and tool call `result` edits change what the CLI sends back to the model, not what
    // was shown: ignored. Removal and order are state the next rewind depends on.
    if (Array.isArray(patch.removeIds)) {
      for (const rid of patch.removeIds) {
        if (typeof rid !== 'string') continue
        const idx = state.messageOrder.indexOf(rid)
        if (idx >= 0) state.messageOrder.splice(idx, 1)
        state.messages.delete(rid)
      }
    }
    if (Array.isArray(patch.orderIds)) {
      const ordered = patch.orderIds.filter((x): x is string => typeof x === 'string' && state.messages.has(x))
      const set = new Set(ordered)
      state.messageOrder = [...state.messageOrder.filter(x => !set.has(x)), ...ordered]
    }
  }

  // ─── Messages ────────────────────────────────────────────────────────────

  private ensureSpawned(state: GeminiEventState): void {
    if (state.spawnEmitted) return
    state.spawnEmitted = true
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: 'Gemini session', runtime: 'gemini' },
    })
  }

  private setLabel(state: GeminiEventState, label: string, fromSummary: boolean): void {
    if (label === state.label) return
    state.label = label
    state.labelFromSummary = fromSummary
    this.delegate.setLabel?.(label)
  }

  private emitMessage(role: 'user' | 'assistant' | 'thinking', text: string): void {
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
    })
  }

  /** The shown-state of a message; null once the message was refused (cap) is not possible: the
   *  oldest message is forgotten instead. */
  private track(id: string, state: GeminiEventState): ShownMessage {
    let shown = state.messages.get(id)
    if (shown) return shown
    shown = { textShown: false, thoughtsShown: 0, started: new Set(), ended: new Set() }
    if (state.messageOrder.length >= SEEN_MAX) {
      const oldest = state.messageOrder.shift()
      if (oldest !== undefined) state.messages.delete(oldest)
    }
    state.messages.set(id, shown)
    state.messageOrder.push(id)
    return shown
  }

  private handleMessage(record: Record<string, unknown>, state: GeminiEventState): void {
    const id = idStr(record.id)
    if (!id) return
    switch (record.type) {
      case 'user': return this.handleUser(id, record, state)
      case 'gemini': return this.handleGemini(id, record, state)
    }
  }

  private handleUser(id: string, record: Record<string, unknown>, state: GeminiEventState): void {
    const text = textOf(record.content).trim()
    if (isIgnoredUserText(text)) return
    const shown = this.track(id, state)
    if (shown.textShown) { this.normalizer.stats.duplicateEvents++; return }
    shown.textShown = true
    this.ensureSpawned(state)
    if (!state.label) this.setLabel(state, text.slice(0, PREVIEW_MAX), false)
    this.emitMessage('user', text)
  }

  private handleGemini(id: string, record: Record<string, unknown>, state: GeminiEventState): void {
    const shown = this.track(id, state)
    this.ensureSpawned(state)

    const model = str(record.model)
    if (model && model !== state.model) {
      state.model = model
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'model_detected',
        payload: { agent: ORCHESTRATOR_NAME, model },
      })
    }

    if (Array.isArray(record.thoughts)) {
      for (let i = shown.thoughtsShown; i < record.thoughts.length; i++) {
        const t = record.thoughts[i]
        if (!isRecord(t)) continue
        const subject = str(t.subject)?.trim()
        const description = str(t.description)?.trim()
        const text = subject && description ? `${subject}: ${description}` : (description ?? subject)
        if (text) this.emitMessage('thinking', text)
      }
      shown.thoughtsShown = Math.max(shown.thoughtsShown, record.thoughts.length)
    }

    const text = textOf(record.content).trim()
    if (text && !shown.textShown) {
      shown.textShown = true
      this.emitMessage('assistant', text)
    }

    if (Array.isArray(record.toolCalls)) {
      for (const tc of record.toolCalls) {
        if (isRecord(tc)) this.handleToolCall(tc, shown, state)
      }
    }
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  private handleToolCall(tc: Record<string, unknown>, shown: ShownMessage, state: GeminiEventState): void {
    const callId = idStr(tc.id)
    if (!callId) return

    if (!shown.started.has(callId)) {
      shown.started.add(callId)
      const name = str(tc.name)?.slice(0, NORM_ID_MAX) ?? 'unknown'
      const args = isRecord(tc.args) ? tc.args : {}
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

    // Only the status written in the file ends a call: a result alone does not
    const status = tc.status
    if (status !== 'success' && status !== 'error' && status !== 'cancelled') return
    if (shown.ended.has(callId)) return
    shown.ended.add(callId)
    const pending = state.pendingToolCalls.get(callId)
    state.pendingToolCalls.delete(callId)
    const name = pending?.name ?? str(tc.name)?.slice(0, NORM_ID_MAX) ?? 'unknown'

    const output = resultText(tc.result)
    const resultSummary = summarizeResult(output || (status === 'cancelled' ? 'cancelled' : '')).slice(0, RESULT_MAX)
    const failed = status !== 'success'
    const discovery = buildDiscovery(summarizerView(name, {}).tool, pending?.filePath, output)

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: name,
        result: resultSummary,
        tokenCost: estimateTokenCost(name, output),
        tokenSource: 'estimated',
        toolUseId: callId,
        ...(failed ? { isError: true, errorMessage: resultSummary } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })
  }
}
