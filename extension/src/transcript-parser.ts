/**
 * Transcript parsing logic extracted from SessionWatcher.
 *
 * Parses JSONL transcript lines and emits AgentEvents via a delegate,
 * keeping the parsing logic decoupled from file-watching concerns.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  AgentEvent, PendingToolCall, WatchedSession,
  TranscriptEntry, ToolUseBlock, ToolResultBlock,
  emitSubagentSpawn,
} from './protocol'
import { readFileChunk } from './fs-utils'
import {
  PREVIEW_MAX, ARGS_MAX, RESULT_MAX, MESSAGE_MAX,
  SESSION_LABEL_MAX, SESSION_LABEL_TRUNCATED,
  CHILD_NAME_MAX,
  HASH_PREFIX_MAX,
  HOOK_MAX_SESSIONS, NORM_ID_MAX,
  TEAM_MAX_LINKS_PER_SESSION,
  SUBAGENT_TRANSCRIPT_TAIL_BYTES,
  ORCHESTRATOR_NAME,
  FAILED_RESULT_MAX,
  SYSTEM_CONTENT_PREFIXES,
  generateSubagentFallbackName,
  resolveSubagentChildName,
} from './constants'
import { summarizeInput, summarizeResult, extractInputData, detectError, buildDiscovery } from './tool-summarizer'
import { estimateTokensFromContent, estimateTokensFromText } from './token-estimator'
import { SubagentRegistry } from './subagent-registry'
import { SessionNormalizer, CountersRegistry, sharedCounters, ostr } from './event-normalize'
import {
  buildLinkId, extractToolUseLinks, parseTeamNotifications, isTeamNotification, sanitizeAgentName, sanitizeMessageContent,
  MessageDeduper, type TeamLinkEvents,
} from './team-links'
import { sanitizeTeamField, parseTeammateSpawnResult, type TeammateSpawnResult } from './teammate'
import { createLogger } from './logger'

const log = createLogger('TranscriptParser')

export interface TranscriptParserDelegate {
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
  getSession(sessionId: string): WatchedSession | undefined
  fireSessionLifecycle(event: { type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }): void
  emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string): void
}

/** Type guard: check if a value is a non-null object */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/**
 * A tool_use block with a usable shape: string id and name (bounded, control characters stripped)
 * and an object input (arrays and primitives become {}). Anything without an id is rejected.
 */
export function coerceToolUseBlock(block: Record<string, unknown>): ToolUseBlock | null {
  const id = ostr(block.id, NORM_ID_MAX)
  if (!id) return null
  const name = ostr(block.name, NORM_ID_MAX) || 'unknown'
  const input = isRecord(block.input) && !Array.isArray(block.input) ? block.input : {}
  return { type: 'tool_use', id, name, input }
}

/** Safely extract trimmed text from a text block */
function safeText(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.text || '').trim()
}

/** Safely extract trimmed thinking content from a thinking block */
function safeThinking(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.thinking || '').trim()
}

/** Returns the signature string if a thinking block is redacted
 *  (plaintext stripped but signature present, as Opus 4.7+ does), else null. */
function redactedThinkingSignature(block: unknown): string | null {
  if (!isRecord(block)) return null
  if (String(block.thinking || '').trim()) return null
  const sig = block.signature
  return typeof sig === 'string' && sig.length > 0 ? sig : null
}

/** Build the dedup hash key for a thinking block. Prefers the transcript entry
 *  UUID; falls back to a prefix of the content (or signature, for redacted blocks). */
function thinkingHashKey(entryUuid: string | undefined, fallbackSource: string): string {
  return entryUuid
    ? `thinking:${entryUuid}`
    : `thinking:${fallbackSource.slice(0, HASH_PREFIX_MAX)}`
}

/** Placeholder shown for redacted thinking blocks (matches Claude Code's UI label). */
const REDACTED_THINKING_LABEL = 'Thinking...'

const PRESCAN_KEEP_HEAD = 50
const PRESCAN_KEEP_TAIL = 400
const PRESCAN_CHUNK_BYTES = 4 * 1024 * 1024

