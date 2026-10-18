/**
 * Read-only access to the local SQLite database of OpenCode (#346).
 *
 * Format checked against OpenCode v1.19.0 (see opencode-event-parser.ts). This module only finds the
 * file, opens it and returns the rows that changed since the last poll; turning rows into events is
 * the parser's job.
 *
 * - Read-only by construction: the driver is opened read-only (never creates the file, no journal
 *   mode change) and the connection wrapper only accepts SELECT and PRAGMA table_info.
 * - Never throws and never invents data: a missing file, a missing driver or an unexpected schema is
 *   an `unavailable` state with the cause; a failing poll returns an `error` and keeps the cursors.
 * - Bounded: at most `limit` rows per table per poll, and a row whose `data` is larger than
 *   OPENCODE_ROW_DATA_MAX is not read (counted in `skippedRows`).
 * - Cheap on a large database (#420): `message` and `part` have no index on `time_updated`, so a cursor
 *   on it reads and sorts the whole table at every poll. With `mode: 'key'` they are followed by their
 *   primary key (OpenCode's message and part ids are ascending: creation time first), and a bounded
 *   window of recent rows is read again (id, time_updated, session_id and the size of data in bytes,
 *   octet_length, which does not load the content) to find the rows updated in place. A row
 *   updated after it left the window is not read; a slow sweep below the window finds such changes and
 *   reports them in `lostPassed` (never silent).
 * - No network, no vscode dependency: usable from the relay. The database content is untrusted input.
 */
import * as fs from 'fs'
import * as path from 'path'
import { CONTROL_ALL } from './control-chars'
import { nodeSqliteOpener, type IndexConnection, type IndexOpener } from './session-index'
import type { OpenCodeSessionRow, OpenCodeMessageRow, OpenCodePartRow } from './opencode-event-parser'

/** Largest `data` column read, in bytes (UTF-8); a larger row is skipped and counted. */
export const OPENCODE_ROW_DATA_MAX = 1024 * 1024
/** Cumulative `data` bytes read per table per poll; the poll reports `truncated` when it stops there. */
export const OPENCODE_POLL_BYTES_MAX = 16 * 1024 * 1024
const MAX_SAFE = Number.MAX_SAFE_INTEGER
/** Rows read per table and per poll. */
const POLL_LIMIT_DEFAULT = 500
const POLL_LIMIT_HARD_MAX = 5000
const TIMEOUT_MS = 1000
/** Rows dated further ahead than this are not read (a wrong clock or a hostile database). */
const FUTURE_MARGIN_MS = 5000
/** Rows newer than this are given again until they are older: an update in the same millisecond is not lost. */
const SETTLE_MS = 500
const ID_MAX = 256
const TEXT_MAX = 4096
const MESSAGE_MAX = 300
/** Longest free-text column (title, directory, agent) read; a longer one is read as absent. */
const TEXT_COLUMN_MAX = 4096
/** Rows of `message` and `part` read again at each poll to find updates in place (cursor by key, #420). */
export const OPENCODE_WINDOW_ROWS = 2000
/** A settled row leaves the window once its `time_updated` is older than this (the activity window). */
export const OPENCODE_WINDOW_MS = 10 * 60 * 1000
/** Rows below the window checked per poll for a change the window missed (only id, time_updated and session_id are asked for). */
export const OPENCODE_SWEEP_ROWS = 1000
/**
 * Rows delivered while still open (a tool part pending or running, an assistant message not completed)
 * that are still read by id after they leave the window, so that their end is delivered (#420).
 */
export const OPENCODE_OPEN_ROWS = 500
/** Rows a window can hold for a moment: rows still settling are never pushed out (one poll of them at most). */
const WINDOW_ROWS_MAX = OPENCODE_WINDOW_ROWS + POLL_LIMIT_HARD_MAX + 1
/** Changes found below the window remembered so that each one is counted once. */
const STRAY_MAX = 1000
/** State of a row in the window: to deliver, delivered but may still change, delivered, unreadable (counted). */
const PENDING = 0
const UNSETTLED = 1
const SETTLED = 2
const SKIPPED = 3
const ID_COLUMNS = new Set(['id', 'parent_id', 'session_id', 'message_id'])

// ─── Path ──────────────────────────────────────────────────────────────────

export type OpenCodeDbPath =
  | { kind: 'file'; path: string }
  | { kind: 'unavailable'; message: string }

export interface OpenCodeDbPathOptions {
  env: Record<string, string | undefined>
  homedir: string
  platform: NodeJS.Platform
  /** Explicit setting (absolute path): another file than the default, e.g. a channel database. */
  dbPath?: string
}

function isAbsolute(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p)
}

/** UNC and device paths (\\host\share, //host/share, \\?\...): opening one would reach the network. */
function isNetworkPath(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}|^[\\/]\?\?[\\/]/.test(p)
}

function unavailablePath(message: string): OpenCodeDbPath {
  return { kind: 'unavailable', message: `OpenCode: ${message}` }
}

/**
 * Where OpenCode keeps its database (packages/core/src/database/database.ts, v1.19.0). In order:
 * the `dbPath` setting (absolute, surrounding blanks trimmed), OPENCODE_DB (an absolute path as is; a relative one under <data>,
 * refused if it leaves <data> or is <data> itself), else <data>/opencode.db with <data> = $XDG_DATA_HOME/opencode or
 * ~/.local/share/opencode. The release channel is compiled into the OpenCode binary and is not
 * guessed: a channel database (opencode-<channel>.db) is read only through `dbPath`. Windows and
 * macOS locations are not verified, so only an absolute `dbPath` or OPENCODE_DB works there.
 */
