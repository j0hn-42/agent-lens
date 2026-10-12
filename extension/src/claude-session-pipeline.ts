import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, WatchedSession } from './protocol'
import { INACTIVITY_TIMEOUT_MS, POLL_FALLBACK_MS, SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME } from './constants'
import { TranscriptParser } from './transcript-parser'
import { safeWatch, readTrackedLines } from './fs-utils'
import { handlePermissionDetection } from './permission-detection'
import { scanSubagentsDir, readSubagentNewLines, markTeammatesDone } from './subagent-watcher'

/**
 * Tracking of one Claude Code session transcript: attach (history catch-up), live reads, inactivity,
 * context_update. Single implementation shared by the extension (SessionWatcher, VS Code) and the relay
 * (scripts/relay.ts, `pnpm dev` / `npx agent-lens-app`), which only differ by what they plug in through
 * {@link ClaudeSessionHost}. No `vscode` import: the relay loads this module outside VS Code (#218).
 */
export interface ClaudeSessionHost {
  /** The sessions being tracked, owned by the host (it also reads them for listing and discovery) */
  readonly sessions: Map<string, WatchedSession>
  /** Emit an event of the transcript flow; `sessionId` is already set */
  submit(event: AgentEvent): void
  /** Announce a session start/end/update to the clients, with the host's tags */
  fireLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string): void
  /** Run a history load: events arriving meanwhile are held and deduplicated by the host's reconciler */
  withHistory<T>(load: () => T): T
  /** A session was announced (extension only) */
  onDetected?(sessionId: string): void
  /** False for a transcript that is read but not live (imported): no activity is inferred, no end is invented */
  isLive?(sessionId: string): boolean
  /** Run a watcher or poll callback; the relay detaches the session when it throws (#206) */
  guard?(fn: () => void, sessionId: string): void
  /** Size cap of a transcript, checked after each read; over it, `onOversize` runs instead of parsing (relay) */
  maxFileBytes?(): number
  onOversize?(sessionId: string): void
  log?(message: string): void
}

export class ClaudeSessionPipeline {
  readonly parser: TranscriptParser
  /** Delegate for the subagent / permission modules to call back into the pipeline */
  readonly delegate: {
    emit(event: AgentEvent, sessionId?: string): void
    elapsed(sessionId?: string): number
    getSession(sessionId: string): WatchedSession | undefined
    getLastActivityTime(sessionId: string): number | undefined
    resetInactivityTimer(sessionId: string): void
  }

  constructor(private readonly host: ClaudeSessionHost) {
    const emit = (event: AgentEvent, sessionId?: string) => this.emit(event, sessionId)
    const elapsed = (sessionId?: string) => this.elapsed(sessionId)
    const getSession = (sessionId: string) => this.host.sessions.get(sessionId)
    this.parser = new TranscriptParser({
      emit, elapsed, getSession,
      fireSessionLifecycle: (event) => this.host.fireLifecycle(event.type, event.sessionId, event.label),
      emitContextUpdate: (agentName, session, sessionId) => this.emitContextUpdate(agentName, session, sessionId),
    })
    this.delegate = {
      emit, elapsed, getSession,
      getLastActivityTime: (sessionId) => this.host.sessions.get(sessionId)?.lastActivityTime,
      resetInactivityTimer: (sessionId) => this.resetInactivityTimer(sessionId),
    }
  }

  elapsed(sessionId?: string): number {
    const session = sessionId ? this.host.sessions.get(sessionId) : undefined
    return session ? (Date.now() - session.sessionStartTime) / 1000 : 0
  }

  emit(event: AgentEvent, sessionId?: string): void {
    this.host.submit(sessionId ? { ...event, sessionId } : event)
  }

