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
 *
 * Every watcher and timer callback runs through runGuarded: in the relay an uncaught exception
 * ends the process (#206). A session whose read throws is detached and can be reattached later.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, NORM_MAX_LINE_CHARS, ORCHESTRATOR_NAME, PI_MAX_WATCHED_SESSIONS,
  POLL_FALLBACK_MS, PREVIEW_MAX, RELAY_MAX_FILES_PER_DIR, RELAY_MAX_PROJECT_DIRS, RELAY_MAX_SESSION_FILE_BYTES,
  SCAN_INTERVAL_MS, SESSION_ID_DISPLAY, WATCH_SCAN_DEBOUNCE_MS,
} from './constants'
import { safeWatch, readTrackedLines, readLinesChunked, foldPathCase, isPathInside, runGuarded } from './fs-utils'
import { createLogger } from './logger'
import { ostr } from './event-normalize'
import { PiEventParser, PiEventState, createPiEventState, isSupportedPiVersion } from './pi-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('PiSessionWatcher')

const PI_LABEL_PREFIX = 'Pi '
/** The session header is a handful of fields; a first line larger than this is not one. */
const HEADER_MAX_BYTES = 64 * 1024
const HEADER_CHUNK_BYTES = 8 * 1024
/** A cwd longer than this is not a path this adapter shows. */
const CWD_MAX = 4096
/** Pi's own id rule (session-manager.ts assertValidSessionId) without the dot, which the observations
 *  and MCP id pattern refuse, plus a length cap. A session whose id has a dot is not shown. */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/
const SESSION_ID_MAX = 128
/** Quick scans (every SCAN_INTERVAL_MS, or a root event) only look at the newest names of each
 *  directory (names start with the creation timestamp); every Nth scan looks at all of them, so a
 *  resumed old session is still found. */
const QUICK_SCAN_FILES_PER_DIR = 20
const FULL_SCAN_EVERY = 30
/** Control characters (C0, DEL, C1) and bidi overrides: never part of a path shown to the user. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

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

type RetiredPiSession = Pick<WatchedPiSession, 'fileSize' | 'fileTail' | 'eventState' | 'sessionStartTime' | 'label'>

export interface PiSessionHeader {
  cwd: string | null
  /** False only while the first line is still being written (no newline yet, under the cap). */
  final: boolean
  /** Start of the session from the header `timestamp`, when it is a valid past date. */
  startMs?: number
  /** The header announces a version this adapter does not know. */
  unsupported?: true
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
 *  name is not a session file or the id breaks the id rule. */
export function piSessionIdFromFile(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null
  const base = name.slice(0, -'.jsonl'.length)
  const cut = base.indexOf('_')
  const id = cut >= 0 ? base.slice(cut + 1) : base
  if (!id || id.length > SESSION_ID_MAX || !SESSION_ID_RE.test(id)) return null
  return id
}

/** The session header (first line), read in bounded chunks. The cwd is kept only when it is an
 *  absolute path of at most CWD_MAX characters with no control or bidi character. */
export function readPiSessionHeader(filePath: string): PiSessionHeader {
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
      const header = parsed as { type?: unknown; cwd?: unknown; version?: unknown; timestamp?: unknown }
      if (header.type !== 'session') return { cwd: null, final: true }
      // A format this adapter was not checked against is not read at all: no session, no event
      if (!isSupportedPiVersion(header.version)) return { cwd: null, final: true, unsupported: true }
      const cwd = header.cwd
      if (typeof cwd !== 'string' || !cwd || cwd.length > CWD_MAX || UNSAFE_PATH_CHARS.test(cwd) || !path.isAbsolute(cwd)) {
        return { cwd: null, final: true }
      }
      const startMs = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN
      return { cwd, final: true, ...(Number.isFinite(startMs) && startMs <= Date.now() ? { startMs } : {}) }
    } finally { fs.closeSync(fd) }
  } catch { return { cwd: null, final: false } }
}