export function resolveOpenCodeDbPath(opts: OpenCodeDbPathOptions): OpenCodeDbPath {
  const { env, homedir, platform } = opts
  const setting = opts.dbPath?.trim()
  if (setting) {
    if (isNetworkPath(setting, platform)) return unavailablePath('a network path is not accepted as the database path.')
    return isAbsolute(setting, platform)
      ? { kind: 'file', path: setting }
      : unavailablePath('the database path setting must be an absolute path.')
  }
  const override = env.OPENCODE_DB
  if (override === ':memory:') {
    return unavailablePath('OPENCODE_DB=:memory: points to an in-memory database, there is no file to read.')
  }
  if (override && isNetworkPath(override, platform)) return unavailablePath('a network path is not accepted as OPENCODE_DB.')
  if (override && isAbsolute(override, platform)) return { kind: 'file', path: override }
  if (platform !== 'linux') {
    return unavailablePath('the default database location is only resolved on Linux; set the database path setting or OPENCODE_DB to an absolute path.')
  }
  const xdg = env.XDG_DATA_HOME
  // An empty or relative home would resolve against the working directory (#420)
  if (!(xdg && path.posix.isAbsolute(xdg)) && !path.posix.isAbsolute(homedir)) {
    return unavailablePath('no home directory is known; set XDG_DATA_HOME, the database path setting or OPENCODE_DB to an absolute path.')
  }
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homedir, '.local', 'share')
  const data = path.posix.join(base, 'opencode')
  if (!override) return { kind: 'file', path: path.posix.join(data, 'opencode.db') }
  const resolved = path.posix.join(data, override).replace(/\/+$/, '')
  if (!resolved.startsWith(`${data}/`)) {
    return unavailablePath('OPENCODE_DB is relative and leaves the OpenCode data directory.')
  }
  return { kind: 'file', path: resolved }
}

// ─── Rows and cursors ──────────────────────────────────────────────────────

/** A session row with the facts the watcher needs beyond the parser's columns. */
export interface OpenCodeSessionRead extends OpenCodeSessionRow {
  agent: string | null
  /** Epoch ms when the session was archived; null while it is not; absent when the column does not exist (unknown). */
  time_archived?: number | null
}

/**
 * Position in one table, a key `(time, after)`: every row with `time_updated` below `time` was read, and
 * so was every row at `time` whose id is up to `after`. `seen` is kept for older callers and is always
 * empty.
 */
export interface OpenCodeCursor {
  time: number
  seen?: string[]
  after?: string
  /**
   * 'key': follow the table by its primary key (message and part only, #420). `time` is then only the
   * start of the activity window at the first poll, and `key` the position, returned by the poll.
   */
  mode?: 'key'
  key?: OpenCodeKeyState
}

/**
 * Position by primary key in `message` or `part` (#420). The window is every row with an id above
 * `below`, up to `top` (rows above `top` are new). Rows at or below `below` are not read again, except
 * by the sweep, which only counts a change it finds there.
 */
export interface OpenCodeKeyState {
  /** Rows with an id up to this one left the window ('' : none did). */
  below: string
  /** Highest id taken into the window ('' : none). */
  top: string
  /** The window, by id: [id, time_updated (-1 when unusable), state]. */
  recent: [string, number, number][]
  /**
   * A row below the window whose time_updated is above this was changed after the reader last saw it
   * (or was never delivered while in the activity window): a loss.
   */
  floor: number
  /** Last id checked by the sweep below the window ('' : start again from the lowest). */
  sweep: string
  /** Changes found below the window and already counted (or delivered by id): [id, time_updated]. */
  stray: [string, number][]
  /**
   * Rows delivered while open (a tool part pending or running, an assistant message not completed),
   * oldest first: [id, time_updated delivered]. Once one leaves the window it is still read by id at each
   * poll, and delivered when it changes; at most OPENCODE_OPEN_ROWS (absent: none).
   */
  open?: [string, number][]
}
export interface OpenCodeCursors {
  session: OpenCodeCursor
  message: OpenCodeCursor
  part: OpenCodeCursor
}
export const EMPTY_OPENCODE_CURSORS: OpenCodeCursors = {
  session: { time: 0 },
  message: { time: 0 },
  part: { time: 0 },
}

export interface OpenCodeSkipped {
  sessionId: string | null
  count: number
}

export interface OpenCodePoll {
  /** Rows changed since the cursors. Feed them to the parser as sessions, then messages, then parts. */
  sessions: OpenCodeSessionRead[]
  messages: OpenCodeMessageRow[]
  parts: OpenCodePartRow[]
  /** Rows ignored because of an unusable id or timestamp, or an oversized `data`. */
  skippedRows: number
  /**
   * The skipped rows the returned cursors moved past, grouped by the session id the row names (null when
   * it names none that is usable). Fed back the cursors, a row is counted here exactly once (#420): rows
   * still settling or held back behind a truncated table come again and are not counted yet.
   */
  skippedPassed: OpenCodeSkipped[]
  /** More settled rows are waiting: poll again right away. */
  truncated: boolean
  /**
   * Changes the reader will not deliver (cursor by key, #420): a row updated after it left the window
   * of recent rows, a row inserted below it, or a row of the activity window never delivered. Grouped by
   * session like `skippedPassed`, each counted once.
   */
  lostPassed: OpenCodeSkipped[]
  /** Rows too recent to be marked as read were delivered (they come again): poll again after a short wait. */
  settling?: boolean
  cursors: OpenCodeCursors
  /** The poll failed (lock, corruption, schema change): nothing was read, the cursors are unchanged. */
  error?: string
}

// ─── Reader ────────────────────────────────────────────────────────────────

const READ_ONLY_SQL = /^\s*(SELECT\b|PRAGMA\s+table_info\(|PRAGMA\s+data_version\s*$)/i

function guarded(conn: IndexConnection): IndexConnection {
  return {
    all(sql) {
      if (!READ_ONLY_SQL.test(sql) || sql.includes(';')) throw new Error('refused: the OpenCode database is read-only')
      return conn.all(sql)
    },
    close: () => conn.close(),
  }
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(CONTROL_ALL, '').trim().slice(0, max)
  return s || undefined
}

function errorText(e: unknown): string {
  return cleanText(e instanceof Error ? e.message : String(e), MESSAGE_MAX) ?? 'unknown error'
}

function timeOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined
}

function idOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX && v.replace(CONTROL_ALL, '') === v ? v : undefined
}

/**
 * A session id is `ses_` + base62 in OpenCode. Anything else is refused: events are stamped with the
 * session id, and a hostile database could carry the UUID of a live Claude session to mix the streams.
 */
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,120}$/

function sessionIdOf(v: unknown): string | undefined {
  const id = idOf(v)
  return id !== undefined && SESSION_ID_RE.test(id) ? id : undefined
}

/** A value as an SQL string literal (an id read from the database, or a cursor key that was checked). */
function quote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

function nullableText(v: unknown): string | null {
  return cleanText(v, TEXT_MAX) ?? null
}

interface TableSpec {
  table: 'session' | 'message' | 'part'
  required: readonly string[]
  optional: readonly string[]
}

const TABLES: Record<TableSpec['table'], TableSpec> = {
  session: {
    table: 'session',
    required: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
    optional: ['agent', 'time_archived'],
  },
  message: { table: 'message', required: ['id', 'session_id', 'time_created', 'time_updated', 'data'], optional: [] },
  part: { table: 'part', required: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'], optional: [] },
}

interface TableRead<T> {
  rows: T[]
  cursor: OpenCodeCursor
  skipped: number
  /** Session id named by each skipped row that the returned cursor moved past (null: none usable). */
  passedSkips: (string | null)[]
  /** Session id named by each change that will not be delivered (cursor by key). */
  lost: (string | null)[]
  truncated: boolean
  settling: boolean
}

export class OpenCodeDb {
  private readonly conn: IndexConnection
  private readonly columns: Record<TableSpec['table'], string[]>
  private closed = false
  private readonly clock: () => number

  constructor(conn: IndexConnection, columns: Record<TableSpec['table'], string[]>, clock: () => number = Date.now) {
    this.conn = conn
    this.columns = columns
    this.clock = clock
  }

  private now(): number { return this.clock() }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.conn.close() } catch { /* already closed */ }
  }

  /**
   * SQLite's data_version: it changes when another connection commits to the database. Lets the
   * caller skip a poll while nothing was written. Undefined when it cannot be read; never throws.
   */
  dataVersion(): number | undefined {
    try {
      const v = Object.values(this.conn.all('PRAGMA data_version')[0] ?? {})[0]
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    } catch { return undefined }
  }

  /**
   * Rows changed since `cursors`. Tool parts are updated in place (pending, running, completed), so
   * the poll follows `time_updated`. Parts are read before messages and messages before sessions: a
   * part always finds its message in this poll or an earlier one. When a later table is truncated the
   * cursor of the earlier ones is held back and their rows are not delivered yet. `skippedRows` is a
   * per-poll snapshot, not to be summed. Rows of the last SETTLE_MS are delivered again at the next
   * poll (the parser handles a row once per state).
   */
  poll(cursors: OpenCodeCursors, limit: number = POLL_LIMIT_DEFAULT): OpenCodePoll {
    cursors = {
      session: sanitizeCursor(cursors?.session),
      message: sanitizeCursor(cursors?.message),
      part: sanitizeCursor(cursors?.part),
    }
    const max = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), POLL_LIMIT_HARD_MAX) : POLL_LIMIT_DEFAULT
    try {
      const part = cursors.part.mode === 'key'
        ? this.readByKey('part', cursors.part, max, rowToPart)
        : this.readTable('part', cursors.part, max, rowToPart)
      const message = cursors.message.mode === 'key'
        ? this.readByKey('message', cursors.message, max, rowToMessage)
        : this.readTable('message', cursors.message, max, rowToMessage)
      const session = this.readTable('session', cursors.session, max, rowToSession)
      return {
        // Rows are delivered only when what they point to is already delivered: a part needs its
        // message, a message its session. Held-back rows come again (their cursor did not move).
        sessions: session.rows,
        messages: session.truncated ? [] : message.rows,
        parts: session.truncated || message.truncated ? [] : part.rows,
        skippedRows: part.skipped + message.skipped + session.skipped,
        skippedPassed: groupSkipped([
          ...session.passedSkips,
          ...(session.truncated ? [] : message.passedSkips),
          ...(session.truncated || message.truncated ? [] : part.passedSkips),
        ]),
        lostPassed: groupSkipped([
          ...(session.truncated ? [] : message.lost),
          ...(session.truncated || message.truncated ? [] : part.lost),
        ]),
        truncated: part.truncated || message.truncated || session.truncated,
        settling: part.settling || message.settling || session.settling,
        cursors: {
          session: session.cursor,
          message: session.truncated ? cursors.message : message.cursor,
          part: session.truncated || message.truncated ? cursors.part : part.cursor,
        },
      }
    } catch (e) {
      return {
        sessions: [], messages: [], parts: [], skippedRows: 0, skippedPassed: [], lostPassed: [], truncated: false, cursors,
        error: `OpenCode: the database could not be read (${errorText(e)}).`,
      }
    }
  }

  /**
   * One session row by id, or undefined (absent, unusable, or the read failed). An indexed lookup by
   * the primary key, for a root or parent that is no longer among the remembered rows (#420).
   */
  sessionById(id: string): OpenCodeSessionRead | undefined {
    if (sessionIdOf(id) === undefined) return undefined
    try {
      // The id is sent as hexadecimal UTF-8, like the cursor key
      const raw = this.conn.all(`SELECT ${this.selectColumns('session').join(', ')} FROM session `
        + `WHERE id = CAST(X'${Buffer.from(id, 'utf8').toString('hex')}' AS TEXT) LIMIT 1`)
      const row = raw[0] ? rowToSession(raw[0]) : undefined
      return row && row.id === id ? row : undefined
    } catch { return undefined }
  }

  // Every selected value is bounded in SQL, because node:sqlite throws on an integer above 2^53
  // (one such row would fail the poll forever). A number outside the safe range, a REAL or a
  // non-text id reads as absent and the row is skipped; text above its bound is not loaded: data
  // and free text read as absent, an id-like column as '' (a row with a broken parent_id is
  // skipped, not taken for a root).
  private selectColumns(name: TableSpec['table']): string[] {
    return this.columns[name].map(c => {
      if (c === 'data') return `CASE WHEN typeof(data) = 'text' AND ${DATA_BYTES} <= ${OPENCODE_ROW_DATA_MAX} THEN data END AS data`
      if (c === 'time_created' || c === 'time_archived') {
        return `CASE WHEN typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND ${MAX_SAFE} THEN ${c} END AS ${c}`
      }
      if (ID_COLUMNS.has(c)) {
        return `CASE WHEN ${c} IS NULL THEN NULL WHEN typeof(${c}) = 'text' AND length(${c}) <= ${ID_MAX} THEN ${c} ELSE '' END AS ${c}`
      }
      if (c === 'directory' || c === 'title' || c === 'agent') {
        return `CASE WHEN typeof(${c}) = 'text' AND length(${c}) <= ${TEXT_COLUMN_MAX} THEN ${c} END AS ${c}`
      }
      return `CASE WHEN typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND ${MAX_SAFE} THEN ${c} END AS ${c}`
    })
  }

  private readTable<T extends { id: string; time_updated: number }>(
    name: TableSpec['table'],
    cursor: OpenCodeCursor,
    limit: number,
    map: (r: Record<string, unknown>) => T | undefined,
  ): TableRead<T> {
    const cols = this.selectColumns(name)
    const t = cursor.time
    const now = this.now()
    // A row dated in the future is not read: it would carry the cursor out of reach of real writes
    const upper = Math.min(now + FUTURE_MARGIN_MS, MAX_SAFE)
    // The key is sent as hexadecimal UTF-8: no text from the database goes into the query as is
    const from = cursor.after !== undefined
      ? `(time_updated > ${t} OR (time_updated = ${t} AND id > CAST(X'${Buffer.from(cursor.after, 'utf8').toString('hex')}' AS TEXT)))`
      : `time_updated >= ${t}`
    // ORDER BY names the table: the bounded `AS id` / `AS time_updated` aliases would otherwise sort the clipped values
    const where = `WHERE typeof(time_updated) = 'integer' AND time_updated > 0 AND time_updated <= ${upper} `
      + `AND typeof(id) = 'text' AND length(id) BETWEEN 1 AND ${ID_MAX} AND instr(id, char(0)) = 0 `
      + `AND ${from} ORDER BY ${name}.time_updated ASC, ${name}.id ASC`
    const sqlLimit = limit + 1
    let rowLimit = sqlLimit
    let budgetHit = false
    if (this.columns[name].includes('data')) {
      // First a light query (the size of data, not its content), to cut the rows at the byte budget before loading them.
      const sizes = this.conn.all(
        `SELECT ${DATA_SIZE} AS n `
        + `FROM ${name} ${where} LIMIT ${sqlLimit}`)
      let total = 0
      let cut = sizes.length
      for (let i = 0; i < sizes.length; i++) {
        const v = sizes[i]?.n
        const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
        if (i > 0 && total + n > OPENCODE_POLL_BYTES_MAX) { cut = i; break }
        total += n
      }
      if (cut < sizes.length) { rowLimit = cut; budgetHit = true }
    }
    const raw = this.conn.all(`SELECT ${cols.join(', ')} FROM ${name} ${where} LIMIT ${rowLimit}`)

    // A row stays in the sequence even when its content is unusable: the cursor must move past it
    let skipped = 0
    const fresh: { id: string; time: number; row: T | undefined; owner: string | null }[] = []
    for (const r of raw) {
      // The raw id keeps the row in the sequence; the row mappers refuse an id that is not usable
      const id = r && typeof r.id === 'string' ? r.id : undefined
      const time = r ? timeOf(r.time_updated) : undefined
      if (id === undefined || time === undefined) { skipped++; continue }
      fresh.push({ id, time, row: map(r), owner: sessionIdOf(name === 'session' ? r.id : r.session_id) ?? null })
    }
    const more = raw.length >= sqlLimit || budgetHit
    const taken = fresh.slice(0, limit)

    const rows: T[] = []
    for (const f of taken) {
      if (f.row) rows.push(f.row)
      else skipped++
    }
    // A row written in the last instants may still change within the same millisecond: it is delivered
    // but not marked as read, so the next poll gives it again (the parser handles a row once per state).
    const settled = taken.filter(f => f.time <= now - SETTLE_MS)
    const settling = settled.length < taken.length
    if (settled.length === 0) return { rows, cursor, skipped, passedSkips: [], lost: [], truncated: false, settling }
    const last = settled[settled.length - 1]
    const passedSkips = settled.filter(f => !f.row).map(f => f.owner)
    return { rows, cursor: { time: last.time, after: last.id }, skipped, passedSkips, lost: [], truncated: more, settling }
  }

  /**
   * OpenCode's ids keep only the low 48 bits of `ms * 0x1000 + counter` (packages/schema/src/identifier.ts,
   * v1.19.0): they wrap about every 795 days, the last time on 2026-08-14. Rows written before a wrap
   * have ids above every newer one. The id of a row written now (plus the future margin) bounds the
   * current epoch: when an OpenCode id lies above it, the table holds an older epoch and the reads by
   * key stop at that ceiling (the older rows are only swept). Undefined when there is nothing above it
   * in OpenCode's format (no older epoch, or ids of another shape): the reads are not bounded.
   */
  private epochCeiling(name: 'message' | 'part', now: number): string | undefined {
    const prefix = name === 'part' ? 'prt' : 'msg'
    const value = (BigInt(Math.min(now + FUTURE_MARGIN_MS, MAX_SAFE)) * 0x1000n + 0xfffn) & 0xffffffffffffn
    // '~' sorts after every base62 character: the ceiling is above every id of that 48-bit value
    const ceiling = `${prefix}_${value.toString(16).padStart(12, '0')}~`
    const above = this.conn.all(`SELECT id FROM ${name} WHERE ${KEY_ID_OK} AND id > ${hexText(ceiling)} ORDER BY ${name}.id ASC LIMIT 1`)[0]?.id
    return typeof above === 'string' && OPENCODE_ID_RE.test(above) && above.startsWith(`${prefix}_`) ? ceiling : undefined
  }

  /**
   * Columns of the light reads by key: the size of data in bytes (`withSize`), never its content. The
   * sweep only counts changes and does not ask for the size.
   */
  private lightColumns(name: 'message' | 'part', withSize = true): string {
    return `id, CASE WHEN typeof(time_updated) = 'integer' AND time_updated BETWEEN 1 AND ${MAX_SAFE} THEN time_updated END AS t, `
      + `CASE WHEN typeof(session_id) = 'text' AND length(session_id) <= ${ID_MAX} THEN session_id END AS owner`
      + (withSize ? `, ${DATA_SIZE} AS n ` : ' ')
      + `FROM ${name} WHERE ${KEY_ID_OK}`
  }

  /**
   * First poll by key: the last OPENCODE_WINDOW_ROWS rows by id form the window. Those updated since
   * `since` are to deliver; the others are only remembered. Rows below the window are not read: one
   * updated since `since` is a loss the sweep will count (floor = since - 1).
   */
  private keyStart(name: 'message' | 'part', since: number, ceiling: string): OpenCodeKeyState {
    const raw = this.conn.all(`SELECT ${this.lightColumns(name)}${ceiling} ORDER BY ${name}.id DESC LIMIT ${OPENCODE_WINDOW_ROWS + 1}`)
    let below = ''
    let list = raw
    if (raw.length > OPENCODE_WINDOW_ROWS) {
      below = String(raw[OPENCODE_WINDOW_ROWS].id)
      list = raw.slice(0, OPENCODE_WINDOW_ROWS)
    }
    const recent = list.reverse().map((r): [string, number, number] => {
      const t = timeOf(r.t) ?? -1
      // An unusable time in the history is not counted, as with the cursor by time
      return [String(r.id), t, t === -1 ? SKIPPED : t >= since ? PENDING : SETTLED]
    })
    const top = recent.length > 0 ? recent[recent.length - 1][0] : below
    return { below, top, recent, floor: Math.max(since - 1, 0), sweep: '', stray: [] }
  }

  /**
   * Rows of `message` or `part` changed since the key cursor (#420). Three reads, all through the
   * primary key index: the window and the new rows with the size of their data but not its content (at
   * most OPENCODE_WINDOW_ROWS + limit + 1), the data of the rows that are new or changed (at most
   * `limit`, within the byte budget), and OPENCODE_SWEEP_ROWS rows below the window (id, time_updated,
   * session_id). The light reads still read the b-tree leaf pages, which hold the start of each row.
   */
  private readByKey<T extends { id: string; time_updated: number; data: string }>(
    name: 'message' | 'part',
    cursor: OpenCodeCursor,
    limit: number,
    map: (r: Record<string, unknown>) => T | undefined,
  ): TableRead<T> {
    const now = this.now()
    const upper = Math.min(now + FUTURE_MARGIN_MS, MAX_SAFE)
    const epoch = this.epochCeiling(name, now)
    const ceiling = epoch === undefined ? '' : ` AND id <= ${hexText(epoch)}`
    let state = cursor.key ?? this.keyStart(name, cursor.time, ceiling)
    if (epoch !== undefined && state.top > epoch) {
      // The ids wrapped while the reader ran: the window is in the older epoch. It starts again under the
      // ceiling; what it held raises the floor, so that the sweep does not take those rows for losses.
      let floor = state.floor
      for (const [, t] of state.recent) floor = Math.max(floor, Math.min(t, now))
      state = { ...this.keyStart(name, cursor.time, ceiling), stray: state.stray, open: state.open }
      state.floor = Math.max(state.floor, floor)
    }
    const recent = new Map<string, [number, number]>(state.recent.map(([id, t, s]) => [id, [t, s]]))
    const stray = new Map<string, number>(state.stray)
    const open = new Map<string, number>(state.open ?? [])
    let floor = state.floor

    const capRows = OPENCODE_WINDOW_ROWS + limit + 1
    const range = this.conn.all(`SELECT ${this.lightColumns(name)} AND id > ${hexText(state.below)}${ceiling} `
      + `ORDER BY ${name}.id ASC LIMIT ${capRows}`)
    const owners = new Map<string, string | null>()
    const toLoad: string[] = []
    let bytes = 0
    let full = false
    let skipped = 0
    const passedSkips: (string | null)[] = []
    const lost: (string | null)[] = []
    // Open rows that left the window are read by id (#420): a tool silent for longer than the window
    // still ends when it finishes. A changed one is loaded first, within the same limits.
    const pinned = new Set<string>()
    const outside = [...open.keys()].filter(id => state.below !== '' && id <= state.below)
    if (outside.length > 0) {
      const found = new Set<string>()
      for (const r of this.conn.all(`SELECT ${this.lightColumns(name)} AND id IN (${outside.map(hexText).join(', ')}) ORDER BY ${name}.id ASC`)) {
        const id = String(r.id)
        found.add(id)
        const t = timeOf(r.t)
        if (t === undefined || t > upper || t === open.get(id)) continue
        const v = r.n
        const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
        if (toLoad.length >= limit || (toLoad.length > 0 && bytes + n > OPENCODE_POLL_BYTES_MAX)) { full = true; break }
        bytes += n
        owners.set(id, sessionIdOf(r.owner) ?? null)
        pinned.add(id)
        toLoad.push(id)
      }
      // Deleted: nothing more to follow (only known when the read went through)
      if (!full) for (const id of outside) if (!found.has(id)) open.delete(id)
    }
    for (const r of range) {
      if (full) break
      const id = String(r.id)
      const owner = sessionIdOf(r.owner) ?? null
      owners.set(id, owner)
      const t = timeOf(r.t) ?? -1
      const prev = recent.get(id)
      if (t === -1) {
        // Unusable time: counted once, never delivered
        if (!prev || prev[1] !== SKIPPED || prev[0] !== -1) { skipped++; passedSkips.push(owner) }
        recent.set(id, [-1, SKIPPED])
        continue
      }
      // Dated in the future (a wrong clock or a hostile database): delivered once it is not
      if (t > upper) { if (!prev || prev[0] !== t) recent.set(id, [t, PENDING]); continue }
      const changed = !prev || prev[0] !== t || prev[1] === PENDING || prev[1] === UNSETTLED
      if (!changed) continue
      const v = r.n
      const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
      if (toLoad.length >= limit || (toLoad.length > 0 && bytes + n > OPENCODE_POLL_BYTES_MAX)) { full = true; break }
      bytes += n
      toLoad.push(id)
    }

    const remember = (id: string, t: number): void => {
      stray.delete(id)
      stray.set(id, t)
      if (stray.size > STRAY_MAX) {
        const oldest = stray.entries().next().value
        if (oldest) { stray.delete(oldest[0]); floor = Math.max(floor, Math.min(oldest[1], now)) }
      }
    }
    // A delivered row that is still open stays followed after it leaves the window; the oldest beyond
    // OPENCODE_OPEN_ROWS is dropped (a later change to it is then counted by the sweep, not read).
    const noteOpen = (row: T): void => {
      open.delete(row.id)
      if (!isOpenRow(name, row.data)) return
      open.set(row.id, row.time_updated)
      if (open.size > OPENCODE_OPEN_ROWS) {
        const oldest = open.keys().next().value
        if (oldest !== undefined) open.delete(oldest)
      }
    }
    const rows: T[] = []
    let settling = false
    let progressed = false
    if (toLoad.length > 0) {
      const raw = this.conn.all(`SELECT ${this.selectColumns(name).join(', ')} FROM ${name} `
        + `WHERE id IN (${toLoad.map(hexText).join(', ')}) ORDER BY ${name}.id ASC`)
      const byId = new Map<string, Record<string, unknown>>()
      for (const r of raw) if (r && typeof r.id === 'string') byId.set(r.id, r)
      for (const id of toLoad) {
        const r = byId.get(id)
        if (!r) continue // deleted between the two reads
        const t = timeOf(r.time_updated)
        if (pinned.has(id)) {
          // Below the window: delivered (or counted when unreadable), never taken back into the window.
          // Remembered with its time, so that the sweep does not count this change as a loss.
          if (t !== undefined && t > upper) continue
          const row = t === undefined ? undefined : map(r)
          if (!row) { progressed = true; remember(id, t ?? -1); open.delete(id); skipped++; passedSkips.push(owners.get(id) ?? null); continue }
          rows.push(row)
          // Still settling: given again at the next poll (its previous time is kept), like in the window
          if (row.time_updated > now - SETTLE_MS) { settling = true; continue }
          progressed = true
          remember(id, row.time_updated)
          noteOpen(row)
          continue
        }
        const prev = recent.get(id)
        if (t !== undefined && t > upper) { recent.set(id, [t, PENDING]); progressed = true; continue }
        const row = t === undefined ? undefined : map(r)
        if (!row) {
          progressed = true
          open.delete(id)
          if (!prev || prev[1] !== SKIPPED || prev[0] !== (t ?? -1)) { skipped++; passedSkips.push(owners.get(id) ?? null) }
          recent.set(id, [t ?? -1, SKIPPED])
          continue
        }
        rows.push(row)
        noteOpen(row)
        const settled = row.time_updated <= now - SETTLE_MS
        if (!settled) settling = true
        // Giving again a row that is still settling is no progress: it must not keep the caller polling hot
        if (settled || !prev || prev[0] !== row.time_updated || prev[1] !== UNSETTLED) progressed = true
        recent.set(id, [row.time_updated, settled ? SETTLED : UNSETTLED])
      }
    }
    // A row of the window that is gone was deleted (only known when the read saw the whole window)
    if (!full && range.length < capRows) for (const id of [...recent.keys()]) if (!owners.has(id)) recent.delete(id)

    // The window keeps its newest OPENCODE_WINDOW_ROWS rows, and a settled row older than
    // OPENCODE_WINDOW_MS leaves it. What leaves raises the floor, under which the sweep sees no change.
    const sorted = [...recent].sort(byFirst)
    const cutoff = now - OPENCODE_WINDOW_MS
    let below = state.below
    let i = 0
    for (; i < sorted.length; i++) {
      const [id, [t, s]] = sorted[i]
      // A row delivered less than SETTLE_MS ago may still change within its millisecond: it stays (the
      // window then holds at most one poll of rows more than OPENCODE_WINDOW_ROWS, for SETTLE_MS)
      if (s === UNSETTLED) break
      const over = sorted.length - i > OPENCODE_WINDOW_ROWS
      const old = (s === SETTLED || s === SKIPPED) && t < cutoff
      if (!over && !old) break
      // Pushed out before it was ever delivered: a loss, remembered so that the sweep does not count it again
      if (s === PENDING) { lost.push(owners.get(id) ?? null); remember(id, t) }
      floor = Math.max(floor, Math.min(t, now))
      below = id
    }
    const kept = sorted.slice(i)
    let top = state.top
    const highest = kept.length > 0 ? kept[kept.length - 1][0] : below
    if (highest > top) top = highest

    // The sweep: a row outside the window (below it, or above the epoch ceiling) changed after the
    // reader last saw it, or inserted there, is counted, not read. One chunk per poll, below the window
    // first, then above the ceiling, then again from the lowest id.
    let sweep = state.sweep
    let segment = ''
    let next = ''
    if (below !== '' && sweep < below) {
      segment = `AND id > ${hexText(sweep)} AND id <= ${hexText(below)}`
      next = epoch === undefined ? '' : below
    } else if (epoch !== undefined) {
      segment = `AND id > ${hexText(sweep > epoch ? sweep : epoch)}`
    }
    if (segment) {
      const swept = this.conn.all(`SELECT ${this.lightColumns(name, false)} ${segment} ORDER BY ${name}.id ASC LIMIT ${OPENCODE_SWEEP_ROWS}`)
      for (const r of swept) {
        const id = String(r.id)
        const t = timeOf(r.t)
        // An open row is read by id (above): its change is delivered there, not lost
        if (t === undefined || t <= floor || stray.get(id) === t || open.has(id)) continue
        lost.push(sessionIdOf(r.owner) ?? null)
        remember(id, t)
      }
      sweep = swept.length < OPENCODE_SWEEP_ROWS ? next : String(swept[swept.length - 1].id)
    } else {
      sweep = ''
    }

    const key: OpenCodeKeyState = {
      below,
      top,
      recent: kept.map(([id, [t, s]]): [string, number, number] => [id, t, s]),
      floor,
      sweep,
      stray: [...stray],
      open: [...open],
    }
    return {
      rows,
      cursor: { time: cursor.time, mode: 'key', key },
      skipped,
      passedSkips,
      lost,
      truncated: (full || range.length >= capRows) && progressed,
      settling,
    }
  }
}

