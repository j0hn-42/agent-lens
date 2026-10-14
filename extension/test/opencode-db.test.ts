/**
 * OpenCode database reader (#346): path resolution from the spec rules, read-only opening, schema
 * check, and the cursor poll over `time_updated`. Real node:sqlite databases are built by the test
 * (schema reduced to the columns read); skipped where this Node has no node:sqlite. The schema and
 * the paths follow the source code of OpenCode v1.19.0, not a real database: none was available.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resolveOpenCodeDbPath, openOpenCodeDb, EMPTY_OPENCODE_CURSORS, OPENCODE_ROW_DATA_MAX, OPENCODE_POLL_BYTES_MAX,
  type OpenCodeCursors,
} from '../src/opencode-db'
import { nodeSqliteOpener, type IndexConnection, type IndexOpener } from '../src/session-index'

const HOME = '/home/u'
const resolve = (env: Record<string, string | undefined>, extra: { platform?: NodeJS.Platform } = {}) =>
  resolveOpenCodeDbPath({ env, homedir: HOME, platform: extra.platform ?? 'linux' })
const pathOf = (r: ReturnType<typeof resolve>) => (r.kind === 'file' ? r.path : `unavailable: ${r.message}`)

describe('resolveOpenCodeDbPath', () => {
  it('defaults to ~/.local/share/opencode/opencode.db', () => {
    assert.deepEqual(resolve({}), { kind: 'file', path: '/home/u/.local/share/opencode/opencode.db' })
  })
  it('uses XDG_DATA_HOME when set', () => {
    assert.deepEqual(resolve({ XDG_DATA_HOME: '/data' }), { kind: 'file', path: '/data/opencode/opencode.db' })
  })
  it('ignores an empty or relative XDG_DATA_HOME', () => {
    assert.equal(pathOf(resolve({ XDG_DATA_HOME: '' })), '/home/u/.local/share/opencode/opencode.db')
    assert.equal(pathOf(resolve({ XDG_DATA_HOME: 'rel' })), '/home/u/.local/share/opencode/opencode.db')
  })
  it('never guesses a channel file: opencode.db unless a path is given', () => {
    assert.equal(pathOf(resolve({ OPENCODE_DISABLE_CHANNEL_DB: '0' })), '/home/u/.local/share/opencode/opencode.db')
  })
  it('OPENCODE_DB: absolute path as is, relative path under <data>', () => {
    assert.deepEqual(resolve({ OPENCODE_DB: '/tmp/o.db' }), { kind: 'file', path: '/tmp/o.db' })
    assert.deepEqual(resolve({ OPENCODE_DB: 'x/o.db' }), { kind: 'file', path: '/home/u/.local/share/opencode/x/o.db' })
  })
  it('a relative OPENCODE_DB that leaves <data> is refused', () => {
    for (const v of ['../o.db', 'x/../../o.db', '..']) {
      assert.equal(resolve({ OPENCODE_DB: v }).kind, 'unavailable', v)
    }
    assert.equal(resolve({ OPENCODE_DB: 'x/../y.db' }).kind, 'file', 'staying inside <data> is fine')
  })
  it('an explicit dbPath setting wins over OPENCODE_DB and must be absolute', () => {
    assert.deepEqual(resolveOpenCodeDbPath({ env: { OPENCODE_DB: '/env.db' }, homedir: HOME, platform: 'linux', dbPath: '/set/opencode-local.db' }),
      { kind: 'file', path: '/set/opencode-local.db' })
    assert.equal(resolveOpenCodeDbPath({ env: {}, homedir: HOME, platform: 'linux', dbPath: 'rel.db' }).kind, 'unavailable')
    assert.equal(resolveOpenCodeDbPath({ env: {}, homedir: HOME, platform: 'linux', dbPath: '  ' }).kind, 'file', 'blank setting = unset')
  })
  it('OPENCODE_DB=:memory: has no file to read', () => {
    assert.equal(resolve({ OPENCODE_DB: ':memory:' }).kind, 'unavailable')
  })
  it('Windows is not guessed at (unverified), except an absolute OPENCODE_DB', () => {
    assert.equal(resolve({}, { platform: 'win32' }).kind, 'unavailable')
    assert.deepEqual(resolve({ OPENCODE_DB: 'C:\\o.db' }, { platform: 'win32' }), { kind: 'file', path: 'C:\\o.db' })
  })
})

const hasSqlite = nodeSqliteOpener() !== null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'))
let n = 0

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db
function sqlite(): DbCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
}
function makeDb(schema: 'full' | 'noPart' | 'noParentId' = 'full'): { file: string; db: Db } {
  const file = path.join(tmp, `o${n++}.db`)
  const db = new (sqlite())(file)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, ${schema === 'noParentId' ? '' : 'parent_id TEXT,'} directory TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  if (schema !== 'noPart') db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  return { file, db }
}
const sess = (id: string, t: number, archived?: number) =>
  `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES ('${id}', NULL, '/w', 'T', 1, ${t}, ${archived ?? 'NULL'})`
const msg = (id: string, t: number, data = '{"role":"user"}') => `INSERT INTO message VALUES ('${id}', 'ses_1', 1, ${t}, '${data}')`
const part = (id: string, t: number, data = '{"type":"text"}') => `INSERT INTO part VALUES ('${id}', 'm1', 'ses_1', 1, ${t}, '${data}')`

const COLS: Record<string, string[]> = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
}
/** Fake driver: valid schema, then `onSelect` answers every other query. */
function fakeOpener(onSelect: (sql: string) => Record<string, unknown>[]): IndexOpener {
  return () => {
    const conn: IndexConnection = {
      all(sql) {
        const t = /table_info\((\w+)\)/i.exec(sql)
        if (t) return COLS[t[1]].map(name => ({ name }))
        return onSelect(sql)
      },
      close() { /* nothing */ },
    }
    return conn
  }
}

