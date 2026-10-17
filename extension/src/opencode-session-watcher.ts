/**
 * Watches the local OpenCode database (#346).
 *
 * OpenCode keeps every session in one SQLite file (see opencode-db.ts). This watcher polls it
 * read-only, groups rows by root session (a sub-agent is a child session, `parent_id`) and gives
 * each root one OpenCodeEventParser. Events carry the root session id.
 *
 * A root session is attached when its row is recent, or as soon as a message or part of it arrives
 * (activity is proved by the rows, not by `session.time_updated`). It is released after
 * ACTIVE_SESSION_AGE_S without rows, or when archived. No end is observed for this runtime: silence
 * never completes a session. The first poll reads every session row (cheap, one per session) but
 * only messages and parts newer than the activity window: history is not replayed.
 *
 * Every timer callback runs through runGuarded: in the relay an uncaught exception ends the process.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentEvent, SessionInfo } from './protocol'
import { ACTIVE_SESSION_AGE_S, OPENCODE_MAX_WATCHED_SESSIONS, PREVIEW_MAX, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY } from './constants'
import { foldPathCase, isPathInside, runGuarded } from './fs-utils'
import { createLogger } from './logger'
import { ostr } from './event-normalize'
import {
  openOpenCodeDb, resolveOpenCodeDbPath,
  type OpenCodeCursors, type OpenCodeDb, type OpenCodeDbPath, type OpenCodePoll, type OpenCodeSessionRead,
} from './opencode-db'
import { OpenCodeEventParser, createOpenCodeEventState, type OpenCodeEventState } from './opencode-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('OpenCodeSessionWatcher')

const OPENCODE_LABEL_PREFIX = 'OpenCode '
/** Session rows remembered (id → row) to find the root of a message or a child. */
const KNOWN_MAX = 5000
/** A poll is forced at least this often even when the database reports no change. */
const DATA_VERSION_RECHECK_MS = 60_000
/** Scans chained with setImmediate before waiting for the next interval tick. */
const SCAN_CHAIN_MAX = 50
/** Longest parent chain followed to find a root (a longer or cyclic chain has no root). */
const ROOT_HOPS_MAX = 16
const CWD_MAX = 4096
/** Longest reason given for an unreadable database (#420). */
const STATUS_PROBLEM_MAX = 300
/** Control characters (C0, DEL, C1) and bidi overrides: never part of a path shown to the user. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

export interface OpenCodeWatcherOptions {
  /** Database file to read; default: resolved from the process environment (opencode-db.ts). */
  dbFile?: string
  /** Clock, for tests. */
  now?: () => number
  /**
   * Watched without being asked for (the relay's auto mode, #420): a database that cannot be read is
   * reported by statusProblem() only once OpenCode is proved in use on this machine (see inUse).
   */
  optional?: boolean
}

/** Where the database is expected on this machine. */
export function openCodeDbLocation(): OpenCodeDbPath {
  return resolveOpenCodeDbPath({ env: process.env, homedir: os.homedir(), platform: process.platform })
}

/**
 * `file` with the home directory shown as `~`, only when it is a whole leading part of the path. An
 * empty or relative home (os.homedir() may be either) leaves the path as is (#420).
 */
export function homeRelative(file: string, home: string): string {
  if (!home || !path.isAbsolute(home)) return file
  const h = home.replace(/[\\/]+$/, '')
  if (!h) return file
  if (file === h) return '~'
  return file.startsWith(h) && (file[h.length] === '/' || file[h.length] === path.sep) ? `~${file.slice(h.length)}` : file
}

interface WatchedOpenCodeSession {
  sessionId: string
  cwd?: string
  sessionStartTime: number
  lastActivityTime: number
  detected: boolean
  label: string
  state: OpenCodeEventState
  parser: OpenCodeEventParser
}

type RetiredOpenCodeSession = Pick<WatchedOpenCodeSession, 'state' | 'parser' | 'sessionStartTime' | 'label'>

const isArchived = (row: OpenCodeSessionRead): boolean => typeof row.time_archived === 'number'

