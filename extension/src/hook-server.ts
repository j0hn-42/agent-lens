import * as http from 'http'
import * as vscode from 'vscode'
import { AgentEvent, NormalizationStats, emitSubagentSpawn } from './protocol'
import {
  ORCHESTRATOR_NAME, PREVIEW_MAX, RESULT_MAX, MESSAGE_MAX,
  SESSION_ID_DISPLAY, FAILED_RESULT_MAX, HOOK_MAX_BODY_SIZE,
  SUBAGENT_ID_SUFFIX_LENGTH, HOOK_SERVER_HOST, HOOK_SERVER_NOT_STARTED,
  HOOK_MAX_HEADER_BYTES, HOOK_MAX_CONNECTIONS, HOOK_MAX_REQUESTS_PER_SOCKET, HOOK_REQUEST_TIMEOUT_MS,
  HOOK_RATE_IP_BURST, HOOK_RATE_IP_PER_S, HOOK_RATE_SESSION_BURST, HOOK_RATE_SESSION_PER_S,
  HOOK_MAX_SESSIONS, HOOK_MAX_TRACKED_PER_SESSION, TEAM_MAX_LINKS_PER_SESSION,
  HTTP_CONNECTIONS_CHECK_INTERVAL_MS,
  SUBAGENT_TRANSCRIPT_CONCURRENCY, SUBAGENT_TRANSCRIPT_MAX_QUEUE, SUBAGENT_TRANSCRIPT_TIMEOUT_MS,
  generateSubagentFallbackName,
  resolveSubagentChildName,
} from './constants'
import { summarizeInput, summarizeResult, extractFilePath, extractInputData, buildDiscovery } from './tool-summarizer'
import { buildSubagentReportAsync, fallbackReport, isAllowedTranscriptPath } from './transcript-parser'
import {
  isLoopbackAddress, isLoopbackHostHeader, KeyedRateLimiter, validateHookPayload,
  AsyncLimiter, withTimeout, setConnectionsCheckingInterval,
} from './hook-guards'
import { estimateTokenCost, estimateTokensFromText } from './token-estimator'
import { extractToolUseLinks } from './team-links'
import { createLogger } from './logger'
import { SessionNormalizer } from './event-normalize'
import { isSafeId } from './hook-guards'

const log = createLogger('HookServer')

/**
 * Lightweight HTTP server that receives Claude Code hook events.
 *
 * Claude Code hooks POST JSON payloads for events like PreToolUse, PostToolUse,
 * SubagentStart, SubagentStop, SessionStart, Stop, etc.
 *
 * We transform these into AgentEvent format and emit them.
 */

/** Port 0 = let OS assign a random available port */

interface HookPayload {
  session_id: string
  transcript_path?: string
  cwd?: string
  hook_event_name: string
  // PreToolUse / PostToolUse
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  tool_response?: string | { content: string } | Array<{ text?: string }>
  // SubagentStart / SubagentStop
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  // Notification
  notification_type?: string
  message?: string
  title?: string
  // Generic
  [key: string]: unknown
}

/** An Agent/Task dispatch seen via PreToolUse, awaiting correlation with SubagentStart/Stop */
interface HookDispatch {
  label: string
  subagentType?: string
  startTime: number
  claimed: boolean
}

interface HookSessionState {
  startTime: number
  agentNames: Map<string, string> // agent_id → friendly name
  /** tool_use_id → dispatch seen in PreToolUse (Agent/Task) */
  dispatches: Map<string, HookDispatch>
  /** agent_id → correlated dispatch */
  agentDispatch: Map<string, { toolUseId?: string; startTime: number }>
  /** linkIds already emitted as agent_link (bounded by TEAM_MAX_LINKS_PER_SESSION) */
  links: Set<string>
}

export class HookServer implements vscode.Disposable {
  private server: http.Server | null = null
  private port: number
  /** Per-session state — cleaned up on SessionEnd/Stop to prevent unbounded growth */
  private sessionState = new Map<string, HookSessionState>()
  private readonly ipLimiter = new KeyedRateLimiter(HOOK_RATE_IP_BURST, HOOK_RATE_IP_PER_S)
  private readonly sessionLimiter = new KeyedRateLimiter(HOOK_RATE_SESSION_BURST, HOOK_RATE_SESSION_PER_S)
  /** SubagentStop transcript reads run one at a time with a bounded queue */
  private readonly transcriptLimiter = new AsyncLimiter(SUBAGENT_TRANSCRIPT_CONCURRENCY, SUBAGENT_TRANSCRIPT_MAX_QUEUE)
  private disposed = false
  /** Per-session input normalizers (bounded like sessionState): every emitted event goes through one */
  private readonly normalizers = new Map<string, SessionNormalizer>()
  /** Counters for requests that cannot be attributed to a session (invalid JSON, invalid session_id) */
  private readonly unattributed = new SessionNormalizer()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()