/** Yield the lines of the first `size` bytes of a file, reading PRESCAN_CHUNK_BYTES at a time. */
export function* readLinesChunked(filePath: string, size: number, chunkBytes = PRESCAN_CHUNK_BYTES): Generator<string> {
  const fd = fs.openSync(filePath, 'r')
  try {
    let offset = 0
    let carry: Buffer = Buffer.alloc(0)
    while (offset < size) {
      const len = Math.min(chunkBytes, size - offset)
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, offset)
      if (n <= 0) break
      offset += n
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const cut = data.lastIndexOf(0x0a)
      if (cut < 0) { carry = Buffer.from(data); continue }
      carry = Buffer.from(data.subarray(cut + 1))
      data = data.subarray(0, cut)
      for (const line of data.toString('utf-8').split(/\r?\n/)) yield line
    }
    if (carry.length) yield carry.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Claude Code's text for a tool call the user interrupted (Esc / cancel) */
const INTERRUPTED_RESULT = /^\[Request interrupted by user/i

export class TranscriptParser {
  /** Per-subagent dedup state for inline progress events, keyed by parentToolUseID */
  private inlineSubagentState = new Map<string, {
    agentName: string
    pending: Map<string, PendingToolCall>
    seen: Set<string>
    seenMessages: Set<string>
  }>()
  /** Maps Agent tool_use ID → resolved child agent name (set in handleToolUse) */
  private subagentChildNames = new Map<string, string>()

  /** Per-session subagent registries (identity by tool_use_id, unique names) */
  private registries = new Map<string, SubagentRegistry>()

  /** Per-session agent_link ids already emitted (bounded) — one link event per edge */
  private emittedLinks = new Map<string, Set<string>>()

  /** Per-session message dedupe across SendMessage tool_use, <teammate-message> echo and inbox files */
  private deduppers = new Map<string, MessageDeduper>()

  /** Per-session names that denote the lead (they are drawn as the orchestrator node) */
  private leadAliases = new Map<string, Set<string>>()

  /** tool_use ids of Agent calls that spawned a teammate: their (immediate) result must not complete the node */
  private teammateSpawnIds = new Set<string>()

  /** Per-session input normalizers (bounded, oldest evicted): every emitted event goes through one. */
  private normalizers = new Map<string, SessionNormalizer>()

  /** The delegate seen by the parser: same callbacks, but `emit` normalizes first. */
  private readonly delegate: TranscriptParserDelegate

  /**
   * `counters` is shared with the other producers of the same session (the hook server): the
   * stats event of a session then carries the merged totals, whoever emits it.
   */
  constructor(
    private readonly rawDelegate: TranscriptParserDelegate,
    private readonly counters: CountersRegistry = sharedCounters,
  ) {
    this.delegate = {
      emit: (event, sessionId) => this.emitNormalized(event, sessionId),
      elapsed: sessionId => rawDelegate.elapsed(sessionId),
      getSession: sessionId => rawDelegate.getSession(sessionId),
      fireSessionLifecycle: event => rawDelegate.fireSessionLifecycle(event),
      emitContextUpdate: (agentName, session, sessionId) => rawDelegate.emitContextUpdate(agentName, session, sessionId),
    }
  }

  /** Normalizer (and its counters) of a session; created on first use. */
  getNormalizer(sessionId?: string): SessionNormalizer {
    const key = sessionId ?? ''
    let n = this.normalizers.get(key)
    if (n) {
      this.normalizers.delete(key)
    } else {
      if (this.normalizers.size >= HOOK_MAX_SESSIONS) {
        const oldest = this.normalizers.keys().next().value
        if (oldest !== undefined) { this.normalizers.get(oldest)?.dispose(); this.normalizers.delete(oldest) }
      }
      n = new SessionNormalizer(sessionId, {
        onTrailing: event => this.rawDelegate.emit(event, sessionId),
        ...(sessionId ? { counters: this.counters.get(sessionId) } : {}),
      })
    }
    this.normalizers.set(key, n)
    return n
  }

  private emitNormalized(event: AgentEvent, sessionId?: string): void {
    for (const out of this.getNormalizer(sessionId ?? event.sessionId).process(event)) {
      this.rawDelegate.emit(out, sessionId)
    }
  }

  /** Declare the lead's team name for a session (e.g. 'team-lead'); it maps to the orchestrator node. */
  setLeadAlias(sessionId: string, name: string): void {
    const clean = sanitizeAgentName(name)
    if (!clean || clean === ORCHESTRATOR_NAME) return
    let set = this.leadAliases.get(sessionId)
    if (!set) { set = new Set(); this.leadAliases.set(sessionId, set) }
    if (set.size < 8) set.add(clean)
  }

  private canonicalName(sessionId: string, name: string): string {
    if (name === 'team-lead' || this.leadAliases.get(sessionId)?.has(name)) return ORCHESTRATOR_NAME
    return name
  }

  /** A message read from ~/.claude/teams/<team>/inboxes: same edge/message pipeline as transcripts, source 'inbox'. */
  emitInboxMessage(sessionId: string, from: string, to: string, content: string): void {
    const f = sanitizeAgentName(from)
    const t = sanitizeAgentName(to)
    const text = sanitizeMessageContent(content)
    if (!f || !t || !text || f === t) return
    this.emitTeamEvents({
      link: { from: f, to: t, kind: 'teammate', linkId: buildLinkId('teammate', f, t) },
      message: { from: f, to: t, linkId: buildLinkId('teammate', f, t), content: text, source: 'inbox' },
    }, sessionId)
  }

  /** Emit agent_link (once per edge per session) and message_sent for a tool use or notification. */
  private emitTeamEvents(events: TeamLinkEvents, sessionId?: string): void {
    const sid = sessionId ?? ''
    let seen = this.emittedLinks.get(sid)
    if (!seen) { seen = new Set(); this.emittedLinks.set(sid, seen) }
    let { link, message } = events
    // The lead is drawn as the orchestrator: team-lead / lead name -> orchestrator, edges follow
    const from = this.canonicalName(sid, link.from)
    const to = this.canonicalName(sid, link.to)
    if (from === to) return
    if (from !== link.from || to !== link.to) {
      const linkId = buildLinkId(link.kind, from, to)
      link = { ...link, from, to, linkId }
      if (message) message = { ...message, from, to, linkId }
    }
    if (!seen.has(link.linkId)) {
      if (seen.size >= TEAM_MAX_LINKS_PER_SESSION) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      seen.add(link.linkId)
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'agent_link',
        payload: { ...link, sessionId: sid },
      }, sessionId)
    }
    if (message) {
      let dedupe = this.deduppers.get(sid)
      if (!dedupe) { dedupe = new MessageDeduper(); this.deduppers.set(sid, dedupe) }
      if (!dedupe.accept(link.linkId, message.content)) return
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'message_sent',
        payload: { ...message, sessionId: sid },
      }, sessionId)
    }
  }

  /** Incoming <teammate-message>/<task-notification> turns become message_sent events
   *  (never `message` events, and never the session/agent display name). */
  private handleTeamNotifications(
    text: string,
    toAgent: string,
    entryUuid: string | undefined,
    seenMsgs: Set<string> | undefined,
    sessionId?: string,
  ): void {
    if (!isTeamNotification(text)) return
    const hash = entryUuid ? `notif:${entryUuid}` : `notif:${text.slice(0, HASH_PREFIX_MAX)}`
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)
    for (const n of parseTeamNotifications(text)) {
      const linkId = buildLinkId('teammate', n.from, toAgent)
      this.emitTeamEvents({
        link: { from: n.from, to: toAgent, kind: 'teammate', linkId },
        message: { from: n.from, to: toAgent, linkId, content: n.content },
      }, sessionId)
    }
  }

  /** Subagent registry for a session (created on demand). */
  getSubagentRegistry(sessionId?: string): SubagentRegistry {
    const key = sessionId ?? ''
    let registry = this.registries.get(key)
    if (!registry) {
      registry = new SubagentRegistry()
      this.registries.set(key, registry)
    }
    return registry
  }

  /** Clean up state associated with a completed session to prevent unbounded Map growth.
   *  Pass the session's pending tool_use_ids so we can remove orphaned entries. */
  clearSessionState(pendingToolUseIds: Iterable<string>, sessionId?: string): void {
    if (sessionId !== undefined) {
      this.registries.delete(sessionId)
      this.emittedLinks.delete(sessionId)
      this.deduppers.delete(sessionId)
      this.leadAliases.delete(sessionId)
      this.normalizers.get(sessionId)?.dispose()
      this.normalizers.delete(sessionId)
    }
    for (const toolUseId of pendingToolUseIds) {
      this.inlineSubagentState.delete(toolUseId)
      this.subagentChildNames.delete(toolUseId)
      this.teammateSpawnIds.delete(toolUseId)
    }
  }

  processTranscriptLine(
    line: string,
    agentName = ORCHESTRATOR_NAME,
    ctxPending: Map<string, PendingToolCall>,
    ctxSeen: Set<string>,
    sessionId?: string,
    ctxSeenMessages?: Set<string>,
  ): void {
    try {
      this.parseTranscriptLine(line, agentName, ctxPending, ctxSeen, sessionId, ctxSeenMessages)
    } catch (err) {
      // Untrusted input must never take the watcher down: count it and move on
      this.getNormalizer(sessionId).noteMalformed()
      log.debug('Skipping line that failed to parse:', err)
    }
  }

  private parseTranscriptLine(
    line: string,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    ctxSeen: Set<string>,
    sessionId?: string,
    ctxSeenMessages?: Set<string>,
  ): void {
    const norm = this.getNormalizer(sessionId)
    const parsed = norm.parseLine(line)
    if (!parsed) return
    norm.noteAgent(agentName)

    // Handle inline subagent progress events (newer Claude Code versions)
    if (parsed.type === 'progress') {
      this.handleProgressEvent(parsed, sessionId)
      return
    }

    // Only process actual conversation entries (user/assistant turns)
    if (parsed.type !== 'user' && parsed.type !== 'assistant') {
      return
    }

    const msg = parsed.message as TranscriptEntry['message'] | undefined
    if (!isRecord(msg)) { norm.noteMalformed(); return }

    // Now we know this is a valid transcript entry
    const entry: TranscriptEntry = {
      sessionId: parsed.sessionId as string,
      type: parsed.type as string,
      uuid: parsed.uuid as string | undefined,
      message: msg,
    }

    // Try to set session label from first user message (for live events after session start)
    if (sessionId) {
      this.maybeSetSessionLabel(entry, sessionId)
    }

    const role = msg.role // 'assistant', 'user', 'human'

    const session = sessionId ? this.delegate.getSession(sessionId) : undefined

    // Extract model from assistant messages (updates tokensMax on the frontend).
    // Per-agent tracking: re-emit when the model changes (e.g. /model switch).
    if (session && entry.type === 'assistant' && msg.model && session.modelDetectedAgents.get(agentName) !== msg.model) {
      session.modelDetectedAgents.set(agentName, msg.model)
      if (!session.model) session.model = msg.model
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'model_detected',
        payload: { agent: agentName, model: msg.model },
      }, sessionId)
    }

    // Dedup set for messages (context compression replays old messages)
    const seenMsgs = ctxSeenMessages ?? session?.seenMessageHashes

    // Handle string content (user messages are often just strings)
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (role === 'user' || role === 'human') {
        const text = msg.content.trim()
        this.handleTeamNotifications(text, agentName, entry.uuid, seenMsgs, sessionId)
        // Skip system-injected context (continuation summaries, IDE context, etc.)
        if (!this.isSystemInjectedContent(text)) {
          const hash = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
          if (seenMsgs && seenMsgs.has(hash)) { /* skip duplicate */ }
          else {
            seenMsgs?.add(hash)
            if (session) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
            this.delegate.emit({
              time: this.delegate.elapsed(sessionId),
              type: 'message',
              payload: { agent: agentName, role: 'user', content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
      return
    }

    if (!Array.isArray(msg.content)) { return }

    // Determine the emitted role from the JSONL entry role
    const emitRole = (role === 'user' || role === 'human') ? 'user' : 'assistant'

    for (const block of msg.content) {
      if (!isRecord(block)) { norm.noteMalformed(); continue }
      if (block.type === 'tool_use') {
        const toolBlock = coerceToolUseBlock(block)
        if (!toolBlock) { norm.noteMalformed(); continue }
        if (ctxSeen.has(toolBlock.id)) { continue }
        ctxSeen.add(toolBlock.id)
        this.handleToolUse(toolBlock, agentName, ctxPending, sessionId)
      } else if (block.type === 'tool_result') {
        if (typeof block.tool_use_id !== 'string') { norm.noteMalformed(); continue }
        this.handleToolResult(block as unknown as ToolResultBlock, agentName, ctxPending, sessionId, parsed.toolUseResult)
      } else if (block.type === 'text' && 'text' in block) {
        this.handleTextBlock(block, emitRole, entry.uuid, agentName, seenMsgs, session, sessionId)
      } else if (block.type === 'thinking' && 'thinking' in block) {
        this.handleThinkingBlock(block, entry.uuid, agentName, seenMsgs, session, sessionId)
      }
    }

    if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
  }

  /** Process a text block — dedup, track tokens, emit message event */
  private handleTextBlock(
    block: unknown,
    emitRole: 'user' | 'assistant',
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const text = safeText(block)
    if (!text) return
    if (emitRole === 'user') this.handleTeamNotifications(text, agentName, entryUuid, seenMsgs, sessionId)
    // Skip system/IDE context injected into user turns
    if (emitRole === 'user' && this.isSystemInjectedContent(text)) return

    const hash = entryUuid ? `${emitRole}:${entryUuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    if (session) {
      if (emitRole === 'user') { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
      else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
    }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: { agent: agentName, role: emitRole, content: text.slice(0, MESSAGE_MAX) },
    }, sessionId)
  }

  /** Process a thinking block — dedup, track tokens, emit message event.
   *  Redacted thinking (Opus 4.7+) is shown as a "Thinking..." placeholder. */
  private handleThinkingBlock(
    block: unknown,
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const thinking = safeThinking(block)
    const redactedSig = thinking ? null : redactedThinkingSignature(block)
    if (!thinking && !redactedSig) return

    const hash = thinkingHashKey(entryUuid, thinking || redactedSig || '')
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    // Reasoning tokens are unknown for redacted blocks — skip breakdown update
    if (session && thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: {
        agent: agentName,
        role: 'thinking',
        content: thinking ? thinking.slice(0, MESSAGE_MAX) : REDACTED_THINKING_LABEL,
      },
    }, sessionId)
  }

  handleToolUse(
    block: ToolUseBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
  ): void {
    const toolName = block.name
    const args = summarizeInput(toolName, block.input)

    const rawPath = block.input.file_path || block.input.path
    const filePath = typeof rawPath === 'string' ? rawPath : undefined
    ctxPending.set(block.id, {
      name: toolName,
      args,
      filePath,
      startTime: Date.now(),
    })

    // Check if this is a subagent call (Task in older Claude Code, Agent in newer versions)
    if (toolName === 'Task' || toolName === 'Agent') {
      const label = resolveSubagentChildName(block.input)
      // Identity is the tool_use id; the description is only a label, so two
      // parallel subagents with the same description stay two distinct agents.
      const record = this.getSubagentRegistry(sessionId).registerDispatch(block.id, label, agentName)
      const childName = record.name
      this.subagentChildNames.set(block.id, childName)
      // Only emit spawn once per subagent (file watcher may have already spawned it)
      const session = sessionId ? this.delegate.getSession(sessionId) : undefined
      if (!record.spawned) {
        record.spawned = true
        session?.spawnedSubagents.add(childName)
        const inputData = extractInputData(toolName, block.input)
        const teamName = sanitizeTeamField(block.input.team_name)
        emitSubagentSpawn(this.delegate, agentName, childName, args, sessionId, {
          label,
          prompt: typeof inputData?.prompt === 'string' ? inputData.prompt : undefined,
          subagentType: typeof inputData?.subagent_type === 'string' ? inputData.subagent_type : undefined,
          model: typeof inputData?.model === 'string' ? inputData.model : undefined,
          toolUseId: block.id,
        }, teamName ? {
          kind: 'teammate',
          teamName,
          ...(sanitizeTeamField(block.input.subagent_type) ? { agentType: sanitizeTeamField(block.input.subagent_type) } : {}),
        } : undefined)
      }
      if (sanitizeTeamField(block.input.team_name) && label === String(block.input.name ?? '').trim().slice(0, CHILD_NAME_MAX)) {
        if (this.teammateSpawnIds.size >= 256) this.teammateSpawnIds.clear()
        this.teammateSpawnIds.add(block.id)
      }
      const links = extractToolUseLinks(toolName, block.input, agentName, block.id, childName)
      if (links) this.emitTeamEvents(links, sessionId)
    } else if (toolName === 'SendMessage') {
      const links = extractToolUseLinks(toolName, block.input, agentName, block.id)
      if (links) this.emitTeamEvents(links, sessionId)
    } else if (toolName === 'TeamCreate') {
      // The config watcher sends the full roster; this announces the team as soon as it is created
      const teamName = sanitizeTeamField(block.input.team_name ?? block.input.name)
      if (teamName && sessionId) {
        this.delegate.emit({
          time: this.delegate.elapsed(sessionId),
          type: 'team_info',
          payload: { teamName, leadSessionId: sessionId, members: [] },
        }, sessionId)
      }
    }

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(toolName, block.input),
        toolUseId: block.id,
      },
    }, sessionId)
  }

  /** The dispatch node already exists (named after the call's `name`): flag it as a teammate. One node, no ghost. */
  private upgradeToTeammate(toolUseId: string, parent: string, spawn: TeammateSpawnResult, sessionId?: string): void {
    const record = this.getSubagentRegistry(sessionId).getByToolUseId(toolUseId)
    const childName = this.subagentChildNames.get(toolUseId) ?? record?.name
    if (!childName) return
    if (record && spawn.agentId) this.getSubagentRegistry(sessionId).bindFileKey(record, spawn.agentId)
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'agent_spawn',
      payload: {
        name: childName, parent, task: childName, label: childName, toolUseId,
        kind: 'teammate', teamName: spawn.teamName, backendType: 'in-process',
        ...(spawn.color ? { color: spawn.color } : {}),
        ...(spawn.agentType ? { agentType: spawn.agentType } : {}),
        ...(spawn.model ? { model: spawn.model, modelSource: 'configured' } : {}),
      },
    }, sessionId)
  }

  handleToolResult(
    block: ToolResultBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
    /** Entry-level `toolUseResult` (structured result); carries team_name/name/color for teammate spawns */
    toolUseResult?: unknown,
  ): void {
    const pending = ctxPending.get(block.tool_use_id)
    // Skip orphaned tool_results (their tool_use was deduped during catch-up)
    if (!pending) { return }
    const toolName = pending.name
    const isSubagentTool = toolName === 'Task' || toolName === 'Agent'
    // Subagent reports are kept up to MESSAGE_MAX so the full report can be shown
    const result = summarizeResult(block.content, isSubagentTool ? MESSAGE_MAX : RESULT_MAX)
    const tokenCost = estimateTokensFromContent(block.content)

    // Update context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) {
        if (toolName === 'Task' || toolName === 'Agent') {
          session.contextBreakdown.subagentResults += tokenCost
        } else {
          session.contextBreakdown.toolResults += tokenCost
        }
      }
    }

    ctxPending.delete(block.tool_use_id)

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, pending?.filePath || '', result)

    // Errors: the structured is_error flag is authoritative. Free-text heuristics only
    // run for ordinary tools — a subagent report is prose that may legitimately
    // contain words like "failed" or "not found".
    const isError = block.is_error === true || (!isSubagentTool && detectError(result))
    const errorMessage = isError ? result.slice(0, FAILED_RESULT_MAX) : undefined

    // A teammate spawn returns immediately ("spawned"): the teammate keeps living, so it neither
    // returns nor completes here.
    const teamSpawn = isSubagentTool ? parseTeammateSpawnResult(toolUseResult) : null
    const spawnedTeammate = isSubagentTool && (this.teammateSpawnIds.delete(block.tool_use_id) || !!teamSpawn)
    if (spawnedTeammate && teamSpawn) this.upgradeToTeammate(block.tool_use_id, agentName, teamSpawn, sessionId)
    if (spawnedTeammate) {
      this.subagentChildNames.delete(block.tool_use_id)
      this.inlineSubagentState.delete(block.tool_use_id)
    }

    // If it was a subagent call completing, emit subagent return
    if (isSubagentTool && !spawnedTeammate) {
      const childName = this.subagentChildNames.get(block.tool_use_id) || pending?.args?.slice(0, CHILD_NAME_MAX) || 'subagent'
      // Clean up inline subagent tracking state
      this.subagentChildNames.delete(block.tool_use_id)
      this.inlineSubagentState.delete(block.tool_use_id)
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'subagent_return',
        payload: {
          child: childName,
          parent: agentName,
          summary: result.slice(0, MESSAGE_MAX),
          toolUseId: block.tool_use_id,
          isError,
          durationS: Math.round((Date.now() - pending.startTime) / 100) / 10,
          tokenCost,
        },
      }, sessionId)
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: childName },
      }, sessionId)
    }

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, isSubagentTool ? MESSAGE_MAX : RESULT_MAX),
        tokenCost,
        tokenSource: 'estimated',
        toolUseId: block.tool_use_id,
        ...(discovery ? { discovery } : {}),
        ...(isError ? { isError, errorMessage } : {}),
        ...(isError && INTERRUPTED_RESULT.test(result) ? { outcome: 'cancelled' } : {}),
      },
    }, sessionId)

    // Emit updated context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
    }
  }

  /**
   * Handle inline progress events from newer Claude Code versions.
   * These carry subagent transcript entries directly in the main JSONL,
   * keyed by parentToolUseID (the Agent tool_use that spawned the subagent).
   */
  private handleProgressEvent(
    parsed: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const data = parsed.data
    if (!isRecord(data) || data.type !== 'agent_progress') { return }

    const innerEntry = data.message as TranscriptEntry | undefined
    if (!innerEntry?.message) { return }

    const parentToolUseID = typeof parsed.parentToolUseID === 'string' ? parsed.parentToolUseID : undefined
    if (!parentToolUseID) { return }

    // Get or create per-subagent dedup state
    let subState = this.inlineSubagentState.get(parentToolUseID)
    if (!subState) {
      // Resolve agent name from the stored child name (set when the Agent tool_use was parsed)
      const childName = this.subagentChildNames.get(parentToolUseID) || generateSubagentFallbackName('', this.inlineSubagentState.size + 1)
      subState = {
        agentName: childName,
        pending: new Map(),
        seen: new Set(),
        seenMessages: new Set(),
      }
      this.inlineSubagentState.set(parentToolUseID, subState)

      // Mark this subagent as receiving inline progress — file watcher should skip events
      if (sessionId) {
        const session = this.delegate.getSession(sessionId)
        session?.inlineProgressAgents.add(childName)
      }
    }

    // Re-wrap as a JSONL line and process through the normal pipeline
    const innerLine = JSON.stringify(innerEntry)
    this.processTranscriptLine(innerLine, subState.agentName, subState.pending, subState.seen, sessionId, subState.seenMessages)
  }

  /**
   * Pre-scan existing file content:
   * 1. Build seenToolUseIds dedup set (prevents re-emitting old tool calls)
   * 2. Return all entries for catch-up emission
   */
  prescanExistingContent(filePath: string, size: number, session: WatchedSession): TranscriptEntry[] {
    if (size === 0) { return [] }
    const catchUpEntries: TranscriptEntry[] = []
    try {
      // Read only up to `size` bytes — the file may have grown since stat.
      // Reading beyond would add tool_use IDs to the dedup set that haven't
      // been accounted for in fileSize, causing readNewLines to silently skip them.
      // Streamed in bounded chunks: a multi-hundred-MB lead transcript is never held in memory at once.
      const norm = this.getNormalizer(session.sessionId)
      for (const line of readLinesChunked(filePath, size)) {
        if (!line.trim()) { continue }
        try {
          const parsedEntry = norm.parseLine(line)
          if (!parsedEntry) { continue }
          const entry = parsedEntry as unknown as TranscriptEntry
          // Build dedup sets for tool_use blocks and messages + accumulate token counts
          const isUser = entry.message?.role === 'user' || entry.message?.role === 'human'
          if (entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && (block as ToolUseBlock).id) {
                const toolBlock = block as ToolUseBlock
                session.seenToolUseIds.add(toolBlock.id)
                // Track subagent names so startWatchingSubagentFile assigns correct names
                // and handleToolResult can resolve the child name on completion
                if (toolBlock.name === 'Agent' || toolBlock.name === 'Task') {
                  const record = this.getSubagentRegistry(session.sessionId)
                    .registerDispatch(toolBlock.id, resolveSubagentChildName(toolBlock.input), ORCHESTRATOR_NAME)
                  record.spawned = true
                  session.spawnedSubagents.add(record.name)
                  this.subagentChildNames.set(toolBlock.id, record.name)
                  if (sanitizeTeamField(toolBlock.input?.team_name) && this.teammateSpawnIds.size < 256) {
                    this.teammateSpawnIds.add(toolBlock.id)
                  }
                }
                // Track pending tool calls so handleToolResult works after reconnect
                const args = summarizeInput(toolBlock.name, toolBlock.input)
                const rawPath = toolBlock.input.file_path || toolBlock.input.path
                const filePath = typeof rawPath === 'string' ? rawPath : undefined
                session.pendingToolCalls.set(toolBlock.id, { name: toolBlock.name, args, filePath, startTime: Date.now() })
              } else if (block.type === 'tool_result') {
                const resultBlock = block as ToolResultBlock
                // Clear matched pending tool call
                if (resultBlock.tool_use_id) {
                  session.pendingToolCalls.delete(resultBlock.tool_use_id)
                }
                // Accumulate tool result tokens
                session.contextBreakdown.toolResults += estimateTokensFromContent(resultBlock.content)
              } else if (block.type === 'text' && 'text' in block) {
                const text = safeText(block)
                if (text) {
                  const emitRole = isUser ? 'user' : 'assistant'
                  const hashKey = entry.uuid ? `${emitRole}:${entry.uuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
                  session.seenMessageHashes.add(hashKey)
                  // Accumulate text tokens
                  if (isUser) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
                  else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
                }
              } else if (block.type === 'thinking' && 'thinking' in block) {
                const thinking = safeThinking(block)
                const redactedSig = thinking ? null : redactedThinkingSignature(block)
                if (thinking || redactedSig) {
                  session.seenMessageHashes.add(thinkingHashKey(entry.uuid, thinking || redactedSig || ''))
                  if (thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
                }
              }
            }
          } else if (entry.type === 'user' && typeof entry.message?.content === 'string') {
            const text = entry.message.content.trim()
            if (text) {
              const hashKey = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
              session.seenMessageHashes.add(hashKey)
              session.contextBreakdown.userMessages += estimateTokensFromText(text)
            }
          }
          // Extract model from first assistant message
          if (entry.type === 'assistant' && entry.message?.model && !session.model) {
            session.model = entry.message.model
          }
          // Collect emittable entries (user and assistant turns)
          if (entry.type === 'user' || entry.type === 'assistant') {
            catchUpEntries.push(entry)
            // Only the head (session label) and the recent tail (current turn) are needed for catch-up
            if (catchUpEntries.length > PRESCAN_KEEP_HEAD + PRESCAN_KEEP_TAIL) catchUpEntries.splice(PRESCAN_KEEP_HEAD, 1)
          }
        } catch (err) { norm.noteMalformed(); log.debug('Skipping malformed transcript line:', err) }
      }
      log.info(`Pre-scanned ${session.seenToolUseIds.size} existing tool_use IDs, ${catchUpEntries.length} entries total`)

      return catchUpEntries
    } catch (err) {
      log.error('Pre-scan failed:', err)
      return []
    }
  }

  /** Emit message events for pre-existing transcript entries (catch-up on session detection).
   *  Only emits the last user message (the current turn), not the full history. */
  emitCatchUpEntries(entries: TranscriptEntry[], session: WatchedSession, sessionId: string): void {
    // Find the last user entry — that's the current turn
    let lastUserIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'user') { lastUserIndex = i; break }
    }
    if (lastUserIndex === -1) { return }
    const recentEntries = entries.slice(lastUserIndex)

    for (const entry of recentEntries) {
      const role = entry.type === 'user' ? 'user' : 'assistant'
      const msg = entry.message
      if (!msg) { continue }

      // String content (common for user messages)
      if (typeof msg.content === 'string' && msg.content.trim()) {
        const text = msg.content.trim()
        if (this.isSystemInjectedContent(text)) { continue }
        this.delegate.emit({
          time: 0,
          type: 'message',
          payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
        }, sessionId)
        continue
      }

      // Array content (text blocks, thinking blocks, tool_use blocks)
      if (!Array.isArray(msg.content)) { continue }
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) {
            this.delegate.emit({
              time: 0,
              type: 'message',
              payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
    }
  }

  /** Extract a human-readable label from the first user message in transcript entries */
  extractSessionLabel(entries: TranscriptEntry[], session: WatchedSession): void {
    if (session.labelSet) return
    for (const entry of entries) {
      if (entry.type !== 'user') continue
      const text = this.extractUserMessageText(entry)
      if (text) {
        session.label = this.truncateLabel(text)
        session.labelSet = true
        return
      }
    }
  }

  /** Extract text content from a user transcript entry, skipping system-injected tags */
  extractUserMessageText(entry: TranscriptEntry): string | null {
    const msg = entry.message
    if (!msg) return null
    if (typeof msg.content === 'string' && msg.content.trim()) {
      const text = msg.content.trim()
      if (!this.isSystemInjectedContent(text)) return text
      return null
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) return text
        }
      }
    }
    return null
  }

  /** Check if text is system-injected context (not a real user/assistant message) */
  isSystemInjectedContent(text: string): boolean {
    return SYSTEM_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))
  }

  /** Truncate to first line, max chars — fits in a tab */
  truncateLabel(text: string): string {
    const firstLine = text.split('\n')[0].trim()
    if (firstLine.length <= SESSION_LABEL_MAX) return firstLine
    return firstLine.slice(0, SESSION_LABEL_TRUNCATED) + '..'
  }

  /** Update session label on first user message and notify the webview */
  maybeSetSessionLabel(entry: TranscriptEntry, sessionId: string): void {
    const session = this.delegate.getSession(sessionId)
    if (!session || session.labelSet) return
    if (entry.type !== 'user') return
    const text = this.extractUserMessageText(entry)
    if (!text) return
    session.label = this.truncateLabel(text)
    session.labelSet = true
    this.delegate.fireSessionLifecycle({ type: 'updated', sessionId, label: session.label })
  }
}

