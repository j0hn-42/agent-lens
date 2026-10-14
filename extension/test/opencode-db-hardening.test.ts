/**
 * OpenCode database reader (#346), second review: rows that must not stall or poison the cursor.
 * Real node:sqlite databases; the schema follows OpenCode v1.19.0 (no real database was available).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openOpenCodeDb, resolveOpenCodeDbPath, EMPTY_OPENCODE_CURSORS, type OpenCodeCursors, type OpenCodeDb } from '../src/opencode-db'
import { nodeSqliteOpener } from '../src/session-index'

const hasSqlite = nodeSqliteOpener() !== null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-hard-'))
let n = 0

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db
function makeDb(): { file: string; db: Db } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Ctor = (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
  const file = path.join(tmp, `h${n++}.db`)
  const db = new Ctor(file)
  db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)')
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.exec("INSERT INTO session (id, time_created, time_updated) VALUES ('s1', 1, 1)")
  db.exec("INSERT INTO message VALUES ('m1', 's1', 1, 1, '{}')")
  return { file, db }
}
const open = (file: string): OpenCodeDb => {
  const r = openOpenCodeDb(file)
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') throw new Error('unreachable')
  return r.db
}
const part = (id: string, t: number, data = '{}') => `INSERT INTO part VALUES ('${id}', 'm1', 's1', 1, ${t}, '${data}')`

/** Drain the parts table with a small limit; returns the ids delivered, in order. */
function drain(db: OpenCodeDb, limit: number, startAt: OpenCodeCursors = EMPTY_OPENCODE_CURSORS, maxPolls = 50): string[] {
  const ids: string[] = []
  let cursors = startAt
  for (let i = 0; i < maxPolls; i++) {
    const p = db.poll(cursors, limit)
    ids.push(...p.parts.map(x => x.id))
    cursors = p.cursors
    if (!p.truncated) break
  }
  return ids
}

describe('opencode-db hardening', { skip: !hasSqlite }, () => {
  it('is not stalled by ids with control characters (the cursor moves past them)', () => {
    const { file, db } = makeDb()
    for (let i = 0; i < 20; i++) db.exec(`INSERT INTO part VALUES ('a' || char(10) || '${i}', 'm1', 's1', 1, 5, '{}')`)
    db.exec(part('zgood', 5)); db.exec(part('later', 9))
    const r = open(file)
    assert.deepEqual(drain(r, 5), ['zgood', 'later'])
    r.close(); db.close()
  })

  it('reports truncated when invalid rows used up the SQL limit', () => {
    const { file, db } = makeDb()
    db.exec("INSERT INTO message VALUES ('m_bad' || char(7), 's1', 1, 2, '{}')")
    for (let i = 1; i <= 6; i++) db.exec(`INSERT INTO message VALUES ('m${i + 1}', 's1', 1, ${2 + i}, '{}')`)
    const r = open(file)
    const p = r.poll(EMPTY_OPENCODE_CURSORS, 5)
    assert.equal(p.truncated, true)
    r.close(); db.close()
  })

  it('a huge integer in a column does not make every poll fail', () => {
    const { file, db } = makeDb()
    db.exec(`INSERT INTO session (id, parent_id, time_created, time_updated, time_archived) VALUES ('big', NULL, 1152921504606846976, 5, 1152921504606846976)`)
    db.exec(`INSERT INTO session (id, parent_id, time_created, time_updated) VALUES ('huge', NULL, 1, 1152921504606846976)`)
    db.exec(part('p1', 7))
    const r = open(file)
    const p = r.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(p.error, undefined)
    assert.deepEqual(p.parts.map(x => x.id), ['p1'])
    const big = p.sessions.find(s => s.id === 'big')
    assert.equal(big, undefined, 'a session without a usable time_created is skipped')
    assert.ok(p.skippedRows >= 1)
    r.close(); db.close()
  })

  it('a row dated in the far future does not move the cursor into the future', () => {
    const { file, db } = makeDb()
    db.exec(part('now', 1000))
    db.exec(part('future', 9e15))
    const r = open(file)
    const p = r.poll(EMPTY_OPENCODE_CURSORS)
    assert.deepEqual(p.parts.map(x => x.id), ['now'])
    assert.ok(p.cursors.part.time <= 1000)
    db.exec(part('after', 2000))
    assert.deepEqual(r.poll(p.cursors).parts.map(x => x.id), ['after'])
    r.close(); db.close()
  })

  it('makes progress through more rows than it remembers at the same millisecond', () => {
    const { file, db } = makeDb()
    db.exec('BEGIN')
    for (let i = 0; i < 5200; i++) db.exec(`INSERT INTO part VALUES ('p' || printf('%05d', ${i}), 'm1', 's1', 1, 100, '{}')`)
    db.exec('COMMIT')
    db.exec(part('zlater', 200))
    const r = open(file)
    const ids = drain(r, 1000, EMPTY_OPENCODE_CURSORS, 30)
    assert.equal(ids.length, 5201)
    assert.equal(new Set(ids).size, 5201, 'each row once')
    assert.equal(ids[ids.length - 1], 'zlater')
    r.close(); db.close()
  })

  it('a part updated within the same millisecond as the last read is read again', () => {
    const { file, db } = makeDb()
    const t = Date.now()
    db.exec(part('p1', t, '{"state":"running"}'))
    const r = open(file)
    const first = r.poll(EMPTY_OPENCODE_CURSORS)
    assert.match(first.parts[0].data, /running/)
    db.exec(`UPDATE part SET data = '{"state":"completed"}' WHERE id = 'p1'`)       // same time_updated
    const second = r.poll(first.cursors)
    assert.deepEqual(second.parts.map(x => x.id), ['p1'], 'too recent to be marked as read')
    assert.match(second.parts[0].data, /completed/)
    r.close(); db.close()
  })
})

describe('resolveOpenCodeDbPath hardening', () => {
  const resolve = (env: Record<string, string | undefined>, platform: NodeJS.Platform = 'linux', dbPath?: string) =>
    resolveOpenCodeDbPath({ env, homedir: '/home/u', platform, dbPath })
  it('refuses an OPENCODE_DB that resolves to the data directory itself', () => {
    for (const v of ['.', 'x/..', './']) assert.equal(resolve({ OPENCODE_DB: v }).kind, 'unavailable', v)
  })
  it('refuses UNC and device paths on Windows (no network access)', () => {
    for (const v of ['\\\\host\\share\\o.db', '//host/share/o.db', '\\\\?\\C:\\o.db']) {
      assert.equal(resolve({}, 'win32', v).kind, 'unavailable', v)
      assert.equal(resolve({ OPENCODE_DB: v }, 'win32').kind, 'unavailable', v)
    }
    assert.deepEqual(resolve({}, 'win32', 'C:\\data\\o.db'), { kind: 'file', path: 'C:\\data\\o.db' })
  })
})
