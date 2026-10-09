/**
 * Watches local GitHub Copilot sessions at ~/.copilot/session-state/<session-id>/
 *
 * Copilot (CLI and app) keeps one directory per session: `events.jsonl` is the event log and
 * `workspace.yaml` carries the cwd / git_root the session ran in. Discovery lists the session
 * directories, keeps the recently modified ones whose cwd or git_root is the selected workspace
 * (or inside it), and tails their events.jsonl.
 *
 * Local files only: Copilot cloud agent sessions never reach this directory. Respects
 * COPILOT_HOME for non-default installs.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, COPILOT_MAX_WATCHED_SESSIONS, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { safeWatch, readTrackedLines, foldPathCase } from './fs-utils'
import { createLogger } from './logger'
import {
  CopilotEventParser, CopilotEventState, createCopilotEventState,
} from './copilot-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('CopilotSessionWatcher')

const EVENTS_FILE = 'events.jsonl'
const WORKSPACE_FILE = 'workspace.yaml'
/** A workspace.yaml is a handful of `key: value` lines; anything bigger is not one. */
const WORKSPACE_FILE_MAX = 64 * 1024
const COPILOT_LABEL_PREFIX = 'Copilot '

interface WatchedCopilotSession {
  sessionId: string
  filePath: string
  cwd?: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  /** Bytes past the last newline of the previous read, prepended to the next chunk. */
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  eventState: CopilotEventState
  parser: CopilotEventParser
}

export function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
}

export function sessionStateRoot(): string {
  return path.join(copilotHome(), 'session-state')
}

/** The `cwd` / `git_root` of a workspace.yaml (flat `key: value` lines, optionally quoted).
 *  Null when the file is missing, oversized or carries neither. */
