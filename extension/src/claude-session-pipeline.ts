import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, SessionInfo, WatchedSession } from './protocol'
import { POLL_FALLBACK_MS, SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME } from './constants'
import { TranscriptParser } from './transcript-parser'
import { safeWatch, readTrackedLines, TimeSlice, AttachCancelled } from './fs-utils'
import { handlePermissionDetection } from './permission-detection'
import { scanSubagentsDir, scanSubagentsDirAtAttach, readSubagentNewLines, markTeammatesDone } from './subagent-watcher'

/**
 * Tracking of one Claude Code session transcript: attach (history catch-up), live reads, activity and end,
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
  /**
   * The same over several ticks, holding only this session's events (a Claude attach, #651). Both hosts provide
   * it; without it nothing is held (test hosts).
   */
  withSessionHistory?<T>(sessionId: string, load: () => Promise<T>): Promise<T>
  /** A session was announced (extension only) */
  onDetected?(sessionId: string): void
  /** False for a transcript that is read but not live (imported): no activity is inferred, no end is invented */
  isLive?(sessionId: string): boolean
  /** Run a watcher or poll callback; the relay detaches the session when it throws (#206) */
  guard?(fn: () => void, sessionId: string): void
  /** Size cap of a transcript, checked after each read; over it, `onOversize` runs instead of parsing (relay) */
  maxFileBytes?(): number
  onOversize?(sessionId: string): void
  /** Lines just read from the transcript, after they were parsed (the hosts learn a cwd written late from them) */
  onTranscriptLines?(sessionId: string, lines: readonly string[]): void
  log?(message: string): void
}

/**
 * Start fields of a listed Claude session (#365). `startTime` stays when watching began, the origin of the event
 * times; the start the transcript records is given apart, and its absence is said (`startTimeWatched`), so a
 * duration is never presented as the session's age when it only counts since the relay or extension attached.
 */
