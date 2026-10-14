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
 * - No network, no vscode dependency: usable from the relay. The database content is untrusted input.
 */
import * as fs from 'fs'
import * as path from 'path'
import { CONTROL_ALL } from './control-chars'
import { nodeSqliteOpener, type IndexConnection, type IndexOpener } from './session-index'
import type { OpenCodeSessionRow, OpenCodeMessageRow, OpenCodePartRow } from './opencode-event-parser'

/** Largest `data` column read, in characters; a larger row is skipped and counted. */
export const OPENCODE_ROW_DATA_MAX = 1024 * 1024
/** Rows read per table and per poll. */
const POLL_LIMIT_DEFAULT = 500
const POLL_LIMIT_HARD_MAX = 5000
const TIMEOUT_MS = 1000
/** Rows dated further ahead than this are not read (a wrong clock or a hostile database). */
const FUTURE_MARGIN_MS = 24 * 60 * 60 * 1000
/** Rows newer than this are given again until they are older: an update in the same millisecond is not lost. */
const SETTLE_MS = 500
const ID_MAX = 256
const TEXT_MAX = 4096
const MESSAGE_MAX = 300
/** Longest free-text column (title, directory, agent) read; a longer one is read as absent. */
const TEXT_COLUMN_MAX = 4096
/** Most ids remembered at the cursor time. */
const SEEN_MAX = POLL_LIMIT_HARD_MAX
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
  return platform === 'win32' && /^[\\/]{2}/.test(p)
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
 * Position in one table: every row with `time_updated` below `time` was read, and `seen` are the ids
 * read at `time`. Past SEEN_MAX ids at one millisecond the position becomes a key instead: every row at
 * `time` with an id up to `after` was read (`seen` is then empty).
 */
export interface OpenCodeCursor {
  time: number
  seen: string[]
  after?: string
}
export interface OpenCodeCursors {
  session: OpenCodeCursor
  message: OpenCodeCursor
  part: OpenCodeCursor
}
export const EMPTY_OPENCODE_CURSORS: OpenCodeCursors = {
  session: { time: 0, seen: [] },
  message: { time: 0, seen: [] },
  part: { time: 0, seen: [] },
}

export interface OpenCodePoll {
  /** Rows changed since the cursors. Feed them to the parser as sessions, then messages, then parts. */
  sessions: OpenCodeSessionRead[]
  messages: OpenCodeMessageRow[]
  parts: OpenCodePartRow[]
  /** Rows ignored because of an unusable id or timestamp, or an oversized `data`. */
  skippedRows: number
  /** More rows are waiting: poll again right away. */
  truncated: boolean
  cursors: OpenCodeCursors
  /** The poll failed (lock, corruption, schema change): nothing was read, the cursors are unchanged. */
  error?: string
}

// ─── Reader ────────────────────────────────────────────────────────────────

