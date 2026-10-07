/**
 * Optional adapter reading an existing session index (e.g. a local SQLite database) in read-only mode.
 *
 * - Versioned: `PRAGMA user_version` above SESSION_INDEX_MAX_SCHEMA_VERSION is not guessed at, the
 *   adapter falls back with an explicit message.
 * - Strict on the required columns (id, started_at), tolerant of the optional ones and of columns it
 *   does not know about; only existing columns are ever selected.
 * - Bounded: at most `maxRows` rows, the truncation is reported.
 * - Never throws: every failure (missing file, no driver, lock, corruption, schema change) becomes a
 *   `degraded` / `unavailable` result carrying a message the UI can show.
 * - Read-only by construction: the connection is opened read-only and only SELECT and two read
 *   PRAGMAs are accepted by the connection wrapper. The database content is untrusted input.
 * No vscode dependency: usable from the relay.
 */
import * as fs from 'fs'
import type { SessionInfo } from './protocol'
import {
  SESSION_INDEX_DEFAULT_MAX_ROWS, SESSION_INDEX_HARD_MAX_ROWS, SESSION_INDEX_TIMEOUT_MS, SESSION_TAG_MAX,
} from './constants'

/** Highest `PRAGMA user_version` this adapter understands (0 = unversioned database). */
export const SESSION_INDEX_MAX_SCHEMA_VERSION = 1

const REQUIRED_COLUMNS = ['id', 'started_at'] as const
const OPTIONAL_COLUMNS = ['label', 'cwd', 'workspace', 'last_activity_at', 'parent_id'] as const
const ID_MAX = 128
const MESSAGE_MAX = 300
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Minimal synchronous connection: what the adapter needs, nothing that writes. */
export interface IndexConnection {
  all(sql: string): Record<string, unknown>[]
  close(): void
}
export type IndexOpener = (path: string, options: { readOnly: true; timeoutMs: number }) => IndexConnection

export interface SessionIndexOptions {
  path: string
  /** Table holding the sessions (default 'sessions') */
  table?: string
  maxRows?: number
  timeoutMs?: number
}

export interface IndexedSession {
  id: string
  startTime: number
  lastActivityTime: number
  label?: string
  cwd?: string
  workspace?: string
  parentSessionId?: string
}

export type SessionIndexStatus = 'ok' | 'degraded' | 'unavailable'

export interface SessionIndexResult {
  status: SessionIndexStatus
  sessions: IndexedSession[]
  /** More rows exist than `maxRows` */
  truncated: boolean
  /** Rows ignored because their id or start time were unusable */
  skippedRows: number
  schemaVersion?: number
  /** Explanation to show when the status is not a plain 'ok' (or when rows were cut) */
  message?: string
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(CONTROL, '').trim().slice(0, max)
  return s || undefined
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return cleanText(raw, MESSAGE_MAX) ?? 'unknown error'
}

/** Milliseconds from a number or numeric string; values below 1e11 are taken as seconds. */
function toMillis(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

const READ_ONLY_SQL = /^\s*(SELECT\b|PRAGMA\s+(user_version|table_info)\b)/i

function guarded(conn: IndexConnection): IndexConnection {
  return {
    all(sql) {
      if (!READ_ONLY_SQL.test(sql) || sql.includes(';')) throw new Error('refused: the session index is read-only')
      return conn.all(sql)
    },
    close: () => conn.close(),
  }
}

/**
 * Opener backed by `node:sqlite` (Node 22.13+ / 24), or null when this Node does not ship it. Loaded
 * lazily so the adapter stays optional: nothing is required unless an index is configured.
 */
export function nodeSqliteOpener(): IndexOpener | null {
  let mod: { DatabaseSync?: new (p: string, o?: Record<string, unknown>) => {
    prepare(sql: string): { all(): unknown[] }
    close(): void
  } }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('node:sqlite')
  } catch {
    return null
  }
  const Database = mod.DatabaseSync
  if (!Database) return null
  return (p, { readOnly, timeoutMs }) => {
    const db = new Database(p, { readOnly, timeout: timeoutMs })
    return {
      all: sql => db.prepare(sql).all() as Record<string, unknown>[],
      close: () => db.close(),
    }
  }
}

function result(status: SessionIndexStatus, message: string, extra: Partial<SessionIndexResult> = {}): SessionIndexResult {
  return { status, sessions: [], truncated: false, skippedRows: 0, message, ...extra }
}