/**
 * Size of `data` in bytes. octet_length() of a column takes the size from the record header and does
 * not load the content; length() counts characters, so it reads the whole text, overflow pages
 * included (measured: 33 MB read for a window of 2,000 rows of 16 KB, see the bench in bytes of
 * opencode-db-key-cursor.test.ts). typeof() does not load it either.
 */
const DATA_BYTES = 'octet_length(data)'
/** Size in bytes of a readable `data`, else 0 (bounded like the data read). */
const DATA_SIZE = `CASE WHEN typeof(data) = 'text' AND ${DATA_BYTES} <= ${OPENCODE_ROW_DATA_MAX} THEN ${DATA_BYTES} ELSE 0 END`

/** An ascending message or part id of OpenCode: prefix, 12 hex digits of time, 14 base62 characters. */
const OPENCODE_ID_RE = /^(msg|prt)_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** Only these ids are read by key: text, bounded, without NUL (the rows the cursor by time reads). */
const KEY_ID_OK = `typeof(id) = 'text' AND length(id) BETWEEN 1 AND ${ID_MAX} AND instr(id, char(0)) = 0`

/** A checked id as an SQL text literal, sent as hexadecimal UTF-8: no text from the database goes into a query as is. */
function hexText(v: string): string {
  return `CAST(X'${Buffer.from(v, 'utf8').toString('hex')}' AS TEXT)`
}