describe('openOpenCodeDb', { skip: !hasSqlite }, () => {
  it('reports a missing file as unavailable, without creating it', () => {
    const file = path.join(tmp, 'absent.db')
    assert.equal(openOpenCodeDb(file).status, 'unavailable')
    assert.equal(fs.existsSync(file), false)
  })

  it('reports a missing driver as unavailable', () => {
    const { file } = makeDb()
    const r = openOpenCodeDb(file, null)
    assert.equal(r.status, 'unavailable')
    assert.match(r.status === 'unavailable' ? r.message : '', /node:sqlite/)
  })

  it('reports a missing table or required column as unavailable with the cause', () => {
    const a = openOpenCodeDb(makeDb('noPart').file)
    assert.equal(a.status, 'unavailable')
    assert.match(a.status === 'unavailable' ? a.message : '', /part/)
    const b = openOpenCodeDb(makeDb('noParentId').file)
    assert.equal(b.status, 'unavailable')
    assert.match(b.status === 'unavailable' ? b.message : '', /parent_id/)
  })

  it('reports a file that is not a database as unavailable, never throws', () => {
    const file = path.join(tmp, 'junk.db')
    fs.writeFileSync(file, 'not sqlite at all'.repeat(100))
    assert.equal(openOpenCodeDb(file).status, 'unavailable')
  })

  it('sends nothing but SELECT and PRAGMA table_info to the driver, which is opened read-only', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 1)); db.exec(part('p1', 1))
    const sqls: string[] = []
    let opts: unknown
    const real = nodeSqliteOpener()!
    const spy: IndexOpener = (f, o) => {
      opts = o
      const c = real(f, o)
      return { all: sql => { sqls.push(sql); return c.all(sql) }, close: () => c.close() }
    }
    const r = openOpenCodeDb(file, spy)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    r.db.poll(EMPTY_OPENCODE_CURSORS)
    r.db.close()
    assert.equal((opts as { readOnly: boolean }).readOnly, true)
    assert.ok(sqls.length >= 6)
    for (const sql of sqls) assert.match(sql, /^\s*(SELECT\b|PRAGMA table_info\()/)
    const raw = real(file, { readOnly: true, timeoutMs: 100 })
    assert.throws(() => raw.all("INSERT INTO session (id, time_created, time_updated) VALUES ('x', 1, 1)"), /readonly|read-only/i)
    raw.close()
  })

  it('reads rows of the three tables and normalises the fields', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 100)); db.exec(msg('m1', 110)); db.exec(part('p1', 120))
    db.close()
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const poll = r.db.poll(EMPTY_OPENCODE_CURSORS)
    r.db.close()
    assert.deepEqual(poll.sessions.map(s => [s.id, s.parent_id, s.directory, s.title, s.time_updated, s.time_archived]), [['ses_1', null, '/w', 'T', 100, null]])
    assert.deepEqual(poll.messages.map(m => [m.id, m.session_id, m.data]), [['m1', 'ses_1', '{"role":"user"}']])
    assert.deepEqual(poll.parts.map(p => [p.id, p.message_id, p.session_id]), [['p1', 'm1', 'ses_1']])
    assert.equal(poll.skippedRows, 0)
    assert.equal(poll.truncated, false)
    assert.equal(poll.error, undefined)
  })

  it('tolerates the optional columns (agent, time_archived) being absent', () => {
    const file = path.join(tmp, `min${n++}.db`)
    const db = new (sqlite())(file)
    db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    db.exec("INSERT INTO session VALUES ('ses_1', NULL, '/w', 'T', 1, 5)")
    db.close()
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    r.db.close()
    assert.equal(p.sessions.length, 1)
    assert.equal(p.sessions[0].time_archived, undefined, 'unknown, not "not archived"')
    assert.equal(p.sessions[0].agent, null)
  })

  it('polls on time_updated: an updated part is read again, an unchanged one is not', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 100)); db.exec(msg('m1', 110)); db.exec(part('p1', 120, '{"type":"tool","state":{"status":"running"}}'))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const first = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(first.parts.length, 1)
    const again = r.db.poll(first.cursors)
    assert.equal(again.parts.length + again.messages.length + again.sessions.length, 0)
    db.exec(`UPDATE part SET time_updated = 130, data = '{"type":"tool","state":{"status":"completed"}}' WHERE id = 'p1'`)
    const upd = r.db.poll(again.cursors)
    assert.deepEqual(upd.parts.map(p => p.id), ['p1'])
    assert.match(upd.parts[0].data, /completed/)
    r.db.close(); db.close()
  })

  it('does not duplicate or lose rows sharing the last timestamp', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 100)); db.exec(msg('m1', 100)); db.exec(part('p1', 200)); db.exec(part('p2', 200))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const first = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.deepEqual(first.parts.map(p => p.id), ['p1', 'p2'])
    db.exec(part('p3', 200))                  // same timestamp as the cursor, written after the poll
    const second = r.db.poll(first.cursors)
    assert.deepEqual(second.parts.map(p => p.id), ['p3'])
    assert.equal(r.db.poll(second.cursors).parts.length, 0)
    r.db.close(); db.close()
  })

  it('bounds a poll by the limit and keeps going from the cursor', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 1))
    for (let i = 0; i < 5; i++) db.exec(part(`p${i}`, 10 + Math.floor(i / 2)))   // 10,10,11,11,12
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const seen: string[] = []
    let cursors: OpenCodeCursors = EMPTY_OPENCODE_CURSORS
    let truncatedOnce = false
    for (let i = 0; i < 10; i++) {
      const p = r.db.poll(cursors, 2)
      truncatedOnce ||= p.truncated
      seen.push(...p.parts.map(x => x.id))
      cursors = p.cursors
      if (!p.truncated) break
    }
    assert.equal(truncatedOnce, true)
    assert.deepEqual([...new Set(seen)].sort(), ['p0', 'p1', 'p2', 'p3', 'p4'])
    assert.equal(seen.length, 5, 'no duplicate')
    r.db.close(); db.close()
  })

  it('reads parts before messages before sessions, so a part never arrives without its message', () => {
    const order: string[] = []
    const r = openOpenCodeDb(makeDb().file, fakeOpener(sql => {
      const m = /FROM (\w+)/i.exec(sql)
      if (m) order.push(m[1])
      return []
    }))
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    r.db.poll(EMPTY_OPENCODE_CURSORS)
    // Each table may be asked twice (size query, then rows): the order of tables is what counts
    assert.deepEqual(order.filter((t, i) => t !== order[i - 1]), ['part', 'message', 'session'])
  })

  it('holds the part cursor back while messages are truncated', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1))
    for (let i = 0; i < 3; i++) db.exec(`INSERT INTO message VALUES ('m${i}', 'ses_1', 1, ${10 + i}, '{}')`)
    db.exec(part('p1', 50))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS, 2)
    assert.equal(p.truncated, true)
    assert.deepEqual(p.cursors.part, EMPTY_OPENCODE_CURSORS.part)
    assert.deepEqual(p.parts, [], 'a part is not delivered before its message')
    r.db.close(); db.close()
  })

  it('does not deliver messages while sessions are truncated', () => {
    const { file, db } = makeDb()
    for (let i = 0; i < 3; i++) db.exec(sess(`ses_${i}`, 10 + i))
    db.exec(msg('m1', 20))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS, 2)
    assert.equal(p.truncated, true)
    assert.deepEqual(p.messages, [])
    assert.deepEqual(p.cursors.message, EMPTY_OPENCODE_CURSORS.message)
    r.db.close(); db.close()
  })

  it('is not blocked by rows with an unusable id at the cursor time', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 1))
    for (let i = 0; i < 10; i++) db.exec(`INSERT INTO part VALUES (NULL, 'm1', 'ses_1', 1, 50, '{}')`)
    db.exec(part('good', 50))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    assert.deepEqual(r.db.poll(EMPTY_OPENCODE_CURSORS, 2).parts.map(x => x.id), ['good'])
    r.db.close(); db.close()
  })

  it('treats a hostile cursor as the empty one and never puts it in the SQL', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 1)); db.exec(part('p1', 5))
    const sqls: string[] = []
    const real = nodeSqliteOpener()!
    const r = openOpenCodeDb(file, (f, o) => {
      const c = real(f, o)
      return { all: sql => { sqls.push(sql); return c.all(sql) }, close: () => c.close() }
    })
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const hostile = {
      part: { time: '0 UNION SELECT data FROM message' as unknown as number, seen: ['a'] },
      message: { time: NaN, seen: 'x' as unknown as string[] },
      session: { time: Infinity, seen: [1, null, 'ok'] as unknown as string[] },
    }
    const p = r.db.poll(hostile)
    assert.equal(p.error, undefined)
    assert.deepEqual(p.parts.map(x => x.id), ['p1'])
    assert.equal(p.sessions.length, 1)
    assert.ok(!sqls.some(s => /UNION|NaN|Infinity/.test(s)))
    r.db.close(); db.close()
  })

  it('skips a session whose parent_id is present but unusable instead of calling it a root', () => {
    const { file, db } = makeDb()
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('ses_1', '${'p'.repeat(300)}', '/w', 'T', 1, 5)`)
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.deepEqual(p.sessions, [])
    assert.equal(p.skippedRows, 1)
    r.db.close(); db.close()
  })

  it('does not read a text column larger than its bound', () => {
    const { file, db } = makeDb()
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('ses_1', NULL, '/w', '${'t'.repeat(100000)}', 1, 5)`)
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(p.sessions[0].title, null)
    r.db.close(); db.close()
  })

  it('ignores ids with control characters', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 1))
    db.exec(`INSERT INTO part VALUES ('a' || char(27) || 'b', 'm1', 'ses_1', 1, 9, '{}')`)
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.deepEqual(p.parts, [])
    assert.equal(p.skippedRows, 1)
    r.db.close(); db.close()
  })

  it('skips and counts rows with an unusable id or oversized data', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 100)); db.exec(msg('m1', 110))
    db.exec(`INSERT INTO part VALUES ('big', 'm1', 'ses_1', 1, 120, '${'x'.repeat(OPENCODE_ROW_DATA_MAX + 1)}')`)
    db.exec("INSERT INTO part VALUES ('nots', 'm1', 'ses_1', 1, NULL, '{}')")
    db.exec("INSERT INTO part VALUES (NULL, 'm1', 'ses_1', 1, 122, '{}')")
    db.exec(part('ok', 123))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.deepEqual(p.parts.map(x => x.id), ['ok'])
    assert.equal(p.skippedRows, 1, 'oversized data; rows without a usable id or integer time_updated are never selected')
    r.db.close(); db.close()
  })

  it('exposes time_archived of a session', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 100, 99))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    assert.equal(r.db.poll(EMPTY_OPENCODE_CURSORS).sessions[0].time_archived, 99)
    r.db.close(); db.close()
  })

  it('never throws on a failing query: poll returns an explicit error and keeps the cursors', () => {
    const r = openOpenCodeDb(makeDb().file, fakeOpener(() => { throw new Error('database is locked') }))
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS)
    assert.match(p.error ?? '', /locked/)
    assert.deepEqual(p.cursors, EMPTY_OPENCODE_CURSORS)
    assert.equal(p.parts.length + p.messages.length + p.sessions.length, 0)
  })
})