const READ_ONLY_SQL = /^\s*(SELECT\b|PRAGMA\s+table_info\()/i

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
  truncated: boolean
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
      const part = this.readTable('part', cursors.part, max, rowToPart)
      const message = this.readTable('message', cursors.message, max, rowToMessage)
      const session = this.readTable('session', cursors.session, max, rowToSession)
      return {
        // Rows are delivered only when what they point to is already delivered: a part needs its
        // message, a message its session. Held-back rows come again (their cursor did not move).
        sessions: session.rows,
        messages: session.truncated ? [] : message.rows,
        parts: session.truncated || message.truncated ? [] : part.rows,
        skippedRows: part.skipped + message.skipped + session.skipped,
        truncated: part.truncated || message.truncated || session.truncated,
        cursors: {
          session: session.cursor,
          message: session.truncated ? cursors.message : message.cursor,
          part: session.truncated || message.truncated ? cursors.part : part.cursor,
        },
      }
    } catch (e) {
      return {
        sessions: [], messages: [], parts: [], skippedRows: 0, truncated: false, cursors,
        error: `OpenCode: the database could not be read (${errorText(e)}).`,
      }
    }
  }

  private readTable<T extends { id: string; time_updated: number }>(
    name: TableSpec['table'],
    cursor: OpenCodeCursor,
    limit: number,
    map: (r: Record<string, unknown>) => T | undefined,
  ): TableRead<T> {
    // A text column above its bound is not loaded: data and free text read as absent, an id-like
    // column as '' (so a row with a broken parent_id is skipped, not taken for a root).
    const cols = this.columns[name].map(c => {
      if (c === 'data') return `CASE WHEN length(data) > ${OPENCODE_ROW_DATA_MAX} THEN NULL ELSE data END AS data`
      if (c === 'time_created' || c === 'time_archived') {
        return `CASE WHEN typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER} THEN ${c} END AS ${c}`
      }
      if (ID_COLUMNS.has(c)) return `CASE WHEN length(${c}) > ${ID_MAX} THEN '' ELSE ${c} END AS ${c}`
      if (c === 'directory' || c === 'title' || c === 'agent') {
        return `CASE WHEN length(${c}) > ${TEXT_COLUMN_MAX} THEN NULL ELSE ${c} END AS ${c}`
      }
      return c
    })
    const t = cursor.time
    const seen = new Set(cursor.seen)
    const now = this.now()
    // A row dated in the far future is not read: it would carry the cursor out of reach of real writes
    const upper = Math.min(now + FUTURE_MARGIN_MS, Number.MAX_SAFE_INTEGER)
    const from = cursor.after !== undefined
      ? `(time_updated > ${t} OR (time_updated = ${t} AND id > ${quote(cursor.after)}))`
      : `time_updated >= ${t}`
    // The ids already read at the cursor time come back first: ask for that many more rows.
    const sqlLimit = limit + seen.size + 1
    const sql = `SELECT ${cols.join(', ')} FROM ${name} WHERE typeof(time_updated) = 'integer' AND time_updated > 0 `
      + `AND time_updated <= ${upper} AND typeof(id) = 'text' AND length(id) BETWEEN 1 AND ${ID_MAX} AND instr(id, char(0)) = 0 `
      + `AND ${from} ORDER BY time_updated ASC, id ASC LIMIT ${sqlLimit}`
    const raw = this.conn.all(sql)

    // A row stays in the sequence even when its content is unusable: the cursor must move past it
    let skipped = 0
    const fresh: { id: string; time: number; row: T | undefined }[] = []
    for (const r of raw) {
      const id = r && typeof r.id === 'string' ? r.id : undefined
      const time = r ? timeOf(r.time_updated) : undefined
      if (id === undefined || time === undefined) { skipped++; continue }
      if (time === t && seen.has(id)) continue
      fresh.push({ id, time, row: map(r) })
    }
    const truncated = raw.length >= sqlLimit || fresh.length > limit
    const taken = fresh.slice(0, limit)

    const rows: T[] = []
    for (const f of taken) {
      if (f.row) rows.push(f.row)
      else skipped++
    }
    // A row written in the last instants may still change within the same millisecond: it is delivered
    // but not marked as read, so the next poll gives it again (the parser handles a row once per state).
    const settled = taken.filter(f => f.time <= now - SETTLE_MS)
    if (settled.length === 0) return { rows, cursor, skipped, truncated }
    const last = settled[settled.length - 1].time
    const ids = settled.filter(f => f.time === last).map(f => f.id)
    const sameTime = last === t
    const seenNext = sameTime && cursor.after === undefined ? [...cursor.seen, ...ids] : ids
    const next: OpenCodeCursor = seenNext.length > SEEN_MAX
      ? { time: last, seen: [], after: ids[ids.length - 1] }
      : { time: last, seen: seenNext }
    return { rows, cursor: next, skipped, truncated }
  }
}

/** A cursor from the caller is data: only a safe integer time and a bounded list of valid ids go into a query. */
function sanitizeCursor(c: OpenCodeCursor | undefined): OpenCodeCursor {
  const time = c && typeof c.time === 'number' && Number.isSafeInteger(c.time) && c.time > 0 ? c.time : 0
  const rawId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= ID_MAX && !x.includes('\0')
  const seen = c && time > 0 && Array.isArray(c.seen) ? c.seen.slice(-SEEN_MAX).filter(rawId) : []
  const after = c && time > 0 && rawId(c.after) ? c.after : undefined
  return after !== undefined ? { time, seen: [], after } : { time, seen }
}

function rowToSession(r: Record<string, unknown>): OpenCodeSessionRead | undefined {
  const id = idOf(r.id)
  const created = timeOf(r.time_created)
  const updated = timeOf(r.time_updated)
  if (id === undefined || created === undefined || updated === undefined) return undefined
  const parent = r.parent_id === null || r.parent_id === undefined ? null : idOf(r.parent_id)
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
  const sessionId = idOf(r.session_id)
  const created = timeOf(r.time_created)
  const updated = timeOf(r.time_updated)
  if (id === undefined || sessionId === undefined || created === undefined || updated === undefined || typeof r.data !== 'string') return undefined
  return { id, session_id: sessionId, time_created: created, time_updated: updated, data: r.data }
}

function rowToPart(r: Record<string, unknown>): OpenCodePartRow | undefined {
  const id = idOf(r.id)
  const messageId = idOf(r.message_id)
  const sessionId = idOf(r.session_id)
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
    return { status: 'ok', db: new OpenCodeDb(conn, columns) }
  } catch (e) {
    try { conn?.close() } catch { /* already closed */ }
    return unavailable(`OpenCode: the database could not be opened (${errorText(e)}).`)
  }
}

function closeWith(conn: IndexConnection, message: string): OpenCodeDbOpen {
  try { conn.close() } catch { /* already closed */ }
  return unavailable(message)
}