/** Skipped rows counted per session id; the unattributed (null) first, then by id. */
function groupSkipped(owners: (string | null)[]): OpenCodeSkipped[] {
  const counts = new Map<string | null, number>()
  for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1)
  return [...counts].map(([sessionId, count]) => ({ sessionId, count }))
    .sort((a, b) => (a.sessionId === b.sessionId ? 0 : a.sessionId === null ? -1 : b.sessionId === null ? 1 : a.sessionId < b.sessionId ? -1 : 1))
}

/** A cursor from the caller is data: only a safe integer time and a bounded list of valid ids go into a query. */
function sanitizeCursor(c: OpenCodeCursor | undefined): OpenCodeCursor {
  const time = c && typeof c.time === 'number' && Number.isSafeInteger(c.time) && c.time > 0 ? c.time : 0
  if (c && c.mode === 'key') {
    const key = sanitizeKey(c.key)
    return key ? { time, mode: 'key', key } : { time, mode: 'key' }
  }
  const after = c && time > 0 && rawId(c.after) ? c.after : undefined
  return after !== undefined ? { time, after } : { time }
}

function rawId(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= ID_MAX && !x.includes('\0')
}
const rawIdOrEmpty = (x: unknown): x is string => x === '' || rawId(x)
const safeTime = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= -1
const byFirst = <T extends [string, ...unknown[]]>(a: T, b: T): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