  readonly onEvent = this._onEvent.event

  constructor(port?: number) {
    this.port = port ?? 0
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer({ maxHeaderSize: HOOK_MAX_HEADER_BYTES }, (req, res) => this.handleRequest(req, res))
      this.server.maxConnections = HOOK_MAX_CONNECTIONS
      this.server.maxRequestsPerSocket = HOOK_MAX_REQUESTS_PER_SOCKET
      this.server.requestTimeout = HOOK_REQUEST_TIMEOUT_MS
      this.server.headersTimeout = HOOK_REQUEST_TIMEOUT_MS
      this.server.keepAliveTimeout = 2000
      // Node only enforces the timeouts above when this sweep runs (default 30s): shrink the slowloris window
      setConnectionsCheckingInterval(this.server, HTTP_CONNECTIONS_CHECK_INTERVAL_MS)
      // Defense in depth on top of the loopback bind: drop any non-loopback peer.
      this.server.on('connection', socket => {
        if (!isLoopbackAddress(socket.remoteAddress)) { socket.destroy() }
      })
      this.server.on('clientError', (_err, socket) => {
        if (socket.writable) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } else { socket.destroy() }
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Another instance already owns this port — skip instead of incrementing
          // to a port nobody sends to. The session watcher handles all events via JSONL.
          log.info(`Port ${this.port} in use (another instance owns it) — skipping hook server`)
          this.server?.close()
          this.server = null
          resolve(HOOK_SERVER_NOT_STARTED)
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, HOOK_SERVER_HOST, () => {
        const addr = this.server!.address() as { port: number }
        this.port = addr.port
        log.info(`Listening on http://127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  /** Reject with an error status, close the connection and destroy the socket. */
  private reject(req: http.IncomingMessage, res: http.ServerResponse, status: number, msg: string, headers: http.OutgoingHttpHeaders = {}): void {
    if (status !== 429) { log.warn(`Rejected hook request (${status}): ${msg}`) } // no per-request log during a flood
    if (res.headersSent) { req.socket.destroy(); return }
    res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close', ...headers })
    res.end(msg, () => req.socket.destroy())
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress
    if (!isLoopbackAddress(remote)) { return this.reject(req, res, 403, 'Forbidden') }
    // Host check stops DNS rebinding; hook clients (Node/curl) never send Origin, browsers always do on cross-site POSTs.
    if (!isLoopbackHostHeader(req.headers.host)) { return this.reject(req, res, 403, 'Forbidden') }
    if (req.headers.origin !== undefined) { return this.reject(req, res, 403, 'Forbidden') }

    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Agent Visualizer Hook Server')
      return
    }

    if (!this.ipLimiter.allow(remote ?? '')) {
      return this.reject(req, res, 429, 'Too Many Requests', { 'Retry-After': '1' })
    }
    const ctype = req.headers['content-type']
    if (typeof ctype !== 'string' || !/^application\/json\s*(;|$)/i.test(ctype)) {
      return this.reject(req, res, 415, 'Unsupported Media Type')
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > HOOK_MAX_BODY_SIZE) {
      return this.reject(req, res, 413, 'Payload Too Large')
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) { return }
      size += chunk.length
      if (size > HOOK_MAX_BODY_SIZE) {
        aborted = true
        chunks.length = 0
        this.reject(req, res, 413, 'Payload Too Large')
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => { aborted = true })
    req.on('end', () => {
      if (aborted) { return }
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        this.unattributed.noteMalformed()
        return this.reject(req, res, 400, 'Invalid JSON')
      }
      const checked = validateHookPayload(parsed)
      if (!checked.ok) {
        this.noteMalformedPayload(parsed)
        return this.reject(req, res, 400, `Invalid payload: ${checked.reason}`)
      }
      if (!this.sessionLimiter.allow(checked.payload.session_id)) {
        return this.reject(req, res, 429, 'Too Many Requests', { 'Retry-After': '1' })
      }
      try {
        this.handleHook(checked.payload as HookPayload)
      } catch (e) {
        log.error('Hook handler failed:', e)
      }
      // Empty 200 = "success, no output" per Claude Code docs. Returning JSON (even '{}')
      // triggers schema parsing which can cause issues.
      res.writeHead(200)
      res.end()
    })
  }

  /** Normalization counters of a session (or of the requests no session could be found for). */
  getNormalizationStats(sessionId?: string): NormalizationStats {
    const n = sessionId === undefined ? this.unattributed : this.normalizers.get(sessionId)
    return { ...(n ?? this.unattributed).stats }
  }

  /** Normalizer of a session, created on first use; oldest evicted past HOOK_MAX_SESSIONS. */
  private normalizerFor(sessionId: string): SessionNormalizer {
    let n = this.normalizers.get(sessionId)
    if (n) {
      this.normalizers.delete(sessionId)
    } else {
      if (this.normalizers.size >= HOOK_MAX_SESSIONS) {
        const oldest = this.normalizers.keys().next().value
        if (oldest !== undefined) { this.normalizers.get(oldest)?.dispose(); this.normalizers.delete(oldest) }
      }
      n = new SessionNormalizer(sessionId, { onTrailing: event => { if (!this.disposed) this._onEvent.fire({ ...event, sessionId }) } })
    }
    this.normalizers.set(sessionId, n)
    return n
  }

  /** A payload that failed validation: counted against its session when it names a safe one. */
  private noteMalformedPayload(parsed: unknown): void {
    const sid = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).session_id : undefined
    const norm = isSafeId(sid) ? this.normalizerFor(sid) : this.unattributed
    // The counter reaches the UI with the next event of that session (no event is emitted for a rejected request)
    norm.noteMalformed()
  }

  getPort(): number {
    return this.port
  }

  private getOrCreateSession(sessionId: string): HookSessionState {
    let state = this.sessionState.get(sessionId)
    if (state) {
      // LRU: a session that is still sending hooks moves to the back, so eviction drops idle ones first
      this.sessionState.delete(sessionId)
      this.sessionState.set(sessionId, state)
    } else {
      if (this.sessionState.size >= HOOK_MAX_SESSIONS) {
        const oldest = this.sessionState.keys().next().value
        if (oldest !== undefined) { this.sessionState.delete(oldest) }
      }
      state = { startTime: Date.now(), agentNames: new Map(), dispatches: new Map(), agentDispatch: new Map(), links: new Set() }
      this.sessionState.set(sessionId, state)
    }
    return state
  }

  /** Set a Map entry, evicting the oldest key when the per-session bound is reached. */
  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (!map.has(key) && map.size >= HOOK_MAX_TRACKED_PER_SESSION) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) { map.delete(oldest) }
    }
    map.set(key, value)
  }

  private elapsedSeconds(sessionId?: string): number {
    const startTime = sessionId ? (this.sessionState.get(sessionId)?.startTime ?? Date.now()) : Date.now()
    return (Date.now() - startTime) / 1000
  }

  private handleHook(payload: HookPayload): void {
    const eventName = payload.hook_event_name
    log.debug(eventName, payload.tool_name || payload.agent_type || '')

    switch (eventName) {
      case 'SessionStart':
        this.handleSessionStart(payload)
        break
      case 'PreToolUse':
        this.handlePreToolUse(payload)
        break
      case 'PostToolUse':
        this.handlePostToolUse(payload)
        break
      case 'PostToolUseFailure':
        this.handlePostToolUseFailure(payload)
        break
      case 'SubagentStart':
        this.handleSubagentStart(payload)
        break
      case 'SubagentStop':
        this.handleSubagentStop(payload)
        break
      case 'Notification':
        this.handleNotification(payload)
        break
      case 'Stop':
        this.handleStop(payload)
        break
      case 'SessionEnd':
        this.handleSessionEnd(payload)
        break
    }
  }

  private handleSessionStart(payload: HookPayload): void {
    this.getOrCreateSession(payload.session_id)

    this.emit({
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME,
        isMain: true,
        task: `Session ${payload.session_id.slice(0, SESSION_ID_DISPLAY)}`,
      },
    }, payload.session_id)
  }

  private handlePreToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const args = summarizeInput(toolName, payload.tool_input)

    // If this is the first event and no session start was received, auto-spawn
    if (!this.sessionState.has(payload.session_id)) {
      this.handleSessionStart(payload)
    }

    // Remember Agent/Task dispatches so SubagentStart/Stop can be correlated
    if ((toolName === 'Task' || toolName === 'Agent') && payload.tool_use_id && payload.tool_input) {
      this.setBounded(this.getOrCreateSession(payload.session_id).dispatches, payload.tool_use_id, {
        label: resolveSubagentChildName(payload.tool_input),
        subagentType: typeof payload.tool_input.subagent_type === 'string' ? payload.tool_input.subagent_type.slice(0, 64) : undefined,
        startTime: Date.now(),
        claimed: false,
      })
    }

    // Teammate messages: SendMessage with a recipient (transcript watcher emits the same
    // events for watched sessions and the consumers drop these duplicates)
    if (toolName === 'SendMessage') {
      const links = extractToolUseLinks(toolName, payload.tool_input, agentName, payload.tool_use_id)
      if (links) {
        const known = this.getOrCreateSession(payload.session_id).links
        if (!known.has(links.link.linkId)) {
          // Bounded: the oldest remembered link makes room (a new edge must never be dropped forever)
          if (known.size >= TEAM_MAX_LINKS_PER_SESSION) {
            const oldest = known.values().next().value
            if (oldest !== undefined) known.delete(oldest)
          }
          known.add(links.link.linkId)
          this.emit({
            time: this.elapsedSeconds(payload.session_id),
            type: 'agent_link',
            payload: { ...links.link, sessionId: payload.session_id },
          }, payload.session_id)
        }
        if (links.message) {
          this.emit({
            time: this.elapsedSeconds(payload.session_id),
            type: 'message_sent',
            payload: { ...links.message, sessionId: payload.session_id },
          }, payload.session_id)
        }
      }
    }

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
        inputData: payload.tool_input ? extractInputData(toolName, payload.tool_input) : undefined,
        ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
      },
    }, payload.session_id)
  }

  private handlePostToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const isSubagentTool = toolName === 'Task' || toolName === 'Agent'
    const result = payload.tool_response ? summarizeResult(payload.tool_response, isSubagentTool ? MESSAGE_MAX : RESULT_MAX) : ''
    const tokenCost = estimateTokenCost(toolName, result)
    if (isSubagentTool && payload.tool_use_id) {
      this.sessionState.get(payload.session_id)?.dispatches.delete(payload.tool_use_id)
    }

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, extractFilePath(payload.tool_input), result)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, isSubagentTool ? MESSAGE_MAX : RESULT_MAX),
        tokenCost,
        ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
        ...(discovery ? { discovery } : {}),
      },
    }, payload.session_id)
  }

  private handlePostToolUseFailure(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: `[FAILED] ${(payload.tool_response ? summarizeResult(payload.tool_response) : '').slice(0, FAILED_RESULT_MAX)}`,
        tokenCost: 0,
        isError: true,
        ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
      },
    }, payload.session_id)
  }

  private handleSubagentStart(payload: HookPayload): void {
    // Track agent_id → name mapping for SubagentStop resolution, but do not
    // emit agent_spawn here.  The transcript parser independently spawns the
    // subagent using its description field (via resolveSubagentChildName),
    // which produces the user-facing name.  Emitting a second spawn from the
    // hook creates a duplicate node with a generic name like
    // "general-purpose-ab75a" alongside the correctly-named node.
    const agentType = payload.agent_type || 'subagent'
    const agentId = payload.agent_id || ''
    const sessionAgents = this.getOrCreateSession(payload.session_id).agentNames
    const childName = agentId ? `${agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}` : generateSubagentFallbackName(String(Date.now()), sessionAgents.size + 1)

    this.setBounded(sessionAgents, agentId, childName)

    // Correlate with the dispatch seen in PreToolUse: explicit tool_use_id, else the
    // oldest unclaimed dispatch of the same subagent type (else the oldest unclaimed).
    if (agentId) {
      const state = this.getOrCreateSession(payload.session_id)
      let toolUseId = payload.tool_use_id && state.dispatches.has(payload.tool_use_id) ? payload.tool_use_id : undefined
      if (!toolUseId) {
        const open = [...state.dispatches].filter(([, d]) => !d.claimed)
        toolUseId = (open.find(([, d]) => d.subagentType === agentType) ?? open[0])?.[0]
      }
      if (!toolUseId && typeof payload.tool_use_id === 'string') toolUseId = payload.tool_use_id
      const dispatch = toolUseId ? state.dispatches.get(toolUseId) : undefined
      if (dispatch) dispatch.claimed = true
      this.setBounded(state.agentDispatch, agentId, { toolUseId, startTime: dispatch?.startTime ?? Date.now() })
    }
  }

  private handleSubagentStop(payload: HookPayload): void {
    // Capture session state synchronously (the session may end before the read finishes)
    const agentId = payload.agent_id || ''
    const state = this.sessionState.get(payload.session_id)
    const childName = state?.agentNames.get(agentId) || 'subagent'
    const parentName = this.resolveAgentName(payload)
    const correlated = state?.agentDispatch.get(agentId)
    state?.agentDispatch.delete(agentId)
    const toolUseId = correlated?.toolUseId
    if (toolUseId) { state?.dispatches.delete(toolUseId) }

    // No readable transcript: nothing to wait for, emit right away (no file I/O at all).
    if (!isAllowedTranscriptPath(payload.agent_transcript_path)) {
      this.emitSubagentStop(payload, childName, parentName, correlated, toolUseId, fallbackReport(payload.last_assistant_message))
      return
    }

    // The transcript tail is read asynchronously, one read at a time, with a hard
    // timeout, so a flood of SubagentStop hooks cannot block the event loop.
    void this.transcriptLimiter
      .run(
        () => withTimeout(buildSubagentReportAsync(payload), SUBAGENT_TRANSCRIPT_TIMEOUT_MS, fallbackReport(payload.last_assistant_message)),
        fallbackReport(payload.last_assistant_message),
      )
      .then(report => {
        if (this.disposed) { return }
        this.emitSubagentStop(payload, childName, parentName, correlated, toolUseId, report)
      })
      .catch(e => log.error('SubagentStop failed:', e))
  }

  private emitSubagentStop(
    payload: HookPayload, childName: string, parentName: string,
    correlated: { toolUseId?: string; startTime: number } | undefined, toolUseId: string | undefined,
    report: string | undefined,
  ): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'subagent_return',
      payload: {
        child: childName,
        parent: parentName,
        summary: report || `${payload.agent_type} complete`,
        ...(toolUseId ? { toolUseId } : {}),
        ...(typeof payload.is_error === 'boolean' ? { isError: payload.is_error } : {}),
        ...(correlated ? { durationS: Math.round((Date.now() - correlated.startTime) / 100) / 10 } : {}),
        ...(report ? { tokenCost: estimateTokensFromText(report) } : {}),
      },
    }, payload.session_id)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: childName },
    }, payload.session_id)
  }

  private handleNotification(payload: HookPayload): void {
    if (payload.notification_type !== 'permission_prompt') return

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'permission_requested',
      payload: {
        agent: ORCHESTRATOR_NAME,
        message: payload.message || 'Permission needed',
        title: payload.title || 'Permission needed',
      },
    }, payload.session_id)
  }

  private handleStop(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME },
    }, payload.session_id)
  }

  private handleSessionEnd(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
    }, payload.session_id)

    // Last word on what was left out, then clean up per-session state to prevent unbounded Map growth
    const last = this.normalizers.get(payload.session_id)?.flush()
    if (last) { this._onEvent.fire({ ...last, sessionId: payload.session_id }) }
    this.normalizers.get(payload.session_id)?.dispose()
    this.normalizers.delete(payload.session_id)
    this.sessionState.delete(payload.session_id)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private resolveAgentName(payload: HookPayload): string {
    // If this event has an agent_id, look it up in the session's agent names.
    if (payload.agent_id) {
      const name = this.sessionState.get(payload.session_id)?.agentNames.get(payload.agent_id)
      if (name) return name
    }
    return ORCHESTRATOR_NAME
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    const norm = sessionId ? this.normalizerFor(sessionId) : this.unattributed
    for (const out of norm.process(event)) {
      this._onEvent.fire(sessionId ? { ...out, sessionId } : out)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.sessionState.clear()
    for (const n of this.normalizers.values()) n.dispose()
    this.normalizers.clear()
    this.unattributed.dispose()
    this._onEvent.dispose()
  }
}
