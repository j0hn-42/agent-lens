/**
 * Watches local Gemini CLI sessions (#238).
 *
 * Gemini CLI writes one JSONL file per session: `<home>/.gemini/tmp/<project>/chats/session-<timestamp>-<id>.jsonl`
 * (chatRecordingService.ts, docs/cli/session-management.md). `<home>` is `$GEMINI_CLI_HOME` when set,
 * else the user's home (gemini-cli utils/paths.ts `homedir`). `<project>` was the sha256 of the project
 * root, and is now a short id from the CLI's own project registry: the directory name is therefore
 * never read. Every `chats/*.jsonl` of every project directory is swept instead, and the first
 * record of each file (`sessionId`, `projectHash`) decides: the hash is the sha256 of the project
 * root (getProjectHash), compared with the hash of the selected workspace (as given, and resolved).
 * The metadata has no working directory, so a session is only given a `cwd` when the workspace hash
 * matched, and none otherwise.
 *
 * Sub-agent chat files (`kind: "subagent"`, nested under a directory named after the parent session)
 * are not listed and not read: no parent/child link is guessed.
 *
 * A resumed session is rewritten by the CLI (temp file + rename): a changed inode restarts the read
 * at 0, in bounded chunks, and the parser's per-message memory keeps already shown messages from
 * appearing twice (a replay mode covers the ids the bounded memory dropped).
 * Symbolic links are never followed: not the `chats` directory, not a session file, not one swapped in
 * after attach (the session is detached).
 *
 * Every watcher and timer callback runs through runGuarded: in the relay an uncaught exception ends
 * the process (#206). A session whose read throws is detached and can be reattached later.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, NORM_MAX_LINE_CHARS, ORCHESTRATOR_NAME, GEMINI_MAX_WATCHED_SESSIONS,
  POLL_FALLBACK_MS, PREVIEW_MAX, RELAY_MAX_FILES_PER_DIR, RELAY_MAX_PROJECT_DIRS, RELAY_MAX_SESSION_FILE_BYTES,
  SCAN_INTERVAL_MS, SESSION_ID_DISPLAY, WATCH_SCAN_DEBOUNCE_MS,
} from './constants'
import { safeWatch, readTrackedLines, readLinesChunked, runGuarded } from './fs-utils'
import { createLogger } from './logger'
import { ostr } from './event-normalize'
import { GeminiEventParser, GeminiEventState, createGeminiEventState, geminiProjectHash } from './gemini-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('GeminiSessionWatcher')

const GEMINI_LABEL_PREFIX = 'Gemini '
/** The metadata record is a handful of fields; a first line larger than this is not one. */
const HEADER_MAX_BYTES = 64 * 1024
const HEADER_CHUNK_BYTES = 8 * 1024
/** Id rule of the observations and MCP id pattern (no dot), plus a length cap. */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/
const SESSION_ID_MAX = 128
const SESSION_FILE_PREFIX = 'session-'
/** Quick scans only look at the newest names of each chats directory; every Nth scan looks at all. */
const QUICK_SCAN_FILES_PER_DIR = 20
const FULL_SCAN_EVERY = 30

interface WatchedGeminiSession {
  sessionId: string
  filePath: string
  cwd?: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  /** Bytes past the last newline of the previous read, prepended to the next chunk. */
  fileTail: string
  /** Inode of the file at the last read: a new one means the CLI rewrote the file. */
  ino: number
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  label: string
  eventState: GeminiEventState
  parser: GeminiEventParser
}

type RetiredGeminiSession = Pick<WatchedGeminiSession, 'fileSize' | 'fileTail' | 'ino' | 'eventState' | 'sessionStartTime' | 'label'>

export interface GeminiSessionHeader {
  sessionId: string | null
  projectHash: string | null
  /** False only while the first line is still being written (no newline yet, under the cap). */
  final: boolean
  /** Start of the session from `startTime`, when it is a valid past date. */
  startMs?: number
  /** The file is a sub-agent chat, not read. */
  subagent?: true
}

/** Directory holding the per-project folders of Gemini CLI: `<home>/.gemini/tmp`. */
export function geminiTmpRoot(): string {
  const home = process.env.GEMINI_CLI_HOME || os.homedir()
  return path.join(home, '.gemini', 'tmp')
}