/** Regular-file entries (symbolic links are not followed), newest names first. */
function sessionFileNames(entries: fs.Dirent[]): string[] {
  return entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort().reverse()
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class PiSessionWatcher implements AgentSessionWatcher {
  private rootWatcher: fs.FSWatcher | null = null
  private sessions = new Map<string, WatchedPiSession>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  private scanDebounce: NodeJS.Timeout | null = null
  private scanCount = 0
  /** Header of files already read (a header never changes once complete), bounded. */
  private headerCache = new Map<string, PiSessionHeader>()
  /** One-shot flags so each hint is logged at most once per process. */
  private mismatchWarned = false
  private capWarned = false
  private scanCapWarned = false
  private versionWarned = false
  /** Read position of released sessions: a log that resumes restarts where it stopped (no history replay). */
  private retired = new Map<string, RetiredPiSession>()

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

    this.guardedScan()
    this.scanInterval = setInterval(() => this.guardedScan(), SCAN_INTERVAL_MS)

    // A new project is a new directory under the root (a new file, with PI_CODING_AGENT_SESSION_DIR);
    // every line written there fires too, hence the debounce.
    const root = piSessionsRoot()
    if (fs.existsSync(root)) {
      try { this.rootWatcher = safeWatch(root, () => this.requestScan(), { recursive: false }) }
      catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private guardedScan(): void {
    runGuarded(() => this.scanForSessions(), err => log.warn('Scan Pi en échec :', err))
  }

  /** One scan armed WATCH_SCAN_DEBOUNCE_MS after the first root event (no endless postponement). */
  private requestScan(): void {
    if (this.scanDebounce) return
    this.scanDebounce = setTimeout(() => {
      this.scanDebounce = null
      this.guardedScan()
    }, WATCH_SCAN_DEBOUNCE_MS)
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedPiSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'pi', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  /** `.jsonl` files at the root and one level below, newest names first, bounded like the Claude
   *  discovery. Directories are taken by most recent modification (a new session file touches it). */
  private listSessionFiles(root: string, perDir: number): { sessionId: string; filePath: string }[] {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) }
    catch { return [] }

    const out: { sessionId: string; filePath: string }[] = []
    const take = (dir: string, names: string[]) => {
      if (names.length > RELAY_MAX_FILES_PER_DIR) this.warnScanCap()
      let count = 0
      for (const name of names) {
        if (count >= Math.min(perDir, RELAY_MAX_FILES_PER_DIR)) break
        const sessionId = piSessionIdFromFile(name)
        if (!sessionId) continue
        count++
        out.push({ sessionId, filePath: path.join(dir, name) })
      }
    }

    take(root, sessionFileNames(entries))
    const dirs: { dir: string; mtime: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      let mtime = 0
      try { mtime = fs.statSync(dir).mtimeMs } catch { continue }
      dirs.push({ dir, mtime })
    }
    if (dirs.length > RELAY_MAX_PROJECT_DIRS) this.warnScanCap()
    dirs.sort((a, b) => b.mtime - a.mtime)
    for (const { dir } of dirs.slice(0, RELAY_MAX_PROJECT_DIRS)) {
      let sub: fs.Dirent[]
      try { sub = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      take(dir, sessionFileNames(sub))
    }
    return out
  }

  private warnScanCap(): void {
    if (this.scanCapWarned) return
    this.scanCapWarned = true
    log.warn(`Pi : plus de ${RELAY_MAX_PROJECT_DIRS} dossiers ou ${RELAY_MAX_FILES_PER_DIR} fichiers par dossier sous ${piSessionsRoot()} ; seuls les plus récents sont examinés.`)
  }

  private header(filePath: string): PiSessionHeader {
    const cached = this.headerCache.get(filePath)
    if (cached) return cached
    const header = readPiSessionHeader(filePath)
    if (header.unsupported && !this.versionWarned) {
      this.versionWarned = true
      log.warn(`Pi : format de session non reconnu (version de l'en-tête) dans ${path.basename(filePath)} : session ignorée.`)
    }
    if (header.final) {
      if (this.headerCache.size >= PI_MAX_WATCHED_SESSIONS * 40) {
        const oldest = this.headerCache.keys().next().value
        if (oldest !== undefined) this.headerCache.delete(oldest)
      }
      this.headerCache.set(filePath, header)
    }
    return header
  }

  private scanForSessions(): void {
    this.releaseEndedSessions()
    const root = piSessionsRoot()
    const full = this.scanCount++ % FULL_SCAN_EVERY === 0

    const candidates: { sessionId: string; filePath: string; stat: fs.Stats }[] = []
    for (const { sessionId, filePath } of this.listSessionFiles(root, full ? RELAY_MAX_FILES_PER_DIR : QUICK_SCAN_FILES_PER_DIR)) {
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
      const header = this.header(filePath)
      // No readable session header: not a Pi session file (or not yet written)
      if (!header.cwd) continue
      if (this.workspacePath && !this.matchesWorkspace(header.cwd)) { skippedByWorkspace++; continue }

      if (this.sessions.size >= PI_MAX_WATCHED_SESSIONS) {
        if (!this.capWarned) {
          this.capWarned = true
          log.warn(`Plafond de ${PI_MAX_WATCHED_SESSIONS} sessions Pi suivies atteint : les plus anciennes sont ignorées.`)
        }
        break
      }
      this.attachSession(sessionId, filePath, stat, header)
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

  /** Stop watching a session (watcher, timers freed) and keep its read position for a later reattach. */
  private retire(id: string, s: WatchedPiSession): void {
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
  }

  /** Detach sessions ended for more than ACTIVE_SESSION_AGE_S. The scan reattaches them if their file resumes. */
  private releaseEndedSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (!s.sessionCompleted || (now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      this.retire(id, s)
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  /** A session whose read threw is detached; the scan reattaches it from the same offset if the file resumes. */
  private detachOnError(sessionId: string, err: unknown): void {
    const s = this.sessions.get(sessionId)
    log.warn(`Session Pi ${sessionId.slice(0, SESSION_ID_DISPLAY)} : lecture en échec, détachée :`, err)
    if (!s) return
    this.retire(sessionId, s)
    if (s.sessionDetected) this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: s.label })
  }

  private resolvePath(p: string): string {
    try { return fs.realpathSync(p) } catch { return p }
  }

  /** The session matches when its header cwd is the workspace or inside it. Case is folded on
   *  Windows, where tools disagree on drive-letter case. */
  private matchesWorkspace(cwd: string): boolean {
    if (!this.workspacePath) return true
    return isPathInside(foldPathCase(this.resolvePath(cwd)), foldPathCase(this.workspacePath))
  }

  private attachSession(sessionId: string, filePath: string, stat: fs.Stats, header: PiSessionHeader): void {
    const label = `${PI_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`
    let warned = false

    // Parser built once per session so the delegate closures capture the right session
    const parser = new PiEventParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (raw) => {
        const s = this.sessions.get(sessionId)
        const newLabel = ostr(raw, PREVIEW_MAX)?.trim()
        if (!s || !newLabel) return
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
      ...(header.cwd ? { cwd: header.cwd } : {}),
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      // The header says when the session started; a file time is only a fallback
      sessionStartTime: header.startMs ?? (stat.birthtimeMs || stat.mtimeMs),
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
    // The read may have thrown and detached the session
    if (this.sessions.get(sessionId) !== session) return

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
      // Skip the rest of the history rather than re-reading it whole (and re-emitting it) from 0
      session.fileSize = size
      session.fileTail = ''
      log.debug('History read failed:', session.filePath, err)
    }
  }

  /** Called from watchers and timers: an exception is logged and detaches the session (#206). */
  private readNewLines(sessionId: string): void {
    runGuarded(() => this.readNewLinesUnguarded(sessionId), err => this.detachOnError(sessionId, err))
  }

  private readNewLinesUnguarded(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // One read allocates the whole growth: past the cap, the new content is skipped, never read.
    // Same for a line that never ends: its bytes are dropped instead of growing the tail forever.
    let size = 0
    try { size = fs.statSync(session.filePath).size } catch { return }
    if (size - session.fileSize > RELAY_MAX_SESSION_FILE_BYTES || session.fileTail.length > NORM_MAX_LINE_CHARS) {
      log.warn(`Session Pi ${sessionId.slice(0, SESSION_ID_DISPLAY)} : contenu au-delà des plafonds de lecture ignoré.`)
      session.parser.normalizer.noteMalformed()
      session.fileSize = size
      session.fileTail = ''
      return
    }

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
    session.inactivityTimer = setTimeout(() => runGuarded(() => {
      if (session.sessionCompleted) return
      session.sessionCompleted = true
      this._onEvent.fire({
        time: (Date.now() - session.sessionStartTime) / 1000,
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, sessionEnd: true, inactivity: true },
        sessionId,
      })
      this._onSessionLifecycle.fire(this.lifecycle('ended', session))
    }, err => log.warn('Fin de session Pi en échec :', err)), INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    if (this.scanDebounce) { clearTimeout(this.scanDebounce); this.scanDebounce = null }
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