/**
 * A key position from the caller, checked like any other input: bounded lists of valid ids and safe
 * integers. A malformed scalar starts the table again (a first poll); a malformed window entry is dropped.
 */
function sanitizeKey(k: unknown): OpenCodeKeyState | undefined {
  if (!k || typeof k !== 'object') return undefined
  const o = k as Record<string, unknown>
  const { below, top, sweep, floor } = o
  if (!rawIdOrEmpty(below) || !rawIdOrEmpty(top) || !rawIdOrEmpty(sweep) || !safeTime(floor)) return undefined
  const byId = new Map<string, [number, number]>()
  for (const e of Array.isArray(o.recent) ? o.recent.slice(0, WINDOW_ROWS_MAX * 2) : []) {
    if (!Array.isArray(e) || e.length !== 3) continue
    const [id, t, s] = e as unknown[]
    if (!rawId(id) || id <= below || !safeTime(t) || !(s === PENDING || s === UNSETTLED || s === SETTLED || s === SKIPPED)) continue
    byId.set(id, [t, s])
  }
  const recent = [...byId].sort(byFirst).slice(-WINDOW_ROWS_MAX)
    .map(([id, [t, s]]): [string, number, number] => [id, t, s])
  const stray: [string, number][] = []
  for (const e of Array.isArray(o.stray) ? o.stray.slice(-STRAY_MAX) : []) {
    if (Array.isArray(e) && e.length === 2 && rawId(e[0]) && safeTime(e[1])) stray.push([e[0], e[1]])
  }
  const open: [string, number][] = []
  for (const e of Array.isArray(o.open) ? o.open.slice(-OPENCODE_OPEN_ROWS) : []) {
    if (Array.isArray(e) && e.length === 2 && rawId(e[0]) && safeTime(e[1])) open.push([e[0], e[1]])
  }
  let high = top
  if (recent.length > 0 && recent[recent.length - 1][0] > high) high = recent[recent.length - 1][0]
  if (below > high) high = below
  return { below, top: high, recent, floor, sweep, stray, open }
}