/** The first record of a chat file, read in bounded chunks. */
export function readGeminiSessionHeader(filePath: string): GeminiSessionHeader {
  const none = (final: boolean): GeminiSessionHeader => ({ sessionId: null, projectHash: null, final })
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
      if (end < 0) return none(total >= HEADER_MAX_BYTES)
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).subarray(0, end).toString('utf-8')) }
      catch { return none(true) }
      if (typeof parsed !== 'object' || parsed === null) return none(true)
      const h = parsed as { sessionId?: unknown; projectHash?: unknown; startTime?: unknown; kind?: unknown; id?: unknown }
      if (typeof h.sessionId !== 'string' || typeof h.projectHash !== 'string' || h.id !== undefined) return none(true)
      if (!h.sessionId || h.sessionId.length > SESSION_ID_MAX || !SESSION_ID_RE.test(h.sessionId)) return none(true)
      if (h.kind === 'subagent') return { sessionId: null, projectHash: null, final: true, subagent: true }
      const startMs = typeof h.startTime === 'string' ? Date.parse(h.startTime) : NaN
      return {
        sessionId: h.sessionId, projectHash: h.projectHash, final: true,
        ...(Number.isFinite(startMs) && startMs <= Date.now() ? { startMs } : {}),
      }
    } finally { fs.closeSync(fd) }
  } catch { return none(false) }
}