describe('OpenCodeDb.poll hostile values and budgets', { skip: !hasSqlite }, () => {
  const open = (file: string, clock?: () => number) => {
    const r = openOpenCodeDb(file, undefined, clock)
    assert.equal(r.status, 'ok')
    if (r.status !== 'ok') throw new Error('unreachable')
    return r.db
  }
  const HUGE = '1152921504606846976' // 2^60: above the safe integers, node:sqlite refuses to return it

  it('I1: an integer above 2^53 in time_updated or time_created skips the row, never fails the poll', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_ok', 100))
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('ses_hugeUpd', NULL, '/w', 'T', 1, ${HUGE})`)
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('ses_hugeCre', NULL, '/w', 'T', ${HUGE}, 101)`)
    db.exec(`INSERT INTO message VALUES ('mh', 'ses_1', ${HUGE}, 103, '{}')`)
    db.exec(msg('m1', 104))
    db.close()
    const odb = open(file)
    const p = odb.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(p.error, undefined)
    assert.deepEqual(p.sessions.map(s => s.id), ['ses_ok'])
    assert.deepEqual(p.messages.map(m => m.id), ['m1'])
    assert.equal(p.skippedRows, 2)
    const again = odb.poll(p.cursors)
    assert.equal(again.error, undefined)
    odb.close()
  })

  it('I2: a far-future time_updated does not move the cursor; a row within the margin is read once it settles', () => {
    const { file, db } = makeDb()
    let now = 1_000_000_000_000
    db.exec(sess('ses_past', now - 1000))
    db.exec(sess('ses_future', 9e15))
    db.exec(sess('ses_outside', now + 60_000))
    const odb = open(file, () => now)
    const p = odb.poll(EMPTY_OPENCODE_CURSORS, 500)
    assert.deepEqual(p.sessions.map(s => s.id), ['ses_past'])
    assert.equal(p.cursors.session.time, now - 1000)
    now += 120_000
    const q = odb.poll(p.cursors, 500)
    assert.deepEqual(q.sessions.map(s => s.id), ['ses_outside'])
    odb.close(); db.close()
  })

  it('I4: a poll stops at the byte budget, reports truncated, and the next poll delivers the rest once', () => {
    const { file, db } = makeDb()
    const big = 'x'.repeat(900 * 1024)
    const count = Math.ceil(OPENCODE_POLL_BYTES_MAX / (900 * 1024)) + 4
    db.exec(sess('ses_1', 1))
    for (let i = 0; i < count; i++) db.exec(msg(`m${String(i).padStart(3, '0')}`, 10 + i, big))
    const odb = open(file)
    let cursors: OpenCodeCursors = EMPTY_OPENCODE_CURSORS
    const ids: string[] = []
    let polls = 0
    let sawTruncated = false
    for (; polls < 10; polls++) {
      const p = odb.poll(cursors)
      assert.equal(p.error, undefined)
      cursors = p.cursors
      ids.push(...p.messages.map(m => m.id))
      sawTruncated ||= p.truncated
      if (!p.truncated) break
    }
    assert.equal(sawTruncated, true)
    assert.equal(polls >= 1, true)
    assert.deepEqual(ids, Array.from({ length: count }, (_, i) => `m${String(i).padStart(3, '0')}`))
    odb.close(); db.close()
  })

  it('I4: a single row larger than the budget still progresses', () => {
    const { file, db } = makeDb()
    db.exec(sess('ses_1', 1)); db.exec(msg('m1', 10, 'x'.repeat(900 * 1024))); db.exec(msg('m2', 11))
    const odb = open(file)
    const p = odb.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(p.messages.length >= 1, true)
    odb.close(); db.close()
  })

  it('I-B: dataVersion changes when another connection writes, and never throws', () => {
    const { file, db } = makeDb()
    const odb = open(file)
    const v1 = odb.dataVersion()
    assert.equal(typeof v1, 'number')
    assert.equal(odb.dataVersion(), v1)
    db.exec(sess('ses_1', 100))
    const v2 = odb.dataVersion()
    assert.equal(typeof v2, 'number')
    assert.notEqual(v2, v1)
    odb.close(); db.close()
    const failing = openOpenCodeDb(makeDb().file, fakeOpener(sql => { if (/data_version/i.test(sql)) throw new Error('boom'); return [] }))
    assert.equal(failing.status, 'ok'); if (failing.status !== 'ok') return
    assert.equal(failing.db.dataVersion(), undefined)
  })

  it('I-B: the guard accepts only SELECT, table_info and data_version', () => {
    const sqls: string[] = []
    const r = openOpenCodeDb(makeDb().file, fakeOpener(sql => { sqls.push(sql); return [] }))
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    r.db.dataVersion()
    assert.ok(sqls.some(q => /^PRAGMA data_version$/i.test(q)))
    const conn = (r.db as unknown as { conn: IndexConnection }).conn
    for (const bad of ['PRAGMA journal_mode = WAL', 'PRAGMA data_version = 5', 'PRAGMA data_version; DROP TABLE part', 'PRAGMA user_version', 'DELETE FROM part']) {
      assert.throws(() => conn.all(bad), /refused/, bad)
    }
  })

  it('I-B: the row query sorts on the raw columns, not on the aliased expressions', () => {
    const sqls: string[] = []
    const r = openOpenCodeDb(makeDb().file, fakeOpener(sql => { sqls.push(sql); return [] }))
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    r.db.poll(EMPTY_OPENCODE_CURSORS)
    const rowQueries = sqls.filter(q => /ORDER BY/i.test(q) && /CASE WHEN/i.test(q))
    assert.ok(rowQueries.length >= 3)
    for (const q of rowQueries) assert.match(q, /ORDER BY (part|message|session)\.time_updated ASC, \1\.id ASC/)
  })

  it('M5: a session id that is not ses_<base62> (a UUID of a live Claude session) makes the row unusable', () => {
    const { file, db } = makeDb()
    const UUID = '9c1d2e3f-0000-4000-8000-000000000001'
    db.exec(sess('ses_ok', 100))
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('${UUID}', NULL, '/w', 'T', 1, 101)`)
    db.exec(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('ses_child', '${UUID}', '/w', 'T', 1, 102)`)
    db.exec(`INSERT INTO message VALUES ('msg_1', '${UUID}', 1, 103, '{}')`)
    db.exec(`INSERT INTO message VALUES ('msg_2', 'ses_ok', 1, 104, '{}')`)
    db.exec(`INSERT INTO part VALUES ('prt_1', 'msg_2', '${UUID}', 1, 105, '{}')`)
    db.exec(`INSERT INTO part VALUES ('prt_2', 'msg_2', 'ses_ok', 1, 106, '{}')`)
    const odb = open(file)
    const p = odb.poll(EMPTY_OPENCODE_CURSORS)
    assert.equal(p.error, undefined)
    assert.deepEqual(p.sessions.map(x => [x.id, x.parent_id]), [['ses_ok', null]])
    assert.deepEqual(p.messages.map(x => x.id), ['msg_2'])
    assert.deepEqual(p.parts.map(x => x.id), ['prt_2'])
    assert.equal(p.skippedRows, 4)
    odb.close(); db.close()
  })
})