/**
 * A delivered row whose state can still change in a way the canvas shows (#420): a tool part pending or
 * running (OpenCode then sets completed or error), an assistant message without `time.completed`. Only
 * these are followed by id after they leave the window. Unparsable data is not open.
 */
export function isOpenRow(name: 'message' | 'part', data: string): boolean {
  // Cheap filter first: most rows are neither (text parts, user messages)
  if (!data.includes(name === 'part' ? '"tool"' : '"assistant"')) return false
  let v: unknown
  try { v = JSON.parse(data) } catch { return false }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (name === 'part') {
    const st = o.state && typeof o.state === 'object' ? (o.state as Record<string, unknown>).status : undefined
    return o.type === 'tool' && (st === 'pending' || st === 'running')
  }
  const time = o.time && typeof o.time === 'object' ? (o.time as Record<string, unknown>) : undefined
  const completed = time?.completed
  return o.role === 'assistant' && !(typeof completed === 'number' && completed > 0)
}

function rowToSession(r: Record<string, unknown>): OpenCodeSessionRead | undefined {
  const id = sessionIdOf(r.id)
  const created = timeOf(r.time_created)
  const updated = timeOf(r.time_updated)
  if (id === undefined || created === undefined || updated === undefined) return undefined
  const parent = r.parent_id === null || r.parent_id === undefined ? null : sessionIdOf(r.parent_id)
  if (parent === undefined) return undefined
  return {
    id,
    parent_id: parent,
    directory: nullableText(r.directory),
    title: nullableText(r.title),
    agent: nullableText(r.agent),
    time_created: created,
    time_updated: updated,
    ...('time_archived' in r ? { time_archived: timeOf(r.time_archived) ?? null } : {}),
  }
}

