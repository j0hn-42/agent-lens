/**
 * Watches local Pi coding agent sessions (#238).
 *
 * Pi writes one JSONL file per session: `<root>/--<encoded cwd>--/<timestamp>_<session id>.jsonl`,
 * root `~/.pi/agent/sessions` (pi docs/session-format.md). The root follows Pi's own variables:
 * `PI_CODING_AGENT_DIR` moves the agent directory (sessions under `<dir>/sessions`), and
 * `PI_CODING_AGENT_SESSION_DIR` names a session directory used as is, with the files directly in it
 * (pi src/config.ts and src/main.ts). Both layouts are read: `.jsonl` files at the root and one
 * level below.
 *
 * The workspace is matched on the `cwd` of the session header (first line), never on the directory
 * name, whose encoding is lossy. Discovery keeps the recently modified files whose cwd is the
 * selected workspace (or inside it) and tails them.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME, PI_MAX_WATCHED_SESSIONS,
  POLL_FALLBACK_MS, RELAY_MAX_FILES_PER_DIR, RELAY_MAX_PROJECT_DIRS, RELAY_MAX_SESSION_FILE_BYTES,
  SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { safeWatch, readTrackedLines, readLinesChunked, foldPathCase, isPathInside } from './fs-utils'
import { createLogger } from './logger'
import { PiEventParser, PiEventState, createPiEventState, isSupportedPiVersion } from './pi-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('PiSessionWatcher')

const PI_LABEL_PREFIX = 'Pi '
/** The session header is a handful of fields; a first line larger than this is not one. */
const HEADER_MAX_BYTES = 64 * 1024
const HEADER_CHUNK_BYTES = 8 * 1024
/** Pi's own rule for session ids (session-manager.ts assertValidSessionId), plus a length cap. */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const SESSION_ID_MAX = 128

