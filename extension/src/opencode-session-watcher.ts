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
/** Polls chained while the reader reports more rows waiting. */
const CATCHUP_POLLS_MAX = 20
/** Longest parent chain followed to find a root (a longer or cyclic chain has no root). */
const ROOT_HOPS_MAX = 16
const CWD_MAX = 4096
/** Control characters (C0, DEL, C1) and bidi overrides: never part of a path shown to the user. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

export interface OpenCodeWatcherOptions {
  /** Database file to read; default: resolved from the process environment (opencode-db.ts). */
  dbFile?: string
  /** Clock, for tests. */
  now?: () => number
}

/** Where the database is expected on this machine. */
export function openCodeDbLocation(): OpenCodeDbPath {
  return resolveOpenCodeDbPath({ env: process.env, homedir: os.homedir(), platform: process.platform })
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
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  private statusText = 'OpenCode: not started'
  /** Status shown while the database reads fine (set when it is opened). */
  private okText = ''
  private lastLogged = ''
  private capWarned = false

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

  /** Human-readable state of the database connection, for the connection status. */
  status(): string { return this.statusText }

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
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }
    const since = this.now() - ACTIVE_SESSION_AGE_S * 1000
    this.cursors = {
      session: { time: 0, seen: [] },
      message: { time: since, seen: [] },
      part: { time: since, seen: [] },
    }
    this.scanNow()
    this.scanInterval = setInterval(() => this.scanNow(), SCAN_INTERVAL_MS)
  }

  /** One poll of the database and one release pass; also the timer callback. Never throws. */
  scanNow(): void {
    runGuarded(() => {
      if (!this.ensureDb()) return
      this.pollDb()
      this.releaseEndedSessions()
    }, err => log.warn('Scan OpenCode en échec :', err))
  }

  private setStatus(text: string): void {
    this.statusText = text
    if (text !== this.lastLogged) { this.lastLogged = text; log.info(text) }
  }

  private ensureDb(): boolean {
    if (this.db) return true
    let file: string
    if (this.options.dbFile) file = this.options.dbFile
    else {
      const location = openCodeDbLocation()
      if (location.kind === 'unavailable') { this.setStatus(location.message); return false }
      file = location.path
    }
    const opened = openOpenCodeDb(file)
    if (opened.status === 'unavailable') { this.setStatus(opened.message); return false }
    this.db = opened.db
    this.okText = `OpenCode database (${file.replace(os.homedir(), '~')})`
    this.setStatus(this.okText)
    return true
  }

  private pollDb(): void {
    const db = this.db
    if (!db) return
    for (let i = 0; i < CATCHUP_POLLS_MAX; i++) {
      const poll = db.poll(this.cursors)
      if (poll.error) { this.setStatus(`OpenCode: ${poll.error}`); return }
      this.cursors = poll.cursors
      this.deliver(poll)
      if (!poll.truncated) { this.setStatus(this.okText); return }
    }
  }

  private deliver(poll: OpenCodePoll): void {
    const rows = [...poll.sessions].sort((a, b) => a.time_created - b.time_created)
    for (const row of rows) this.remember(row)
    for (const row of rows) this.onSessionRow(row)
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

  private remember(row: OpenCodeSessionRead): void {
    this.known.delete(row.id)
    this.known.set(row.id, row)
    if (this.known.size > KNOWN_MAX) {
      const oldest = this.known.keys().next().value
      if (oldest !== undefined) this.known.delete(oldest)
    }
  }

  private rootOf(id: string): string | undefined {
    let cur = id
    for (let i = 0; i < ROOT_HOPS_MAX; i++) {
      const row = this.known.get(cur)
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
      if (attached) this.release(rootId, attached)
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
    const row = this.known.get(rootId)
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

  private attach(row: OpenCodeSessionRead): WatchedOpenCodeSession | undefined {
    const sessionId = row.id
    const cwd = this.safeDirectory(row.directory)
    if (!this.matchesWorkspace(cwd)) return undefined
    if (this.sessions.size >= OPENCODE_MAX_WATCHED_SESSIONS) {
      if (!this.capWarned) {
        this.capWarned = true
        log.warn(`Plafond de ${OPENCODE_MAX_WATCHED_SESSIONS} sessions OpenCode suivies atteint : les suivantes sont ignorées.`)
      }
      return undefined
    }

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

    if (!retired) {
      this.processSession(session, row)
      // Children already seen while the root was not attached
      const children = [...this.known.values()]
        .filter(r => r.id !== sessionId && this.rootOf(r.id) === sessionId)
        .sort((a, b) => a.time_created - b.time_created)
      for (const child of children) this.processSession(session, child)
    }

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

  /** Stop following a session and keep its parser state for a later reattach. */
  private release(id: string, s: WatchedOpenCodeSession): void {
    this.sessions.delete(id)
    this.retired.delete(id)
    this.retired.set(id, { state: s.state, parser: s.parser, sessionStartTime: s.sessionStartTime, label: s.label })
    if (this.retired.size > OPENCODE_MAX_WATCHED_SESSIONS * 4) {
      const oldest = this.retired.keys().next().value
      if (oldest !== undefined) this.retired.delete(oldest)
    }
    if (s.detected) this._onSessionLifecycle.fire({ type: 'ended', sessionId: id, label: s.label })
  }

  /** Release sessions silent for more than ACTIVE_SESSION_AGE_S. New rows reattach them. */
  private releaseEndedSessions(): void {
    const now = this.now()
    for (const [id, s] of this.sessions) {
      if ((now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      this.release(id, s)
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null }
    this.db?.close()
    this.db = null
    this.sessions.clear()
    this.retired.clear()
    this.known.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
