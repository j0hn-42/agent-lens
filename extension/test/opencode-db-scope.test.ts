/**
 * OpenCode database reader (#346), reads the watcher needs: recent root sessions, the tree of
 * sub-agent sessions of a root, and a poll restricted to some sessions. Real node:sqlite databases.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openOpenCodeDb, EMPTY_OPENCODE_CURSORS } from '../src/opencode-db'
import { nodeSqliteOpener } from '../src/session-index'

const hasSqlite = nodeSqliteOpener() !== null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-scope-'))
let n = 0

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db
function sqlite(): DbCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
}
function makeDb(withArchived = true): { file: string; db: Db } {
  const file = path.join(tmp, `s${n++}.db`)
  const db = new (sqlite())(file)
  db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER${withArchived ? ', time_archived INTEGER' : ''})`)
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  return { file, db }
}
const root = (id: string, t: number, archived?: number) =>
  `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated${archived === undefined ? '' : ', time_archived'}) VALUES ('${id}', NULL, '/w', 'T', 1, ${t}${archived === undefined ? '' : `, ${archived}`})`
const child = (id: string, parent: string, t: number) =>
  `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES ('${id}', '${parent}', '/w', 'C', 1, ${t})`

describe('openOpenCodeDb: roots, tree and scope', { skip: !hasSqlite }, () => {
  it('recentRoots: root sessions updated since the cutoff, newest first, archived excluded', () => {
    const { file, db } = makeDb()
    db.exec(root('old', 10)); db.exec(root('a', 100)); db.exec(root('b', 200)); db.exec(root('gone', 300, 301))
    db.exec(child('kid', 'a', 400))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const roots = r.db.recentRoots(50, 10)
    assert.deepEqual(roots.rows.map(s => s.id), ['b', 'a'])
    assert.equal(roots.error, undefined)
    assert.deepEqual(r.db.recentRoots(50, 1).rows.map(s => s.id), ['b'])
    r.db.close(); db.close()
  })

  it('recentRoots keeps a session when the time_archived column does not exist (unknown, not archived)', () => {
    const { file, db } = makeDb(false)
    db.exec(root('s1', 500))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    assert.deepEqual(r.db.recentRoots(1, 10).rows.map(s => s.id), ['s1'])
    r.db.close(); db.close()
  })

  it('readTree: the root and its descendants, parents before children', () => {
    const { file, db } = makeDb()
    db.exec(root('root', 1)); db.exec(child('c1', 'root', 2)); db.exec(child('c2', 'root', 3)); db.exec(child('g1', 'c1', 4))
    db.exec(root('other', 5)); db.exec(child('x', 'other', 6))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const ids = r.db.readTree('root').rows.map(s => s.id)
    assert.equal(ids[0], 'root')
    assert.deepEqual([...ids].sort(), ['c1', 'c2', 'g1', 'root'])
    assert.ok(ids.indexOf('c1') < ids.indexOf('g1'))
    r.db.close(); db.close()
  })

  it('readTree: an id with a quote cannot break out of the query', () => {
    const { file, db } = makeDb()
    db.exec(root("ro'ot", 1))
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    assert.deepEqual(r.db.readTree("ro'ot").rows.map(s => s.id), ["ro'ot"])
    assert.equal(r.db.readTree("x' OR '1'='1").rows.length, 0)
    r.db.close(); db.close()
  })

  it('poll with a scope reads only the rows of those sessions', () => {
    const { file, db } = makeDb()
    db.exec(root('s1', 1)); db.exec(root('s2', 2))
    db.exec("INSERT INTO message VALUES ('m1', 's1', 1, 10, '{}')")
    db.exec("INSERT INTO message VALUES ('m2', 's2', 1, 11, '{}')")
    db.exec("INSERT INTO part VALUES ('p1', 'm1', 's1', 1, 12, '{}')")
    db.exec("INSERT INTO part VALUES ('p2', 'm2', 's2', 1, 13, '{}')")
    const r = openOpenCodeDb(file)
    assert.equal(r.status, 'ok'); if (r.status !== 'ok') return
    const p = r.db.poll(EMPTY_OPENCODE_CURSORS, 100, ['s1'])
    assert.deepEqual(p.sessions.map(s => s.id), ['s1'])
    assert.deepEqual(p.messages.map(m => m.id), ['m1'])
    assert.deepEqual(p.parts.map(x => x.id), ['p1'])
    const none = r.db.poll(EMPTY_OPENCODE_CURSORS, 100, [])
    assert.equal(none.parts.length + none.messages.length + none.sessions.length, 0, 'empty scope reads nothing')
    r.db.close(); db.close()
  })
})