  /** Emit a context_update with the cumulative token breakdown (an estimate computed from the transcript) */
  emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string): void {
    const bd = session.contextBreakdown
    const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
    this.emit({
      time: this.elapsed(sessionId),
      type: 'context_update',
      payload: { agent: agentName, tokens: total, tokenSource: 'estimated', breakdown: { ...bd } },
    }, sessionId)
  }

  newSession(sessionId: string, filePath: string, lastActivityTime = Date.now()): WatchedSession {
    return {
      sessionId, filePath,
      fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
      sessionStartTime: Date.now(),
      pendingToolCalls: new Map(),
      seenToolUseIds: new Set(),
      seenMessageHashes: new Set(),
      sessionDetected: false, sessionCompleted: false,
      lastActivityTime,
      inactivityTimer: null,
      subagentWatchers: new Map(),
      spawnedSubagents: new Set(),
      inlineProgressAgents: new Set(),
      subagentsDirWatcher: null, subagentsDir: null,
      label: `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`, labelSet: false,
      model: null,
      modelDetectedAgents: new Map(),
      permissionTimer: null, permissionEmitted: false,
      contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    }
  }

  /** The orchestrator's agent_spawn, announced at attach and again when a completed session resumes */
  private spawnOrchestrator(session: WatchedSession, time: number): void {
    this.emit({
      time,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME, isMain: true, task: session.label,
        ...(session.model ? { model: session.model, modelSource: 'runtime' as const } : {}),
      },
    }, session.sessionId)
  }

  /**
   * Start tracking a transcript: read its history (current turn only), announce the session, then follow
   * the file (fs.watch + poll fallback), its subagents and its inactivity. The caller has registered
   * `session` in the host's `sessions`.
   */
  attach(session: WatchedSession): void {
    const { sessionId, filePath } = session
    // The live flow (hooks) is already subscribed: events arriving while the history is read are held
    // and replayed, deduplicated against the history, when the load ends (issue #53).
    this.host.withHistory(() => {
      const stat = fs.statSync(filePath)
      // Pre-scan existing content for dedup IDs + collect recent entries for catch-up.
      // It also starts the tail from the end of what it read (only NEW events go forward),
      // keeping an unfinished last line in fileTail.
      const catchUpEntries = this.parser.prescanExistingContent(filePath, stat.size, session)
      this.parser.extractSessionLabel(catchUpEntries, session)

      this.host.onDetected?.(sessionId)
      this.host.fireLifecycle('started', sessionId, session.label)
      this.spawnOrchestrator(session, 0)
      session.sessionDetected = true

      // Initial context breakdown from the prescan, so the clients show the accumulated tokens
      this.emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
      // Content that was already in the file (e.g. the first user message): prescanned for dedup and
      // tokens but never emitted, so emit it now for the clients to show the full history.
      this.parser.emitCatchUpEntries(catchUpEntries, session, sessionId)
    })

    const guard = (fn: () => void) => (this.host.guard ? this.host.guard(fn, sessionId) : fn())
    session.fileWatcher = safeWatch(filePath, (eventType) => {
      if (eventType === 'change') guard(() => this.readNewLines(sessionId))
    })
    // Poll fallback: fs.watch can silently stop firing on long-lived watchers (macOS), and does not
    // fire for subagent files after a restart.
    session.pollTimer = setInterval(() => guard(() => {
      this.readNewLines(sessionId)
      for (const [subPath] of session.subagentWatchers) readSubagentNewLines(this.delegate, this.parser, subPath, sessionId)
      scanSubagentsDir(this.delegate, this.parser, sessionId)
    }), POLL_FALLBACK_MS)

    session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
    scanSubagentsDir(this.delegate, this.parser, sessionId)
    // The session completes if no new content arrives
    this.resetInactivityTimer(sessionId)
    this.host.log?.(`Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
  }

  readNewLines(sessionId: string): void {
    const session = this.host.sessions.get(sessionId)
    if (!session) return

    const lines = readTrackedLines(session.filePath, session)
    if (!lines) return
    const cap = this.host.maxFileBytes?.()
    if (cap !== undefined && session.fileSize > cap) {
      this.host.onOversize?.(sessionId)
      return
    }
    for (const line of lines) {
      this.parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
    }
    // Permission-gated tool calls (Agent/Task are skipped: subagents are inherently slow)
    handlePermissionDetection(this.delegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
    scanSubagentsDir(this.delegate, this.parser, sessionId)
    this.resetInactivityTimer(sessionId)
  }

  /** Mark the session active; when no new content arrives for INACTIVITY_TIMEOUT_MS, emit agent_complete */
  resetInactivityTimer(sessionId: string): void {
    const session = this.host.sessions.get(sessionId)
    if (!session) return
    if (this.host.isLive && !this.host.isLive(sessionId)) return

    const wasCompleted = session.sessionCompleted
    session.lastActivityTime = Date.now()
    session.sessionCompleted = false

    // A completed session that gets new content: re-announce the orchestrator so the clients accept its events again
    if (wasCompleted) {
      this.spawnOrchestrator(session, this.elapsed(sessionId))
      this.host.fireLifecycle('started', sessionId, session.label)
    }

    if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    session.inactivityTimer = setTimeout(() => {
      if (!session.sessionCompleted && session.sessionDetected) {
        this.host.log?.(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive — emitting orchestrator completion`)
        session.sessionCompleted = true
        // Teammates stay on screen but are finished with their lead (never agent_complete)
        markTeammatesDone(this.delegate, session, sessionId)
        this.emit({
          time: this.elapsed(sessionId),
          type: 'agent_complete',
          payload: { name: ORCHESTRATOR_NAME, inactivity: true },
        }, sessionId)
        this.host.fireLifecycle('ended', sessionId, session.label)
      }
    }, INACTIVITY_TIMEOUT_MS)
  }

  /** Close every watcher and timer of a session and free its parser state. The caller forgets the session. */
  release(session: WatchedSession): void {
    session.fileWatcher?.close()
    session.subagentsDirWatcher?.close()
    if (session.pollTimer) clearInterval(session.pollTimer)
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    if (session.permissionTimer) clearTimeout(session.permissionTimer)
    for (const sub of session.subagentWatchers.values()) {
      sub.watcher?.close()
      if (sub.permissionTimer) clearTimeout(sub.permissionTimer)
    }
    session.subagentWatchers.clear()
    this.parser.clearSessionState(session.pendingToolCalls.keys(), session.sessionId)
  }
}