export class OpenCodeSessionWatcher implements AgentSessionWatcher {
  private db: OpenCodeDb | null = null
  private cursors: OpenCodeCursors = { session: { time: 0, seen: [] }, message: { time: 0, seen: [] }, part: { time: 0, seen: [] } }
  private sessions = new Map<string, WatchedOpenCodeSession>()
  private retired = new Map<string, RetiredOpenCodeSession>()
  private known = new Map<string, OpenCodeSessionRead>()
  /** Ids looked up in the database and not found during the current poll. */
  private missed = new Set<string>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  private statusText = 'OpenCode: not started'
  /** Status shown while the database reads fine (set when it is opened). */
  private okText = ''
  private lastLogged = ''
  /** Scan queued with setImmediate while the reader reports more rows waiting. */
  private pendingScan: NodeJS.Immediate | null = null
  private scanning = false
  /** data_version seen before the last COMPLETE poll (no error, not truncated); undefined forces a poll. */
  private lastDataVersion: number | undefined
  private lastPollAt = 0
  /** Scans chained one after the other without an interval tick in between. */
  private chained = 0
  /** Workspace verdict per root id, valid while the root keeps the same directory. */
  private verdicts = new Map<string, { directory: string | null; ok: boolean }>()
  private capWarned = false
  /** File the open connection reads, and its identity: a deleted or replaced file is not followed by the connection. */
  private dbOpenFile: string | null = null
  private dbIdentity: string | null = null
  /** Unreadable rows of the open file that no followed session could take in its normalization_stats (#420). */
  private unattributedSkipped = 0
  private started = false
  /**
   * OpenCode is proved in use (#420): its database was opened in this run, OPENCODE_DB is set, or the
   * directory that should hold the database exists. Without it, in optional mode, a missing database is
   * the normal state of a machine without OpenCode, not a problem.
   */
  private inUse = false

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a filter: a root session is attached only if its directory is this path
   *  or inside it. Pass null/undefined to attach to any OpenCode session. */
  constructor(private readonly workspace?: string | null, private readonly options: OpenCodeWatcherOptions = {}) {}

  private now(): number { return this.options.now ? this.options.now() : Date.now() }

  /**
   * Human-readable state of the database connection, for the connection status. While it reads, the
   * unreadable rows that no followed session took in its normalization_stats are counted here (#420).
   */
  status(): string {
    const n = this.unattributedSkipped
    if (this.statusText !== this.okText || n === 0) return this.statusText
    return `${this.statusText}; ${n} unreadable ${n === 1 ? 'row' : 'rows'} ignored outside the followed sessions`
  }

  /**
   * Why the database cannot be read right now (not found, no driver, unexpected schema, failed poll), as
   * last observed; undefined while it reads or before the first look (#420). Never a file path: these
   * messages name none (the healthy status, which does, is not one of them). Capped like any shown text.
   */
  statusProblem(): string | undefined {
    if (!this.started || this.statusText === this.okText) return undefined
    if (this.options.optional && !this.inUse) return undefined
    return ostr(this.statusText, STATUS_PROBLEM_MAX)
  }

  isActive(): boolean {
    for (const s of this.sessions.values()) if (s.detected) return true
    return false
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.detected === true
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      // No end is observed for this runtime: a silence never completes a session
      status: 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
      runtime: 'opencode',
      ...(s.cwd ? { cwd: s.cwd } : {}),
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (!session.detected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire(this.lifecycle('started', session))
    }
  }