/** Regular-file entries named like a chat file (symbolic links are not followed), newest names first. */
function chatFileNames(entries: fs.Dirent[]): string[] {
  return entries
    .filter(e => e.isFile() && e.name.startsWith(SESSION_FILE_PREFIX) && e.name.endsWith('.jsonl'))
    .map(e => e.name).sort().reverse()
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class GeminiSessionWatcher implements AgentSessionWatcher {
  private rootWatcher: fs.FSWatcher | null = null
  private sessions = new Map<string, WatchedGeminiSession>()
  /** Workspace path(s) whose sha256 is compared with the project hash of each file. */
  private workspaceRoots: string[] = []
  private scanInterval: NodeJS.Timeout | null = null
  private scanDebounce: NodeJS.Timeout | null = null
  private scanCount = 0
  /** Header of files already read (a header never changes once complete), bounded. */
  private headerCache = new Map<string, GeminiSessionHeader>()
  private mismatchWarned = false
  private capWarned = false
  private scanCapWarned = false
  /** Read position of released sessions: a log that resumes restarts where it stopped (no history replay). */
  private retired = new Map<string, RetiredGeminiSession>()
  /** > 0 while the history of a file is read at attach: its events are replayed, not live (#390) */
  private historyDepth = 0

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a filter: a session is attached only if its project hash is the hash of
   *  this path. Pass null/undefined to attach to any Gemini session. */
  constructor(private readonly workspace?: string | null) {}

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      // No end is observed for this runtime: a silence never completes a session (#360)
      status: 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
      runtime: 'gemini',
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
      const roots = [this.workspace]
      try {
        const real = fs.realpathSync(this.workspace)
        if (real !== this.workspace) roots.push(real)
      } catch { /* the path as given is all there is */ }
      this.workspaceRoots = roots
    }

    this.guardedScan()
    this.scanInterval = setInterval(() => this.guardedScan(), SCAN_INTERVAL_MS)

    // A new project is a new directory under tmp/; the periodic scan covers a new chats/ below it.
    const root = geminiTmpRoot()
    if (fs.existsSync(root)) {
      try { this.rootWatcher = safeWatch(root, () => this.requestScan(), { recursive: false }) }
      catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspace ?? '<any>'}`)
  }

  private guardedScan(): void {
    runGuarded(() => this.scanForSessions(), err => log.warn('Scan Gemini en échec :', err))
  }

  /** One scan armed WATCH_SCAN_DEBOUNCE_MS after the first root event (no endless postponement). */
  private requestScan(): void {
    if (this.scanDebounce) return
    this.scanDebounce = setTimeout(() => {
      this.scanDebounce = null
      this.guardedScan()
    }, WATCH_SCAN_DEBOUNCE_MS)
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedGeminiSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'gemini', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  /** `chats/session-*.jsonl` of each project directory (most recently modified first, bounded like
   *  the Claude discovery), newest names first. Nested sub-agent directories are not entered. */
  private listSessionFiles(root: string, perDir: number): string[] {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) }
    catch { return [] }

    const dirs: { dir: string; mtime: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const chats = path.join(root, entry.name, 'chats')
      let mtime = 0
      // lstat: a `chats` that is a symbolic link is not followed (it could lead outside the Gemini tree)
      try {
        const st = fs.lstatSync(chats)
        if (!st.isDirectory()) continue
        mtime = st.mtimeMs
      } catch { continue }
      dirs.push({ dir: chats, mtime })
    }
    if (dirs.length > RELAY_MAX_PROJECT_DIRS) this.warnScanCap()
    dirs.sort((a, b) => b.mtime - a.mtime)

    const out: string[] = []
    for (const { dir } of dirs.slice(0, RELAY_MAX_PROJECT_DIRS)) {
      let sub: fs.Dirent[]
      try { sub = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      const names = chatFileNames(sub)
      if (names.length > RELAY_MAX_FILES_PER_DIR) this.warnScanCap()
      for (const name of names.slice(0, Math.min(perDir, RELAY_MAX_FILES_PER_DIR))) out.push(path.join(dir, name))
    }
    return out
  }

  private warnScanCap(): void {
    if (this.scanCapWarned) return
    this.scanCapWarned = true
    log.warn(`Gemini : plus de ${RELAY_MAX_PROJECT_DIRS} dossiers ou ${RELAY_MAX_FILES_PER_DIR} fichiers par dossier sous ${geminiTmpRoot()} ; seuls les plus récents sont examinés.`)
  }

  private header(filePath: string): GeminiSessionHeader {
    const cached = this.headerCache.get(filePath)
    if (cached) return cached
    const header = readGeminiSessionHeader(filePath)
    if (header.final) {
      if (this.headerCache.size >= GEMINI_MAX_WATCHED_SESSIONS * 40) {
        const oldest = this.headerCache.keys().next().value
        if (oldest !== undefined) this.headerCache.delete(oldest)
      }
      this.headerCache.set(filePath, header)
    }
    return header
  }

  /** The workspace path whose hash is `hash`, or null (no workspace given: any hash, no path). */
  private matchWorkspace(hash: string): string | null | false {
    if (this.workspaceRoots.length === 0) return null
    for (const root of this.workspaceRoots) {
      if (geminiProjectHash(root) === hash) return root
    }
    return false
  }

  private scanForSessions(): void {
    this.releaseEndedSessions()
    const root = geminiTmpRoot()
    const full = this.scanCount++ % FULL_SCAN_EVERY === 0

    const candidates: { filePath: string; stat: fs.Stats }[] = []
    for (const filePath of this.listSessionFiles(root, full ? RELAY_MAX_FILES_PER_DIR : QUICK_SCAN_FILES_PER_DIR)) {
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      if (stat.size > RELAY_MAX_SESSION_FILE_BYTES) continue
      if ((Date.now() - stat.mtimeMs) / 1000 > ACTIVE_SESSION_AGE_S) continue
      candidates.push({ filePath, stat })
    }

    // Most recent first: the cap on tracked sessions goes to the most active ones
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    let skippedByWorkspace = 0
    for (const { filePath, stat } of candidates) {
      const header = this.header(filePath)
      // No readable metadata record, or a sub-agent file: not a session this adapter shows
      if (!header.sessionId || !header.projectHash) continue
      if (this.sessions.has(header.sessionId)) continue
      const matched = this.matchWorkspace(header.projectHash)
      if (matched === false) { skippedByWorkspace++; continue }

      if (this.sessions.size >= GEMINI_MAX_WATCHED_SESSIONS) {
        if (!this.capWarned) {
          this.capWarned = true
          log.warn(`Plafond de ${GEMINI_MAX_WATCHED_SESSIONS} sessions Gemini suivies atteint : les plus anciennes sont ignorées.`)
        }
        break
      }
      this.attachSession(header.sessionId, filePath, stat, header, matched)
    }

    if (skippedByWorkspace > 0 && this.sessions.size === 0 && !this.mismatchWarned) {
      this.mismatchWarned = true
      log.warn(
        `Found ${skippedByWorkspace} recent Gemini session(s), but none ran in ${this.workspace}. ` +
        `Gemini sessions are only shown for the current workspace (matched by the hash of the project root) — ` +
        `launch the visualizer from the directory where Gemini CLI runs (or open that folder in VS Code).`,
      )
    }
  }

  /** Stop watching a session (watcher, timers freed) and keep its read position for a later reattach. */
  private retire(id: string, s: WatchedGeminiSession): void {
    s.fileWatcher?.close()
    if (s.pollTimer) clearInterval(s.pollTimer)
    this.sessions.delete(id)
    this.retired.delete(id)
    this.retired.set(id, {
      fileSize: s.fileSize, fileTail: s.fileTail, ino: s.ino, eventState: s.eventState,
      sessionStartTime: s.sessionStartTime, label: s.label,
    })
    if (this.retired.size > GEMINI_MAX_WATCHED_SESSIONS * 4) {
      const oldest = this.retired.keys().next().value
      if (oldest !== undefined) this.retired.delete(oldest)
    }
  }

  /** Detach sessions ended for more than ACTIVE_SESSION_AGE_S. The scan reattaches them if their file resumes. */
  private releaseEndedSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if ((now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      this.retire(id, s)
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  /** A session whose read threw is detached; the scan reattaches it from the same offset if the file resumes. */
  private detachOnError(sessionId: string, err: unknown): void {
    const s = this.sessions.get(sessionId)
    log.warn(`Session Gemini ${sessionId.slice(0, SESSION_ID_DISPLAY)} : lecture en échec, détachée :`, err)
    if (!s) return
    this.retire(sessionId, s)
    if (s.sessionDetected) this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: s.label })
  }

  private attachSession(sessionId: string, filePath: string, stat: fs.Stats, header: GeminiSessionHeader, cwd: string | null): void {
    const label = `${GEMINI_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`

    // Parser built once per session so the delegate closures capture the right session
    const parser = new GeminiEventParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId, ...(this.historyDepth > 0 ? { replayed: true } : {}) }),
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
    })

    const session: WatchedGeminiSession = {
      sessionId,
      filePath,
      ...(cwd ? { cwd } : {}),
      fileWatcher: null,
      pollTimer: null,
      fileSize: 0,
      fileTail: '',
      ino: stat.ino,
      // The metadata says when the session started; a file time is only a fallback
      sessionStartTime: header.startMs ?? (stat.birthtimeMs || stat.mtimeMs),
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      label,
      eventState: createGeminiEventState(),
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

    log.info(`Attached to session ${sessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  /** The events emitted while the history is read are marked `replayed` (#390). */
  private drainHistory(session: WatchedGeminiSession, size: number): void {
    this.historyDepth++
    try { this.drainHistoryLines(session, size) } finally { this.historyDepth-- }
  }

  private drainHistoryLines(session: WatchedGeminiSession, size: number): void {
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

    let stat: fs.Stats
    try { stat = fs.lstatSync(session.filePath) } catch { return }
    // The file became something else (a symbolic link, ...): never read it, stop watching
    if (!stat.isFile()) {
      log.warn(`Session Gemini ${sessionId.slice(0, SESSION_ID_DISPLAY)} : le fichier n'est plus un fichier régulier, session détachée.`)
      this.detachOnError(sessionId, new Error('not a regular file'))
      return
    }
    // The CLI rewrote the file (new inode): read it again from the start; shown messages are remembered
    const rewritten = stat.ino !== session.ino
    if (rewritten) {
      session.ino = stat.ino
      session.fileSize = 0
      session.fileTail = ''
    }
    const size = stat.size
    // One read allocates the whole growth: past the cap, the new content is skipped, never read.
    // Same for a line that never ends: its bytes are dropped instead of growing the tail forever.
    if (size - session.fileSize > RELAY_MAX_SESSION_FILE_BYTES || session.fileTail.length > NORM_MAX_LINE_CHARS) {
      log.warn(`Session Gemini ${sessionId.slice(0, SESSION_ID_DISPLAY)} : contenu au-delà des plafonds de lecture ignoré.`)
      session.parser.normalizer.noteMalformed()
      session.fileSize = size
      session.fileTail = ''
      return
    }

    // A rewritten file is read in bounded chunks, like the history at attach time
    let lines: string[] | null = null
    if (!rewritten) {
      lines = readTrackedLines(session.filePath, session)
      if (!lines) return
    }
    session.lastActivityTime = Date.now()

    if (rewritten) {
      session.parser.beginRewrite(session.eventState)
      // Not marked replayed (#390): the parser drops what was already shown, so what comes out is new
      try { this.drainHistoryLines(session, size) }
      finally { session.parser.endRewrite(session.eventState) }
    } else {
      for (const line of lines ?? []) {
        try { session.parser.processLine(line, session.eventState) }
        catch (err) { log.debug('Parser threw on line:', err) }
      }
    }
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    if (this.scanDebounce) { clearTimeout(this.scanDebounce); this.scanDebounce = null }
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
    }
    this.sessions.clear()
    this.retired.clear()
    this.headerCache.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