function rowToMessage(r: Record<string, unknown>): OpenCodeMessageRow | undefined {
  const id = idOf(r.id)
  const sessionId = sessionIdOf(r.session_id)
  const created = timeOf(r.time_created)
  const updated = timeOf(r.time_updated)
  if (id === undefined || sessionId === undefined || created === undefined || updated === undefined || typeof r.data !== 'string') return undefined
  return { id, session_id: sessionId, time_created: created, time_updated: updated, data: r.data }
}

function rowToPart(r: Record<string, unknown>): OpenCodePartRow | undefined {
  const id = idOf(r.id)
  const messageId = idOf(r.message_id)
  const sessionId = sessionIdOf(r.session_id)
  const created = timeOf(r.time_created)
  const updated = timeOf(r.time_updated)
  if (id === undefined || messageId === undefined || sessionId === undefined || created === undefined || updated === undefined || typeof r.data !== 'string') return undefined
  return { id, message_id: messageId, session_id: sessionId, time_created: created, time_updated: updated, data: r.data }
}

export type OpenCodeDbOpen =
  | { status: 'ok'; db: OpenCodeDb }
  | { status: 'unavailable'; message: string }

function unavailable(message: string): OpenCodeDbOpen {
  return { status: 'unavailable', message }
}

/**
 * Open the database read-only and check the schema (the three tables and the columns the parser
 * reads). Does not create the file. `opener` defaults to node:sqlite; null means no driver.
 */
export function openOpenCodeDb(
  file: string,
  opener: IndexOpener | null | undefined = nodeSqliteOpener(),
  clock?: () => number,
): OpenCodeDbOpen {
  if (!opener) return unavailable('OpenCode: no SQLite driver in this Node version (node:sqlite needs Node 22.13 or later).')
  let exists = false
  try { exists = fs.statSync(file).isFile() } catch { /* reported below */ }
  if (!exists) return unavailable('OpenCode: database not found.')

  let conn: IndexConnection | null = null
  try {
    conn = guarded(opener(file, { readOnly: true, timeoutMs: TIMEOUT_MS }))
    const columns = { session: [] as string[], message: [] as string[], part: [] as string[] }
    for (const spec of Object.values(TABLES)) {
      const present = new Set(conn.all(`PRAGMA table_info(${spec.table})`).map(r => (r && typeof r.name === 'string' ? r.name : '')))
      if (!present.has('id')) return closeWith(conn, `OpenCode: table "${spec.table}" not found in the database.`)
      const missing = spec.required.filter(c => !present.has(c))
      if (missing.length > 0) {
        return closeWith(conn, `OpenCode: required column(s) missing from "${spec.table}": ${missing.join(', ')}.`)
      }
      columns[spec.table] = [...spec.required, ...spec.optional.filter(c => present.has(c))]
    }
    return { status: 'ok', db: new OpenCodeDb(conn, columns, clock) }
  } catch (e) {
    try { conn?.close() } catch { /* already closed */ }
    return unavailable(`OpenCode: the database could not be opened (${errorText(e)}).`)
  }
}

function closeWith(conn: IndexConnection, message: string): OpenCodeDbOpen {
  try { conn.close() } catch { /* already closed */ }
  return unavailable(message)
}