/** Default root that hook-supplied transcript paths must resolve inside. */
export const DEFAULT_TRANSCRIPT_ROOT = path.join(os.homedir(), '.claude', 'projects')

/**
 * True when a path supplied by an untrusted source (e.g. an HTTP hook payload) is a
 * regular `.jsonl` file whose real path (symlinks and `..` resolved) lies inside one
 * of the allowed roots. Prevents arbitrary file reads through `agent_transcript_path`.
 */
export function isAllowedTranscriptPath(filePath: unknown, roots: string[] = [DEFAULT_TRANSCRIPT_ROOT]): boolean {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) { return false }
  try {
    if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.jsonl') { return false }
    const real = fs.realpathSync(filePath)
    if (path.extname(real).toLowerCase() !== '.jsonl' || !fs.statSync(real).isFile()) { return false }
    return roots.some(root => {
      let realRoot: string
      try { realRoot = fs.realpathSync(root) } catch { return false }
      const rel = path.relative(realRoot, real)
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
  } catch {
    return false
  }
}

/** Parse the last assistant text block out of a (possibly partial) JSONL tail. */
export function parseLastAssistantText(raw: string, max = MESSAGE_MAX): string | undefined {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) { continue }
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isRecord(entry)) { continue }
    const msg = entry.message
    const role = isRecord(msg) ? msg.role : entry.type
    if (role !== 'assistant' || !isRecord(msg)) { continue }
    const content = msg.content
    const text = typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content.filter(b => isRecord(b) && b.type === 'text').map(safeText).filter(Boolean).pop() ?? ''
        : ''
    if (text) { return text.slice(0, max) }
  }
  return undefined
}