interface WatchedPiSession {
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
  eventState: PiEventState
  parser: PiEventParser
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Directory holding the Pi session files. */
export function piSessionsRoot(): string {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  if (sessionDir) return expandTilde(sessionDir)
  const agentDir = process.env.PI_CODING_AGENT_DIR
  return path.join(agentDir ? expandTilde(agentDir) : path.join(os.homedir(), '.pi', 'agent'), 'sessions')
}

/** Session id of a `<timestamp>_<id>.jsonl` file name (the timestamp never holds `_`); null when the
 *  name is not a session file or the id breaks Pi's own id rule. */
export function piSessionIdFromFile(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null
  const base = name.slice(0, -'.jsonl'.length)
  const cut = base.indexOf('_')
  const id = cut >= 0 ? base.slice(cut + 1) : base
  if (!id || id.length > SESSION_ID_MAX || !SESSION_ID_RE.test(id)) return null
  return id
}

/** The cwd of the session header (first line), read in bounded chunks. `final` is false only while
 *  the first line is still being written (no newline yet, under the cap): a later read may differ. */
export function readPiSessionHeader(filePath: string): { cwd: string | null; final: boolean; unsupported?: true } {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const chunks: Buffer[] = []
      let total = 0
      let end = -1
      while (total < HEADER_MAX_BYTES) {
        const buf = Buffer.alloc(HEADER_CHUNK_BYTES)
        const read = fs.readSync(fd, buf, 0, buf.length, total)
        if (read <= 0) break
        const filled = buf.subarray(0, read)
        const nl = filled.indexOf(0x0a)
        chunks.push(filled)
        total += read
        if (nl >= 0) { end = total - read + nl; break }
      }
      if (end < 0) return { cwd: null, final: total >= HEADER_MAX_BYTES }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).subarray(0, end).toString('utf-8')) }
      catch { return { cwd: null, final: true } }
      if (typeof parsed !== 'object' || parsed === null) return { cwd: null, final: true }
      const header = parsed as { type?: unknown; cwd?: unknown; version?: unknown }
      if (header.type !== 'session' || typeof header.cwd !== 'string' || !header.cwd) return { cwd: null, final: true }
      // A format this adapter was not checked against is not read at all: no session, no event
      if (!isSupportedPiVersion(header.version)) return { cwd: null, final: true, unsupported: true }
      return { cwd: header.cwd, final: true }
    } finally { fs.closeSync(fd) }
  } catch { return { cwd: null, final: false } }
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class PiSessionWatcher implements AgentSessionWatcher {
  private rootWatcher: fs.FSWatcher | null = null
  private sessions = new Map<string, WatchedPiSession>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  /** Header cwd of files already read (a header never changes once complete), bounded. */
  private headerCache = new Map<string, string | null>()
  /** One-shot flags so each hint is logged at most once per process. */
  private mismatchWarned = false
  private capWarned = false
  private scanCapWarned = false
  private versionWarned = false
  /** Read position of released sessions: a log that resumes restarts where it stopped (no history replay). */
  private retired = new Map<string, Pick<WatchedPiSession, 'fileSize' | 'fileTail' | 'eventState' | 'sessionStartTime' | 'label'>>()

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a filter: a session is attached only if its header cwd is this path or
   *  inside it. Pass null/undefined to attach to any Pi session. */
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
      runtime: 'pi',
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

    // A new project is a new directory under the root; new files inside it are found by the interval.
    const root = piSessionsRoot()
    if (fs.existsSync(root)) {
      try { this.rootWatcher = safeWatch(root, () => this.scanForSessions(), { recursive: false }) }
      catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedPiSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'pi', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  /** `.jsonl` files at the root and one level below, bounded like the Claude discovery. */
  private listSessionFiles(root: string): { sessionId: string; filePath: string }[] {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) }
    catch { return [] }

    const out: { sessionId: string; filePath: string }[] = []
    const take = (dir: string, names: string[]) => {
      let count = 0
      for (const name of names) {
        const sessionId = piSessionIdFromFile(name)
        if (!sessionId) continue
        if (++count > RELAY_MAX_FILES_PER_DIR) { this.warnScanCap(); break }
        out.push({ sessionId, filePath: path.join(dir, name) })
      }
    }

    take(root, entries.filter(e => e.isFile()).map(e => e.name))
    let dirs = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (++dirs > RELAY_MAX_PROJECT_DIRS) { this.warnScanCap(); break }
      const dir = path.join(root, entry.name)
      let names: string[]
      try { names = fs.readdirSync(dir) } catch { continue }
      take(dir, names)
    }
    return out
  }

  private warnScanCap(): void {
    if (this.scanCapWarned) return
    this.scanCapWarned = true
    log.warn(`Pi : plus de ${RELAY_MAX_PROJECT_DIRS} dossiers ou ${RELAY_MAX_FILES_PER_DIR} fichiers par dossier sous ${piSessionsRoot()} ; le surplus n'est pas examiné.`)
  }

  private headerCwd(filePath: string): string | null {
    if (this.headerCache.has(filePath)) return this.headerCache.get(filePath) ?? null
    const { cwd, final, unsupported } = readPiSessionHeader(filePath)
    if (unsupported && !this.versionWarned) {
      this.versionWarned = true
      log.warn(`Pi : format de session non reconnu (version de l'en-tête) dans ${path.basename(filePath)} : session ignorée.`)
    }
    if (final) {
      if (this.headerCache.size >= PI_MAX_WATCHED_SESSIONS * 40) {
        const oldest = this.headerCache.keys().next().value
        if (oldest !== undefined) this.headerCache.delete(oldest)
      }
      this.headerCache.set(filePath, cwd)
    }
    return cwd
  }

  private scanForSessions(): void {
    this.releaseEndedSessions()
    const root = piSessionsRoot()

    const candidates: { sessionId: string; filePath: string; stat: fs.Stats }[] = []
    for (const { sessionId, filePath } of this.listSessionFiles(root)) {
      if (this.sessions.has(sessionId)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      if (stat.size > RELAY_MAX_SESSION_FILE_BYTES) continue
      if ((Date.now() - stat.mtimeMs) / 1000 > ACTIVE_SESSION_AGE_S) continue
      candidates.push({ sessionId, filePath, stat })
    }

    // Most recent first: the cap on tracked sessions goes to the most active ones
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    let skippedByWorkspace = 0
    for (const { sessionId, filePath, stat } of candidates) {
      if (this.sessions.has(sessionId)) continue
      const cwd = this.headerCwd(filePath)
      // No readable session header: not a Pi session file (or not yet written)
      if (!cwd) continue
      if (this.workspacePath && !this.matchesWorkspace(cwd)) { skippedByWorkspace++; continue }

      if (this.sessions.size >= PI_MAX_WATCHED_SESSIONS) {
        if (!this.capWarned) {
          this.capWarned = true
          log.warn(`Plafond de ${PI_MAX_WATCHED_SESSIONS} sessions Pi suivies atteint : les plus anciennes sont ignorées.`)
        }
        break
      }
      this.attachSession(sessionId, filePath, stat, cwd)
    }

    if (skippedByWorkspace > 0 && this.sessions.size === 0 && !this.mismatchWarned) {
      this.mismatchWarned = true
      log.warn(
        `Found ${skippedByWorkspace} recent Pi session(s), but none ran in ${this.workspacePath}. ` +
        `Pi sessions are only shown for the current workspace — launch the visualizer from the ` +
        `directory where Pi runs (or open that folder in VS Code).`,
      )
    }
  }

  /** Detach sessions ended for more than ACTIVE_SESSION_AGE_S (watcher, timers, parser freed).
   *  The scan reattaches them if their file resumes. */
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
      if (this.retired.size > PI_MAX_WATCHED_SESSIONS * 4) {
        const oldest = this.retired.keys().next().value
        if (oldest !== undefined) this.retired.delete(oldest)
      }
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  private resolvePath(p: string): string {
    try { return fs.realpathSync(p) } catch { return p }
  }

  /** The session matches when its header cwd is the workspace or inside it. Case is folded on
   *  Windows, where tools disagree on drive-letter case. */
  private matchesWorkspace(cwd: string): boolean {
    if (!this.workspacePath) return true
    if (!path.isAbsolute(cwd)) return false
    return isPathInside(foldPathCase(this.resolvePath(cwd)), foldPathCase(this.workspacePath))
  }

  private attachSession(sessionId: string, filePath: string, stat: fs.Stats, cwd: string): void {
    const label = `${PI_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`
    let warned = false

    // Parser built once per session so the delegate closures capture the right session
    const parser = new PiEventParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s) return
        s.label = newLabel
        this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: newLabel })
      },
      warn: (message) => {
        if (warned) return
        warned = true
        log.warn(`${message} (${sessionId.slice(0, SESSION_ID_DISPLAY)})`)
      },
    })

    const session: WatchedPiSession = {
      sessionId,
      filePath,
      cwd,
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
      eventState: createPiEventState(),
      parser,
    }
    const retired = this.retired.get(sessionId)
    if (retired) {
      Object.assign(session, retired)
      this.retired.delete(sessionId)
    }
    this.sessions.set(sessionId, session)

    // Drain existing content first (in bounded chunks), so late-opening panels see the full history.
    if (!retired) this.drainHistory(session, stat.size)
    else this.readNewLines(sessionId)

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

  private drainHistory(session: WatchedPiSession, size: number): void {
    try {
      for (const line of readLinesChunked(session.filePath, size, undefined, session)) {
        try { session.parser.processLine(line, session.eventState) }
        catch (err) { log.debug('Parser threw on line:', err) }
      }
    } catch (err) {
      log.debug('History read failed:', session.filePath, err)
    }
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
    this.headerCache.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
