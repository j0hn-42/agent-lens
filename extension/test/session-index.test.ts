/**
 * Optional, versioned, read-only session index adapter (#66): schema check, optional columns, row
 * bound, explicit degraded mode, and no crash when the format evolves. Fake driver for the logic,
 * the real node:sqlite driver (when this Node has it) for the read-only guarantee.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  readSessionIndex, indexedToSessionInfo, filterIndexedByWorkspace, nodeSqliteOpener, SESSION_INDEX_MAX_SCHEMA_VERSION,
  type IndexConnection, type IndexOpener,
} from '../src/session-index'

interface FakeDb { columns: string[]; rows: Record<string, unknown>[]; userVersion?: number }

function fakeOpener(db: FakeDb, log: { sql: string[]; opts: unknown[]; closed: number } = { sql: [], opts: [], closed: 0 }): IndexOpener {
  return (_p, opts) => {
    log.opts.push(opts)
    const conn: IndexConnection = {
      all(sql: string) {
        log.sql.push(sql)
        if (/PRAGMA user_version/i.test(sql)) return [{ user_version: db.userVersion ?? 0 }]
        if (/PRAGMA table_info/i.test(sql)) return db.columns.map(name => ({ name }))
        const m = /LIMIT (\d+)/i.exec(sql)
        return db.rows.slice(0, m ? Number(m[1]) : undefined)
      },
      close() { log.closed++ },
    }
    return conn
  }
}

// An existing file stands for the database; the fake opener never reads it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-'))
const dbFile = path.join(tmp, 'index.db')
fs.writeFileSync(dbFile, '')

const COLS = ['id', 'started_at']
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, started_at: 1_700_000_000_000, ...extra })

describe('readSessionIndex', () => {
  it('reads sessions with the required columns only and closes the connection', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [row('a'), row('b')] }, log))
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.sessions.map(s => s.id), ['a', 'b'])
    assert.equal(r.truncated, false)
    assert.equal(log.closed, 1)
  })

  it('opens read-only with the timeout and only ever sends SELECT / read PRAGMA statements', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    await readSessionIndex({ path: dbFile, timeoutMs: 250 }, fakeOpener({ columns: COLS, rows: [row('a')] }, log))
    assert.deepEqual(log.opts, [{ readOnly: true, timeoutMs: 250 }])
    assert.ok(log.sql.length >= 3)
    for (const sql of log.sql) assert.match(sql, /^\s*(SELECT|PRAGMA (user_version|table_info))/i, sql)
  })

  it('missing required column: degraded with the names, no rows, no crash', async () => {
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: ['id', 'label'], rows: [row('a')] }))
    assert.equal(r.status, 'degraded')
    assert.deepEqual(r.sessions, [])
    assert.match(r.message ?? '', /started_at/)
  })

  it('optional columns are used when present and tolerated when absent', async () => {
    const full = await readSessionIndex({ path: dbFile }, fakeOpener({
      columns: [...COLS, 'label', 'cwd', 'workspace', 'last_activity_at', 'parent_id', 'unknown_future_column'],
      rows: [row('c', { label: 'Fix', cwd: '/r/.claude/worktrees/x', workspace: 'r', last_activity_at: 1_700_000_100_000, parent_id: 'p' })],
    }))
    assert.deepEqual(full.sessions[0], {
      id: 'c', startTime: 1_700_000_000_000, lastActivityTime: 1_700_000_100_000,
      label: 'Fix', cwd: '/r/.claude/worktrees/x', workspace: 'r', parentSessionId: 'p',
    })
    const bare = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [row('c')] }))
    assert.equal(bare.status, 'ok')
    assert.equal(bare.sessions[0].lastActivityTime, bare.sessions[0].startTime)
    assert.equal(bare.sessions[0].label, undefined)
  })

  it('only selects columns that exist (an unknown column never reaches the query)', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [] }, log))
    const select = log.sql.find(q => /^\s*SELECT/i.test(q))!
    assert.doesNotMatch(select, /label|cwd|parent_id/)
  })

  it('bounds the rows and reports the truncation', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}`))
    const r = await readSessionIndex({ path: dbFile, maxRows: 4 }, fakeOpener({ columns: COLS, rows }))
    assert.equal(r.sessions.length, 4)
    assert.equal(r.truncated, true)
    assert.match(r.message ?? '', /4/)
    const exact = await readSessionIndex({ path: dbFile, maxRows: 10 }, fakeOpener({ columns: COLS, rows }))
    assert.equal(exact.truncated, false)
  })

  it('clamps an absurd maxRows', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    await readSessionIndex({ path: dbFile, maxRows: 1e12 }, fakeOpener({ columns: COLS, rows: [] }, log))
    const limit = Number(/LIMIT (\d+)/.exec(log.sql.find(q => /LIMIT/.test(q))!)![1])
    assert.ok(limit <= 5001)
  })

  it('malformed rows are skipped and counted, malformed optional fields are dropped', async () => {
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({
      columns: [...COLS, 'label', 'parent_id'],
      rows: [
        row('ok', { label: 42, parent_id: { x: 1 } }), { id: '', started_at: 1 }, { id: 7, started_at: 1 },
        { id: 'nots', started_at: 'abc' }, row('ctrl\u0000id\n'), null as unknown as Record<string, unknown>,
      ],
    }))
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.sessions.map(s => s.id), ['ok', 'ctrlid'])
    assert.equal(r.sessions[0].label, undefined)
    assert.equal(r.sessions[0].parentSessionId, undefined)
    assert.equal(r.skippedRows, 4)
  })

  it('accepts second-based timestamps', async () => {
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [{ id: 'a', started_at: 1_700_000_000 }] }))
    assert.equal(r.sessions[0].startTime, 1_700_000_000_000)
  })

  it('a newer schema version than supported falls back, explicitly, without reading rows', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [row('a')], userVersion: SESSION_INDEX_MAX_SCHEMA_VERSION + 1 }, log))
    assert.equal(r.status, 'degraded')
    assert.deepEqual(r.sessions, [])
    assert.equal(r.schemaVersion, SESSION_INDEX_MAX_SCHEMA_VERSION + 1)
    assert.match(r.message ?? '', /version/i)
    assert.ok(!log.sql.some(q => /^\s*SELECT/i.test(q)))
    assert.equal(log.closed, 1)
  })

  it('missing file or driver: unavailable with a message, and the opener is not called', async () => {
    let opened = 0
    const opener: IndexOpener = () => { opened++; throw new Error('should not open') }
    const missing = await readSessionIndex({ path: path.join(tmp, 'nope.db') }, opener)
    assert.equal(missing.status, 'unavailable')
    assert.match(missing.message ?? '', /not found/i)
    const none = await readSessionIndex({ path: dbFile }, null)
    assert.equal(none.status, 'unavailable')
    assert.match(none.message ?? '', /driver/i)
    assert.equal(opened, 0)
  })

  it('an opener or query failure (locked, corrupt) never throws and closes the connection', async () => {
    const boom: IndexOpener = () => { throw new Error('database is locked') }
    const r1 = await readSessionIndex({ path: dbFile }, boom)
    assert.equal(r1.status, 'degraded')
    assert.match(r1.message ?? '', /locked/)
    let closed = 0
    const failingQuery: IndexOpener = () => ({ all() { throw new Error('file is not a database') }, close() { closed++ } })
    const r2 = await readSessionIndex({ path: dbFile }, failingQuery)
    assert.equal(r2.status, 'degraded')
    assert.equal(closed, 1)
  })

  it('rejects an unsafe table name instead of building SQL from it', async () => {
    const log = { sql: [] as string[], opts: [] as unknown[], closed: 0 }
    const r = await readSessionIndex({ path: dbFile, table: 'sessions; DROP TABLE sessions' }, fakeOpener({ columns: COLS, rows: [] }, log))
    assert.equal(r.status, 'degraded')
    assert.equal(log.sql.length, 0)
  })

  it('an empty table with the right columns is ok, not degraded', async () => {
    const r = await readSessionIndex({ path: dbFile }, fakeOpener({ columns: COLS, rows: [] }))
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.sessions, [])
  })
})

describe('indexedToSessionInfo', () => {
  it('lists an indexed session as completed (the index proves nothing about liveness)', () => {
    const info = indexedToSessionInfo({ id: 'a', startTime: 1, lastActivityTime: 2, label: 'L', cwd: '/x', parentSessionId: 'p' })
    assert.deepEqual(info, { id: 'a', label: 'L', status: 'completed', indexedOnly: true, startTime: 1, lastActivityTime: 2, cwd: '/x', parentSessionId: 'p' })
    assert.equal(indexedToSessionInfo({ id: 'abcdefghijkl', startTime: 1, lastActivityTime: 1 }).label, 'abcdefgh')
  })
})

describe('node:sqlite driver', () => {
  const opener = nodeSqliteOpener()
  const skip = opener === null ? 'node:sqlite is not available in this Node' : false

  it('reads a real database and cannot write to it', { skip }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite')
    const file = path.join(tmp, 'real.db')
    const w = new DatabaseSync(file)
    w.exec('PRAGMA user_version = 1; CREATE TABLE sessions (id TEXT, started_at INTEGER, label TEXT, extra TEXT);')
    w.exec("INSERT INTO sessions VALUES ('a', 1700000000000, 'Alpha', 'x'), ('b', 1700000001000, NULL, 'y')")
    w.close()
    const r = await readSessionIndex({ path: file }, opener)
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.sessions.map(s => s.id).sort(), ['a', 'b'])
    assert.equal(r.sessions.find(s => s.id === 'a')?.label, 'Alpha')

    const conn = opener!(file, { readOnly: true, timeoutMs: 100 })
    assert.throws(() => conn.all("INSERT INTO sessions VALUES ('c', 1, 'z', 'z')"))
    conn.close()
    const after = await readSessionIndex({ path: file }, opener)
    assert.equal(after.sessions.length, 2, 'the database is unchanged')
  })

  it('a file that is not a database is degraded, not a crash', { skip }, async () => {
    const file = path.join(tmp, 'garbage.db')
    fs.writeFileSync(file, 'this is not sqlite '.repeat(50))
    const r = await readSessionIndex({ path: file }, opener)
    assert.equal(r.status, 'degraded')
  })

  it('a database without the table is degraded and names the table', { skip }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite')
    const file = path.join(tmp, 'other.db')
    const w = new DatabaseSync(file)
    w.exec('CREATE TABLE unrelated (x INTEGER)')
    w.close()
    const r = await readSessionIndex({ path: file }, opener)
    assert.equal(r.status, 'degraded')
    assert.match(r.message ?? '', /sessions/)
  })
})

describe('filterIndexedByWorkspace', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, startTime: 1, lastActivityTime: 2, ...extra })
  it('keeps rows whose workspace or cwd is the workspace or inside it, drops the others and the unlocated', () => {
    const kept = filterIndexedByWorkspace([
      row('ws', { workspace: '/p/app' }),
      row('cwd-inside', { cwd: '/p/app/packages/x/' }),
      row('sibling', { cwd: '/p/app-other' }),
      row('elsewhere', { workspace: '/q' }),
      row('unlocated'),
    ], '/p/app/')
    assert.deepEqual(kept.map(s => s.id), ['ws', 'cwd-inside'])
  })
})