export function readSessionIndex(
  options: SessionIndexOptions,
  opener: IndexOpener | null | undefined = nodeSqliteOpener(),
): SessionIndexResult {
  const table = options.table ?? 'sessions'
  if (!TABLE_NAME.test(table)) return result('degraded', 'Session index: invalid table name in the configuration.')
  const maxRows = Number.isFinite(options.maxRows)
    ? Math.min(Math.max(Math.floor(options.maxRows as number), 1), SESSION_INDEX_HARD_MAX_ROWS)
    : SESSION_INDEX_DEFAULT_MAX_ROWS
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : SESSION_INDEX_TIMEOUT_MS

  if (!opener) {
    return result('unavailable', 'Session index: no SQLite driver in this Node version (node:sqlite needs Node 22.13 or later).')
  }
  let exists = false
  try { exists = fs.statSync(options.path).isFile() } catch { /* reported below */ }
  if (!exists) return result('unavailable', 'Session index: file not found.')

  let conn: IndexConnection | null = null
  try {
    conn = guarded(opener(options.path, { readOnly: true, timeoutMs }))

    const versionRow = conn.all('PRAGMA user_version')[0]
    const rawVersion = versionRow ? Number(versionRow.user_version) : 0
    const schemaVersion = Number.isFinite(rawVersion) && rawVersion >= 0 ? rawVersion : 0
    if (schemaVersion > SESSION_INDEX_MAX_SCHEMA_VERSION) {
      return result(
        'degraded',
        `Session index: schema version ${schemaVersion} is newer than the supported version ${SESSION_INDEX_MAX_SCHEMA_VERSION}; sessions are not read from it.`,
        { schemaVersion },
      )
    }

    const present = new Set(conn.all(`PRAGMA table_info(${table})`).map(r => (r && typeof r.name === 'string' ? r.name : '')))
    if (present.size === 0 || (present.size === 1 && present.has(''))) {
      return result('degraded', `Session index: table "${table}" not found.`, { schemaVersion })
    }
    const missing = REQUIRED_COLUMNS.filter(c => !present.has(c))
    if (missing.length > 0) {
      return result('degraded', `Session index: required column(s) missing from "${table}": ${missing.join(', ')}.`, { schemaVersion })
    }

    const columns = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS.filter(c => present.has(c))]
    const order = present.has('last_activity_at') ? 'last_activity_at' : 'started_at'
    const rows = conn.all(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order} DESC LIMIT ${maxRows + 1}`)

    const truncated = rows.length > maxRows
    const sessions: IndexedSession[] = []
    let skippedRows = 0
    for (const r of rows.slice(0, maxRows)) {
      const id = r ? cleanText(r.id, ID_MAX) : undefined
      const startTime = r ? toMillis(r.started_at) : undefined
      if (!id || startTime === undefined) { skippedRows++; continue }
      const label = cleanText(r.label, SESSION_TAG_MAX)
      const cwd = cleanText(r.cwd, SESSION_TAG_MAX)
      const workspace = cleanText(r.workspace, SESSION_TAG_MAX)
      const parent = cleanText(r.parent_id, ID_MAX)
      sessions.push({
        id, startTime, lastActivityTime: toMillis(r.last_activity_at) ?? startTime,
        ...(label ? { label } : {}),
        ...(cwd ? { cwd } : {}),
        ...(workspace ? { workspace } : {}),
        ...(parent && parent !== id ? { parentSessionId: parent } : {}),
      })
    }
    const notes: string[] = []
    if (truncated) notes.push(`only the ${maxRows} most recent sessions are read`)
    if (skippedRows > 0) notes.push(`${skippedRows} unreadable row(s) ignored`)
    return {
      status: 'ok', sessions, truncated, skippedRows, schemaVersion,
      ...(notes.length > 0 ? { message: `Session index: ${notes.join('; ')}.` } : {}),
    }
  } catch (e) {
    return result('degraded', `Session index: could not be read (${errorText(e)}).`)
  } finally {
    try { conn?.close() } catch { /* already closed */ }
  }
}

/** Session list entry of an indexed session. The index says nothing about liveness, so it is never 'active'. */
export function indexedToSessionInfo(s: IndexedSession): SessionInfo {
  return {
    id: s.id,
    label: s.label ?? s.id.slice(0, 8),
    status: 'completed',
    startTime: s.startTime,
    lastActivityTime: s.lastActivityTime,
    ...(s.workspace ? { workspace: s.workspace } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
  }
}