/**
 * Extract the last assistant text block from a (subagent) JSONL transcript file.
 * Reads only the last SUBAGENT_TRANSCRIPT_TAIL_BYTES of the file; returns undefined
 * on any failure. Synchronous: prefer extractLastAssistantTextAsync on hot paths.
 */
export function extractLastAssistantText(filePath: string, max = MESSAGE_MAX): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r')
    let raw: string
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) { return undefined }
      const start = Math.max(0, st.size - SUBAGENT_TRANSCRIPT_TAIL_BYTES)
      const buf = Buffer.alloc(st.size - start)
      const n = fs.readSync(fd, buf, 0, buf.length, start)
      raw = buf.toString('utf8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
    return parseLastAssistantText(raw, max)
  } catch {
    return undefined
  }
}

/**
 * Non-blocking variant of extractLastAssistantText: bounded tail read through the
 * promises API so a flood of SubagentStop hooks cannot block the event loop.
 */
export async function extractLastAssistantTextAsync(filePath: string, max = MESSAGE_MAX): Promise<string | undefined> {
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(filePath, 'r')
    const st = await fh.stat()
    if (!st.isFile()) { return undefined }
    const start = Math.max(0, st.size - SUBAGENT_TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(st.size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return parseLastAssistantText(buf.toString('utf8', 0, bytesRead), max)
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Best available full report for a SubagentStop payload: the last assistant text of
 * the (allow-listed) subagent transcript, else the `last_assistant_message` field.
 * Paths from the payload are untrusted and never read unless isAllowedTranscriptPath().
 */
export function buildSubagentReport(payload: { agent_transcript_path?: unknown; last_assistant_message?: unknown }): string | undefined {
  if (isAllowedTranscriptPath(payload.agent_transcript_path)) {
    const fromFile = extractLastAssistantText(String(payload.agent_transcript_path))
    if (fromFile) return fromFile
  }
  if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
    return payload.last_assistant_message.trim().slice(0, MESSAGE_MAX)
  }
  return undefined
}

/**
 * Async variant of buildSubagentReport (same allow-list rules, non-blocking bounded read).
 */
export async function buildSubagentReportAsync(
  payload: { agent_transcript_path?: unknown; last_assistant_message?: unknown },
  readTail: (p: string) => Promise<string | undefined> = extractLastAssistantTextAsync,
): Promise<string | undefined> {
  if (isAllowedTranscriptPath(payload.agent_transcript_path)) {
    const fromFile = await readTail(String(payload.agent_transcript_path))
    if (fromFile) { return fromFile }
  }
  return fallbackReport(payload.last_assistant_message)
}

/** Report from the payload's own last_assistant_message (no file access). */
export function fallbackReport(msg: unknown): string | undefined {
  return typeof msg === 'string' && msg.trim() ? msg.trim().slice(0, MESSAGE_MAX) : undefined
}