export function listedStartTimes(session: Pick<WatchedSession, 'sessionStartTime' | 'recordedStartTime'>): Pick<SessionInfo, 'startTime' | 'recordedStartTime' | 'startTimeWatched'> {
  return session.recordedStartTime !== undefined
    ? { startTime: session.sessionStartTime, recordedStartTime: session.recordedStartTime }
    : { startTime: session.sessionStartTime, startTimeWatched: true }
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

  /** Sessions whose attach is queued or running (#651): nothing else reads them meanwhile */
  private readonly attaching = new Map<string, WatchedSession>()
  /** Attaches run one after the other (#651) */
  private attachQueue: Promise<void> = Promise.resolve()
  /** A SessionEnd observed while the session was being attached: applied once the attach ended (#651) */
  private readonly endedWhileAttaching = new Set<string>()

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

  /**
   * A new tracked session. `lastActivityTime` is when the transcript was last written (its mtime, #365) and
   * `recordedStartTime` the start it records (left out when it records none).
   */
  newSession(sessionId: string, filePath: string, times: { lastActivityTime?: number; recordedStartTime?: number } = {}): WatchedSession {
    const now = Date.now()
    return {
      sessionId, filePath,
      fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
      sessionStartTime: now,
      // A start after now is not a recorded start (clock skew, edited file): the start is then the watch start
      ...(times.recordedStartTime !== undefined && Number.isFinite(times.recordedStartTime) && times.recordedStartTime <= now ? { recordedStartTime: times.recordedStartTime } : {}),
      pendingToolCalls: new Map(),
      seenToolUseIds: new Set(),
      seenMessageHashes: new Set(),
      sessionDetected: false, sessionCompleted: false,
      lastActivityTime: times.lastActivityTime ?? now,
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
   * the file (fs.watch + poll fallback) and its subagents. The caller has registered
   * `session` in the host's `sessions`.
   *
   * Never in the caller's tick (#651): attaches are queued and run one after the other, each from its own turn
   * of the event loop, and the history is read in slices that give the loop back (hooks, SSE and /status keep
   * answering). Until it resolves, the session is read by nothing else (readNewLines, the subagent scans). A
   * session released or replaced meanwhile is dropped at the next slice: never announced, never watched.
   * Rejects when the transcript cannot be read (stat).
   */
  attach(session: WatchedSession): Promise<void> {
    this.attaching.set(session.sessionId, session)
    const previous = this.attachQueue
    const run = this.attachNow(session, previous)
    this.attachQueue = run.catch(() => {})
    return run
  }

  /** Settles once every attach queued so far has ended (resolved or failed); null when none is queued (#651) */
  whenAttached(): Promise<void> | null {
    return this.attaching.size > 0 ? this.attachQueue : null
  }

  private async attachNow(session: WatchedSession, previous: Promise<void>): Promise<void> {
    const { sessionId, filePath } = session
    const alive = () => this.attaching.get(sessionId) === session && this.host.sessions.get(sessionId) === session
    const slice = new TimeSlice(() => !alive())
    const withSessionHistory = this.host.withSessionHistory ?? (<T>(_id: string, load: () => Promise<T>) => load())
    try {
      // The live flow (hooks) is already subscribed: the session's events arriving while it is queued and while the
      // history is read are held and replayed, deduplicated against the history, when the load ends (issue #53).
      // The hold starts here, not when the attach comes up: a hook of a queued session must not be delivered
      // ahead of its 'started' and its agent_spawn (#613).
      await withSessionHistory(sessionId, async () => {
        await previous
        // One session per turn of the event loop; a session dropped while queued stops here
        await slice.pause()
        await this.loadHistory(session, slice, alive)
      })
    } catch (err) {
      if (err instanceof AttachCancelled) { this.dropCancelled(session); return }
      this.endedWhileAttaching.delete(sessionId)
      if (this.attaching.get(sessionId) === session) this.attaching.delete(sessionId)
      throw err
    }
    if (!alive()) { this.dropCancelled(session); return }
    this.attaching.delete(sessionId)

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

    // Attaching is not activity: the last activity stays when the transcript was last written (#365)
    this.host.log?.(`Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
    // What was written while the history was read (over several ticks) is live: read it now
    guard(() => this.readNewLines(sessionId))
    if (this.endedWhileAttaching.delete(sessionId)) this.observeSessionEnd(sessionId)
  }

  /**
   * An attach that stopped because its session was released or replaced: no pending end, and the parser state a block
   * in flight may have created after release() is freed, unless a newer session of the same id owns it now (#613).
   */
  private dropCancelled(session: WatchedSession): void {
    const { sessionId } = session
    this.endedWhileAttaching.delete(sessionId)
    const current = this.host.sessions.get(sessionId)
    if ((current === undefined || current === session) && !this.attaching.has(sessionId)) {
      this.parser.clearSessionState(session.pendingToolCalls.keys(), sessionId)
    }
  }

  /** The history part of an attach: everything already in the transcript and its subagent files. */
  private async loadHistory(session: WatchedSession, slice: TimeSlice, alive: () => boolean): Promise<void> {
    const { sessionId, filePath } = session
    const stat = await fs.promises.stat(filePath)
    // Released during the stat: nothing was read yet, so no slice would notice it (an empty transcript has none)
    if (!alive()) throw new AttachCancelled()
    // Pre-scan existing content for dedup IDs + collect recent entries for catch-up.
    // It also starts the tail from the end of what it read (only NEW events go forward),
    // keeping an unfinished last line in fileTail.
    const catchUpEntries = await this.parser.prescanExistingContentAsync(filePath, stat.size, session, slice)
    this.parser.extractSessionLabel(catchUpEntries, session)
    // The last block of the prescan may have run after a release: not announced, since nothing would end it
    if (!alive()) throw new AttachCancelled()

    this.host.onDetected?.(sessionId)
    this.host.fireLifecycle('started', sessionId, session.label)
    this.spawnOrchestrator(session, 0)
    session.sessionDetected = true

    // Initial context breakdown from the prescan, so the clients show the accumulated tokens
    this.emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
    // Content that was already in the file (e.g. the first user message): prescanned for dedup and
    // tokens but never emitted, so emit it now for the clients to show the full history.
    this.parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

    // The subagent, teammate and workflow files already there are history too (#361): a teammate's
    // replayed tail and a pending sub-agent's spawn were not seen live. Later scans (poll, tail) are live.
    // Read over several ticks too; `session.subagentsDir` is set when it is done (#651).
    await scanSubagentsDirAtAttach(this.delegate, this.parser, sessionId, path.join(path.dirname(filePath), sessionId, 'subagents'), slice)
  }

  readNewLines(sessionId: string): void {
    const session = this.host.sessions.get(sessionId)
    if (!session) return
    // Being attached: the history read owns the position, what is written meanwhile is read when it ends (#651)
    if (this.attaching.has(sessionId)) return

    const lines = readTrackedLines(session.filePath, session)
    if (!lines) return
    const cap = this.host.maxFileBytes?.()
    if (cap !== undefined && session.fileSize > cap) {
      this.host.onOversize?.(sessionId)
      return
    }
    let conversation = false
    // A user or assistant line over NORM_MAX_LINE_CHARS is not parsed (the normalizer drops it, event-normalize.ts): its
    // type is unknown, so it is no conversation turn and does not reopen a completed session (#613)
    for (const line of lines) {
      const type = this.parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
      if (type === 'user' || type === 'assistant') conversation = true
    }
    this.host.onTranscriptLines?.(sessionId, lines)
    // Permission-gated tool calls (Agent/Task are skipped: subagents are inherently slow)
    handlePermissionDetection(this.delegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
    scanSubagentsDir(this.delegate, this.parser, sessionId)
    // Only a new user or assistant entry is a resumed conversation: metadata written after the end never reopens it
    this.resetInactivityTimer(sessionId, conversation)
  }

  /**
   * New transcript content: mark the session active. A completed session (observed end) is reopened only by
   * a new conversation entry (`reopen`). A silence never ends anything (#360): no timer completes the session,
   * the clients tell a silence apart from the event times.
   */
  resetInactivityTimer(sessionId: string, reopen = true): void {
    const session = this.host.sessions.get(sessionId)
    if (!session) return
    if (this.host.isLive && !this.host.isLive(sessionId)) return

    const wasCompleted = session.sessionCompleted
    session.lastActivityTime = Date.now()
    if (wasCompleted && !reopen) return
    session.sessionCompleted = false

    // A completed session that gets new content: re-announce the orchestrator so the clients accept its events again
    if (wasCompleted) {
      this.spawnOrchestrator(session, this.elapsed(sessionId))
      this.host.fireLifecycle('started', sessionId, session.label)
    }
  }

  /** A hook event of the session was received: activity, but it never reopens a session whose end was observed */
  noteHookActivity(sessionId: string): void {
    const session = this.host.sessions.get(sessionId)
    if (!session || session.sessionCompleted) return
    if (this.host.isLive && !this.host.isLive(sessionId)) return
    session.lastActivityTime = Date.now()
  }

  /** A hook event was received for a session: a SessionEnd ends it, anything else is activity */
  observeHookEvent(event: AgentEvent): void {
    if (!event.sessionId) return
    // Same reading order as filterOrchestratorCompletion: a mixed payload is classified the same way
    const who = event.payload?.agent ?? event.payload?.name
    const isOrchestrator = !who || who === ORCHESTRATOR_NAME
    if (event.type === 'agent_complete' && isOrchestrator && event.payload?.sessionEnd === true) this.observeSessionEnd(event.sessionId)
    else this.noteHookActivity(event.sessionId)
  }

  /** Claude Code reported the end of the session (SessionEnd hook): the only way a live session completes */
  observeSessionEnd(sessionId: string): void {
    // Being attached: the end is applied after the history, in the order it happened (#651)
    if (this.attaching.has(sessionId)) { this.endedWhileAttaching.add(sessionId); return }
    const session = this.host.sessions.get(sessionId)
    if (!session || session.sessionCompleted || !session.sessionDetected) return
    if (this.host.isLive && !this.host.isLive(sessionId)) return
    this.host.log?.(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} ended (SessionEnd observed)`)
    session.sessionCompleted = true
    // Teammates stay on screen but are finished with their lead (never agent_complete)
    markTeammatesDone(this.delegate, session, sessionId)
    this.host.fireLifecycle('ended', sessionId, session.label)
  }

  /** Close every watcher and timer of a session and free its parser state. The caller forgets the session. */
  release(session: WatchedSession): void {
    // An attach still queued or running for it stops at its next slice
    if (this.attaching.get(session.sessionId) === session) this.attaching.delete(session.sessionId)
    session.fileWatcher?.close()
    session.subagentsDirWatcher?.close()
    if (session.pollTimer) clearInterval(session.pollTimer)
    if (session.permissionTimer) clearTimeout(session.permissionTimer)
    for (const sub of session.subagentWatchers.values()) {
      sub.watcher?.close()
      if (sub.permissionTimer) clearTimeout(sub.permissionTimer)
    }
    session.subagentWatchers.clear()
    this.parser.clearSessionState(session.pendingToolCalls.keys(), session.sessionId)
  }
}