export function readSessionWorkspace(sessionDir: string): { cwd?: string; gitRoot?: string } | null {
  let text: string
  try {
    const file = path.join(sessionDir, WORKSPACE_FILE)
    if (fs.statSync(file).size > WORKSPACE_FILE_MAX) return null
    text = fs.readFileSync(file, 'utf-8')
  } catch { return null }

  const out: { cwd?: string; gitRoot?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(cwd|git_root):\s*(.*?)\s*$/)
    if (!m) continue
    let value = m[2]
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    if (!value) continue
    if (m[1] === 'cwd') out.cwd = value
    else out.gitRoot = value
  }
  return out.cwd || out.gitRoot ? out : null
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class CopilotSessionWatcher implements AgentSessionWatcher {
  private rootWatcher: fs.FSWatcher | null = null
  private sessions = new Map<string, WatchedCopilotSession>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  /** One-shot flag so the workspace-mismatch hint is logged at most once per process. */
  private mismatchWarned = false
  /** One-shot flag for the tracked-sessions cap warning. */
  private capWarned = false
  /** Read position of released sessions: a log that resumes restarts where it stopped (no history replay). */
  private retired = new Map<string, Pick<WatchedCopilotSession, 'fileSize' | 'fileTail' | 'eventState' | 'sessionStartTime' | 'label'>>()

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a filter — a session is attached only if its cwd or git_root is this
   *  path or inside it. Pass null/undefined to attach to any Copilot session. */
  constructor(private readonly workspace?: string | null) {}

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected && !s.sessionCompleted) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected && !s.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      status: s.sessionCompleted ? 'completed' : 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
      runtime: 'copilot',
      ...(s.cwd ? { cwd: s.cwd } : {}),
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (!session.sessionDetected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire(this.lifecycle('started', session))
    }
  }

  start(): void {
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }

    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    // A new session is a new directory under the root.
    const root = sessionStateRoot()
    if (fs.existsSync(root)) {
      try { this.rootWatcher = safeWatch(root, () => this.scanForSessions(), { recursive: false }) }
      catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedCopilotSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'copilot', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  private scanForSessions(): void {
    this.releaseEndedSessions()
    const root = sessionStateRoot()
    let names: string[]
    try { names = fs.readdirSync(root) }
    catch { return }

    const candidates: { sessionId: string; dir: string; filePath: string; stat: fs.Stats }[] = []
    for (const name of names) {
      if (this.sessions.has(name)) continue
      const dir = path.join(root, name)
      const filePath = path.join(dir, EVENTS_FILE)
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      if ((Date.now() - stat.mtimeMs) / 1000 > ACTIVE_SESSION_AGE_S) continue
      candidates.push({ sessionId: name, dir, filePath, stat })
    }

    // Most recent first: the cap on tracked sessions goes to the most active ones
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    let skippedByWorkspace = 0
    for (const { sessionId, dir, filePath, stat } of candidates) {
      const meta = readSessionWorkspace(dir)
      if (this.workspacePath && !this.matchesWorkspace(meta)) { skippedByWorkspace++; continue }

      if (this.sessions.size >= COPILOT_MAX_WATCHED_SESSIONS) {
        if (!this.capWarned) {
          this.capWarned = true
          log.warn(`Plafond de ${COPILOT_MAX_WATCHED_SESSIONS} sessions Copilot suivies atteint : les plus anciennes sont ignorées.`)
        }
        break
      }
      this.attachSession(sessionId, filePath, stat, meta?.cwd)
    }

    // Recent Copilot activity exists but none of it belongs to this workspace — the #1 reason
    // users see no Copilot events. Say so once.
    if (skippedByWorkspace > 0 && this.sessions.size === 0 && !this.mismatchWarned) {
      this.mismatchWarned = true
      log.warn(
        `Found ${skippedByWorkspace} recent Copilot session(s), but none ran in ${this.workspacePath}. ` +
        `Copilot sessions are only shown for the current workspace — launch the visualizer from the ` +
        `directory where Copilot runs (or open that folder in VS Code).`,
      )
    }
  }

  /** Detach sessions ended for more than ACTIVE_SESSION_AGE_S (watcher, timers, parser freed).
   *  The scan reattaches them if their log resumes. */
  private releaseEndedSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (!s.sessionCompleted || (now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
      this.sessions.delete(id)
      this.retired.delete(id)
      this.retired.set(id, {
        fileSize: s.fileSize, fileTail: s.fileTail, eventState: s.eventState,
        sessionStartTime: s.sessionStartTime, label: s.label,
      })
      if (this.retired.size > COPILOT_MAX_WATCHED_SESSIONS * 4) {
        const oldest = this.retired.keys().next().value
        if (oldest !== undefined) this.retired.delete(oldest)
      }
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  private resolvePath(p: string): string {
    try { return fs.realpathSync(p) } catch { return p }
  }

  /** The session matches when its cwd or git_root is the workspace or inside it. Case is folded on
   *  Windows, where tools disagree on drive-letter case. */
  private matchesWorkspace(meta: { cwd?: string; gitRoot?: string } | null): boolean {
    if (!this.workspacePath || !meta) return !this.workspacePath
    const workspace = foldPathCase(this.workspacePath)
    return [meta.cwd, meta.gitRoot].some(p => {
      if (!p) return false
      const candidate = foldPathCase(this.resolvePath(p))
      return candidate === workspace || candidate.startsWith(workspace + path.sep)
    })
  }

  private attachSession(sessionId: string, filePath: string, stat: fs.Stats, cwd?: string): void {
    const label = `${COPILOT_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`

    // Parser built once per session so the delegate closures capture the right session
    const parser = new CopilotEventParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s || !s.label.startsWith(COPILOT_LABEL_PREFIX)) return // only replace the auto-label
        s.label = newLabel
        this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: newLabel })
      },
    })

    const session: WatchedCopilotSession = {
      sessionId,
      filePath,
      ...(cwd ? { cwd } : {}),
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: false,
      label,
      eventState: createCopilotEventState(),
      parser,
    }
    const retired = this.retired.get(sessionId)
    if (retired) {
      Object.assign(session, retired)
      this.retired.delete(sessionId)
    }
    this.sessions.set(sessionId, session)

    // Drain existing content first, so late-opening panels see the full history.
    this.readNewLines(sessionId)

    session.sessionDetected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire(this.lifecycle('started', session))

    try {
      session.fileWatcher = safeWatch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

    // fs.watch sometimes silently stops after a long idle — poll as a backup.
    session.pollTimer = setInterval(() => this.readNewLines(sessionId), POLL_FALLBACK_MS)

    this.resetInactivityTimer(sessionId)
    log.info(`Attached to session ${sessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const lines = readTrackedLines(session.filePath, session)
    if (!lines) return
    session.lastActivityTime = Date.now()

    // New content in a session marked complete on inactivity means the user resumed it.
    if (session.sessionCompleted) {
      session.sessionCompleted = false
      this._onSessionLifecycle.fire(this.lifecycle('started', session))
      log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} re-activated after idle`)
    }

    for (const line of lines) {
      try { session.parser.processLine(line, session.eventState) }
      catch (err) { log.debug('Parser threw on line:', err) }
    }

    this.resetInactivityTimer(sessionId)
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
    session.inactivityTimer = setTimeout(() => {
      if (session.sessionCompleted) return
      session.sessionCompleted = true
      this._onEvent.fire({
        time: (Date.now() - session.sessionStartTime) / 1000,
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, sessionEnd: true, inactivity: true },
        sessionId,
      })
      this._onSessionLifecycle.fire(this.lifecycle('ended', session))
    }, INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
    }
    this.sessions.clear()
    this.retired.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