  start(): void {
    this.started = true
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }
    this.resetCursors()
    this.scanNow()
    this.scanInterval = setInterval(() => this.scanNow(), SCAN_INTERVAL_MS)
  }

  /** Session rows are all read, messages and parts only inside the activity window: history is not replayed. */
  private resetCursors(): void {
    const since = this.now() - ACTIVE_SESSION_AGE_S * 1000
    this.cursors = {
      session: { time: 0, seen: [] },
      message: { time: since, seen: [] },
      part: { time: since, seen: [] },
    }
    this.lastDataVersion = undefined
  }

  private static identityOf(file: string): string | null {
    try {
      const st = fs.statSync(file)
      return `${st.dev}:${st.ino}:${st.birthtimeMs}`
    } catch { return null }
  }

  /**
   * An open connection keeps reading the old inode after the file is deleted or replaced, with no
   * error. Compared at each scan (one stat): the connection is closed, the cursors restart and the
   * path is opened again (or reported missing).
   */
  private checkDbReplaced(): void {
    if (!this.db || !this.dbOpenFile) return
    const identity = OpenCodeSessionWatcher.identityOf(this.dbOpenFile)
    if (identity === this.dbIdentity) return
    log.info('Base OpenCode supprimée ou remplacée : réouverture.')
    this.db.close()
    this.db = null
    this.dbOpenFile = null
    this.dbIdentity = null
    this.resetCursors()
    // Everything held came from the old file and nothing proves it still exists: the attached
    // sessions end (also while the file is missing), the replayed rows rebuild the rest.
    for (const [id, s] of this.sessions) {
      if (s.detected) this._onSessionLifecycle.fire({ type: 'ended', sessionId: id, label: s.label })
    }
    this.sessions.clear()
    this.capWarned = false
    this.retired.clear()
    this.known.clear()
    this.verdicts.clear()
    this.unattributedSkipped = 0
  }

  /**
   * One poll of the database and one release pass; also the timer callback. Never throws. A poll that
   * leaves rows behind queues the next scan with setImmediate, so a large backlog is read across
   * ticks and never in one blocking loop.
   */
  scanNow(chained = false): void {
    if (this.scanning) return
    this.chained = chained ? this.chained + 1 : 0
    this.scanning = true
    let more = false
    try {
      runGuarded(() => {
        this.checkDbReplaced()
        if (!this.ensureDb()) return
        more = this.pollDb()
        this.releaseEndedSessions()
      }, err => log.warn('Scan OpenCode en échec :', err))
    } finally { this.scanning = false }
    if (!more) this.chained = 0
    // Bounded chain: rows that never let the cursor pass (one millisecond shared by thousands of
    // rows) would otherwise spin forever; the next interval tick resumes.
    if (more && !this.pendingScan && this.db && this.chained < SCAN_CHAIN_MAX) {
      this.pendingScan = setImmediate(() => { this.pendingScan = null; this.scanNow(true) })
    }
  }

  private setStatus(text: string): void {
    this.statusText = text
    if (text === this.lastLogged) return
    this.lastLogged = text
    // A failure must show even at the relay's quiet log level; the healthy status stays at info.
    if (text === this.okText) log.info(text)
    else log.warn(text)
  }

  /** Records a proof that OpenCode is used here (one stat while none is known, #420). */
  private noteUse(file: string | null): void {
    if (this.inUse) return
    if (!this.options.dbFile && process.env.OPENCODE_DB) { this.inUse = true; return }
    if (!file) return
    try { this.inUse = fs.statSync(path.dirname(file)).isDirectory() } catch { /* no data directory: no proof */ }
  }

  private ensureDb(): boolean {
    if (this.db) return true
    let file: string
    if (this.options.dbFile) file = this.options.dbFile
    else {
      const location = openCodeDbLocation()
      if (location.kind === 'unavailable') { this.noteUse(null); this.setStatus(location.message); return false }
      file = location.path
    }
    this.noteUse(file)
    let identity = OpenCodeSessionWatcher.identityOf(file)
    let opened = openOpenCodeDb(file)
    if (opened.status === 'unavailable') { this.setStatus(opened.message); return false }
    // The path may have been swapped between the stat and the open: if the identity moved, the
    // connection may be on the other file, so open once more.
    const after = OpenCodeSessionWatcher.identityOf(file)
    if (after !== identity) {
      opened.db.close()
      identity = after
      opened = openOpenCodeDb(file)
      if (opened.status === 'unavailable') { this.setStatus(opened.message); return false }
    }
    this.db = opened.db
    this.inUse = true
    this.dbOpenFile = file
    this.dbIdentity = identity
    this.okText = `OpenCode database (${homeRelative(file, os.homedir())})`
    this.setStatus(this.okText)
    return true
  }

  /** One poll; true when the reader reports more rows waiting. */
  private pollDb(): boolean {
    const db = this.db
    if (!db) return false
    // The full scans cost on a large database: skip them while no commit happened, except after a
    // failed or partial poll and at least every DATA_VERSION_RECHECK_MS (a row dated in the future
    // margin becomes readable without any write).
    const version = db.dataVersion()
    const now = this.now()
    if (version !== undefined && version === this.lastDataVersion && now - this.lastPollAt < DATA_VERSION_RECHECK_MS) return false
    this.lastDataVersion = undefined
    this.lastPollAt = now
    const poll = db.poll(this.cursors)
    if (poll.error) { this.setStatus(poll.error); return false }
    this.cursors = poll.cursors
    this.deliver(poll)
    this.countSkipped(poll)
    this.setStatus(this.okText)
    if (!poll.truncated) this.lastDataVersion = version
    return poll.truncated
  }

  private deliver(poll: OpenCodePoll): void {
    this.missed.clear()
    const rows = [...poll.sessions].sort((a, b) => a.time_created - b.time_created)
    for (const row of rows) this.remember(row)
    // Most recently updated first: when more roots compete than the cap allows, the newest win.
    // A child met while its root is not attached (never seen, or released) is replayed when the root attaches.
    for (const row of [...rows].sort((a, b) => b.time_updated - a.time_updated)) this.onSessionRow(row)
    for (const m of poll.messages) {
      const s = this.sessionFor(m.session_id)
      if (!s) continue
      s.lastActivityTime = this.now()
      try { s.parser.processMessage(m, s.state) } catch (err) { log.debug('Parser threw on message:', err) }
    }
    for (const p of poll.parts) {
      const s = this.sessionFor(p.session_id)
      if (!s) continue
      s.lastActivityTime = this.now()
      try { s.parser.processPart(p, s.state) } catch (err) { log.debug('Parser threw on part:', err) }
    }
  }

  /**
   * Rows the reader could not use are a loss, never silent (#420): each one the cursor passed goes into
   * the normalization_stats of the followed session it names, else into the count of the status. The
   * reader reports a passed row once, so nothing is counted twice.
   */
  private countSkipped(poll: OpenCodePoll): void {
    for (const { sessionId, count } of poll.skippedPassed ?? []) {
      const rootId = sessionId ? this.rootOf(sessionId) : undefined
      const s = rootId ? this.sessions.get(rootId) : undefined
      if (s) s.parser.normalizer.noteMalformed(count)
      else this.unattributedSkipped = Math.min(this.unattributedSkipped + count, Number.MAX_SAFE_INTEGER)
    }
  }

  private remember(row: OpenCodeSessionRead): void {
    this.known.delete(row.id)
    this.known.set(row.id, row)
    if (this.known.size > KNOWN_MAX) {
      const oldest = this.known.keys().next().value
      if (oldest !== undefined) this.known.delete(oldest)
    }
  }

  /**
   * A session row: remembered, else read by id from the database (KNOWN_MAX evicts the oldest rows, and
   * activity on an old session does not always bring its row back, #420). A miss is not asked again
   * within the same poll.
   */
  private lookup(id: string): OpenCodeSessionRead | undefined {
    const row = this.known.get(id)
    if (row || !this.db || this.missed.has(id)) return row
    const read = this.db.sessionById(id)
    if (!read) { this.missed.add(id); return undefined }
    this.remember(read)
    return read
  }

  private rootOf(id: string): string | undefined {
    let cur = id
    for (let i = 0; i < ROOT_HOPS_MAX; i++) {
      const row = this.lookup(cur)
      if (!row) return undefined
      if (!row.parent_id) return cur
      cur = row.parent_id
    }
    return undefined
  }

  private isRecent(row: OpenCodeSessionRead): boolean {
    return (this.now() - row.time_updated) / 1000 <= ACTIVE_SESSION_AGE_S
  }

  private onSessionRow(row: OpenCodeSessionRead): void {
    const rootId = this.rootOf(row.id)
    if (!rootId) return
    const attached = this.sessions.get(rootId)
    if (rootId !== row.id) {
      if (attached) this.processSession(attached, row)
      return
    }
    if (isArchived(row)) {
      if (attached) this.release(rootId, attached, 'archived')
      return
    }
    if (attached) {
      attached.lastActivityTime = this.now()
      this.processSession(attached, row)
    } else if (this.isRecent(row)) {
      this.attach(row)
    }
  }

  private processSession(s: WatchedOpenCodeSession, row: OpenCodeSessionRead): void {
    try { s.parser.processSession(row, s.state) } catch (err) { log.debug('Parser threw on session:', err) }
  }

  /** The attached root session of a message or part, attaching it on first activity. */
  private sessionFor(sessionId: string): WatchedOpenCodeSession | undefined {
    const rootId = this.rootOf(sessionId)
    if (!rootId) return undefined
    const attached = this.sessions.get(rootId)
    if (attached) return attached
    const row = this.lookup(rootId)
    if (!row || isArchived(row)) return undefined
    return this.attach(row)
  }

  private safeDirectory(directory: string | null): string | undefined {
    if (!directory || directory.length > CWD_MAX || UNSAFE_PATH_CHARS.test(directory)) return undefined
    return path.isAbsolute(directory) ? directory : undefined
  }

  private matchesWorkspace(directory: string | undefined): boolean {
    if (!this.workspacePath) return true
    if (!directory) return false
    let resolved = directory
    try { resolved = fs.realpathSync(directory) } catch { /* a directory that no longer exists keeps its path */ }
    return isPathInside(foldPathCase(resolved), foldPathCase(this.workspacePath))
  }

  /** matchesWorkspace (a synchronous realpath) memoised per root, until its directory changes. */
  private inWorkspace(rootId: string, directory: string | null, cwd: string | undefined): boolean {
    const known = this.verdicts.get(rootId)
    if (known && known.directory === directory) return known.ok
    const ok = this.matchesWorkspace(cwd)
    this.verdicts.delete(rootId)
    this.verdicts.set(rootId, { directory, ok })
    if (this.verdicts.size > KNOWN_MAX) {
      const oldest = this.verdicts.keys().next().value
      if (oldest !== undefined) this.verdicts.delete(oldest)
    }
    return ok
  }

  private attach(row: OpenCodeSessionRead): WatchedOpenCodeSession | undefined {
    const sessionId = row.id
    // The cap first: a refused root costs no filesystem call
    if (this.sessions.size >= OPENCODE_MAX_WATCHED_SESSIONS) {
      if (!this.capWarned) {
        this.capWarned = true
        log.warn(`Plafond de ${OPENCODE_MAX_WATCHED_SESSIONS} sessions OpenCode suivies atteint : les plus récemment mises à jour sont suivies, les autres ignorées.`)
      }
      return undefined
    }
    const cwd = this.safeDirectory(row.directory)
    if (!this.inWorkspace(sessionId, row.directory, cwd)) return undefined

    const retired = this.retired.get(sessionId)
    const state = retired?.state ?? createOpenCodeEventState(sessionId)
    const parser = retired?.parser ?? this.newParser(sessionId)
    const session: WatchedOpenCodeSession = {
      sessionId,
      ...(cwd ? { cwd } : {}),
      sessionStartTime: retired?.sessionStartTime ?? row.time_created,
      lastActivityTime: this.now(),
      detected: false,
      label: retired?.label ?? `${OPENCODE_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      state,
      parser,
    }
    this.retired.delete(sessionId)
    this.sessions.set(sessionId, session)

    // Also on a reattach: a child met while the root was released was dropped. Both calls are
    // idempotent in the parser (the root spawns once, a known child is not spawned again).
    this.processSession(session, row)
    const children = [...this.known.values()]
      .filter(r => r.id !== sessionId && this.rootOf(r.id) === sessionId)
      .sort((a, b) => a.time_created - b.time_created)
    for (const child of children) this.processSession(session, child)

    session.detected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire(this.lifecycle('started', session))
    log.info(`Attached to OpenCode session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    return session
  }

  private newParser(sessionId: string): OpenCodeEventParser {
    return new OpenCodeEventParser({
      emit: event => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (this.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: raw => {
        const s = this.sessions.get(sessionId)
        const label = ostr(raw, PREVIEW_MAX)?.trim()
        if (!s || !label) return
        s.label = label
        if (s.detected) this._onSessionLifecycle.fire({ type: 'updated', sessionId, label })
      },
    })
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedOpenCodeSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'opencode', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  /** Stop following a session and keep its parser state for a later reattach. Only an archived root
   *  (proved by the database) fires `ended`: an idle release is a silence, never an end. */
  private release(id: string, s: WatchedOpenCodeSession, reason: 'idle' | 'archived'): void {
    this.sessions.delete(id)
    // Below the cap again: the next time it is reached is reported again (#420)
    if (this.sessions.size < OPENCODE_MAX_WATCHED_SESSIONS) this.capWarned = false
    this.retired.delete(id)
    this.retired.set(id, { state: s.state, parser: s.parser, sessionStartTime: s.sessionStartTime, label: s.label })
    if (this.retired.size > OPENCODE_MAX_WATCHED_SESSIONS * 4) {
      const oldest = this.retired.keys().next().value
      if (oldest !== undefined) this.retired.delete(oldest)
    }
    if (reason === 'archived' && s.detected) this._onSessionLifecycle.fire({ type: 'ended', sessionId: id, label: s.label })
  }

  /** Release sessions silent for more than ACTIVE_SESSION_AGE_S. New rows reattach them. */
  private releaseEndedSessions(): void {
    const now = this.now()
    for (const [id, s] of this.sessions) {
      if ((now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      this.release(id, s, 'idle')
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null }
    if (this.pendingScan) { clearImmediate(this.pendingScan); this.pendingScan = null }
    this.db?.close()
    this.db = null
    this.sessions.clear()
    this.retired.clear()
    this.known.clear()
    this.verdicts.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
