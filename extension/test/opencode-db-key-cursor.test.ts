/**
 * OpenCode reader, cursor by primary key (#420 points 1 and 2).
 *
 * `message` and `part` have no index on `time_updated` in OpenCode v1.19.0: a cursor on
 * `(time_updated, id)` makes SQLite read and sort the whole table at every poll (537 ms on a 1.7 GB
 * database). Their ids are ascending (creation time first), so the reader follows the primary key and
 * reads again a bounded window of recent rows for the parts updated in place. These tests count the
 * rows the reader asks SQLite for and check the query plans; they do not measure time.
 * Real node:sqlite databases, built by the test (a reduced size with OpenCode's 4 parts per message).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  openOpenCodeDb, OPENCODE_OPEN_ROWS, OPENCODE_SWEEP_ROWS, OPENCODE_WINDOW_MS, OPENCODE_WINDOW_ROWS,
  type OpenCodeCursors, type OpenCodeDb, type OpenCodePoll,
} from '../src/opencode-db'
import { nodeSqliteOpener, type IndexOpener } from '../src/session-index'
import { OpenCodeFixture, cleanupFixtures, closeLater, openCodeId, sqliteAvailable, tmpDir } from './helpers/opencode-fixture'

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)
const tmp = tmpDir('opencode-key-')
after(cleanupFixtures)
let n = 0

type Plain = { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void }
const DatabaseSync = (): new (p: string, o?: Record<string, unknown>) => Plain =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:sqlite') as { DatabaseSync: new (p: string, o?: Record<string, unknown>) => Plain }).DatabaseSync

/** Every statement the reader sends, with the rows SQLite returned for it. */
interface Recorded { sql: string; rows: Record<string, unknown>[] }

function recordingOpener(log: Recorded[]): IndexOpener {
  const base = nodeSqliteOpener()
  if (!base) throw new Error('no node:sqlite')
  return (file, opts) => {
    const conn = base(file, opts)
    return {
      all(sql) { const rows = conn.all(sql); log.push({ sql, rows }); return rows },
      close: () => conn.close(),
    }
  }
}

function newDb(): OpenCodeFixture {
  const fx = new OpenCodeFixture(path.join(tmp, `k${n++}.db`))
  fx.session('ses_1', { created: NOW - 86_400_000, updated: NOW - 86_400_000 })
  return fx
}

function open(file: string, log: Recorded[] = [], clock: () => number = () => NOW): OpenCodeDb {
  const r = openOpenCodeDb(file, recordingOpener(log), clock)
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') throw new Error('unreachable')
  return closeLater(r.db)
}

const keyCursors = (since: number): OpenCodeCursors => ({
  session: { time: 0 },
  message: { time: since, mode: 'key' },
  part: { time: since, mode: 'key' },
})

const DATA = JSON.stringify({ type: 'text', text: 'x'.repeat(200) })

/**
 * `messages` messages of 4 parts each, one per millisecond from `start`, with OpenCode ids. Returns
 * the next free millisecond.
 */
function fill(fx: OpenCodeFixture, start: number, messages: number, counter = { c: 0 }): number {
  let t = start
  fx.batch(() => {
    for (let m = 0; m < messages; m++, t++) {
      const mid = openCodeId('msg', t, ++counter.c)
      fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{"role":"user"}')`)
      for (let p = 0; p < 4; p++) {
        fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, ++counter.c)}', '${mid}', 'ses_1', ${t}, ${t}, '${DATA}')`)
      }
    }
  })
  return t
}

/** Polls until nothing more is waiting; returns every poll. */
function drain(db: OpenCodeDb, cursors: OpenCodeCursors, limit = 500, max = 200): { polls: OpenCodePoll[]; cursors: OpenCodeCursors } {
  const polls: OpenCodePoll[] = []
  for (let i = 0; i < max; i++) {
    const p = db.poll(cursors, limit)
    assert.equal(p.error, undefined)
    polls.push(p)
    cursors = p.cursors
    if (!p.truncated) break
  }
  return { polls, cursors }
}

const touches = (sql: string, table: string): boolean => new RegExp(`\\bFROM ${table}\\b`).test(sql)

/** Bytes this process read through read(2)/pread(2) so far (`rchar` of /proc/self/io); undefined where the kernel does not say. */
function bytesRead(): number | undefined {
  try {
    const m = /^rchar: (\d+)$/m.exec(fs.readFileSync('/proc/self/io', 'utf8'))
    return m ? Number(m[1]) : undefined
  } catch { return undefined }
}

describe('opencode-db: cursor by primary key (#420)', { skip: !sqliteAvailable() }, () => {
  it('bench: a poll after new rows reads only the new rows with their data, through the primary key, whatever the table size', () => {
    const counts: number[] = []
    for (const messages of [2000, 4000]) {
      const fx = newDb()
      // History: one day old, outside the window of recent rows
      fill(fx, NOW - 86_400_000, messages)
      const log: Recorded[] = []
      const db = open(fx.file, log)
      const boot = drain(db, keyCursors(NOW - 600_000))
      assert.deepEqual(boot.polls.flatMap(p => p.parts), [], 'history older than the activity window is not replayed')

      // OpenCode writes 5 new messages (20 parts)
      fill(fx, NOW - 3000, 5, { c: 900_000 })
      log.length = 0
      const p = db.poll(boot.cursors)
      assert.equal(p.error, undefined)
      assert.equal(p.parts.length, 20)
      assert.equal(p.messages.length, 5)

      const keyed = log.filter(r => touches(r.sql, 'part') || touches(r.sql, 'message'))
      const withData = keyed.reduce((s, r) => s + r.rows.filter(row => 'data' in row).length, 0)
      assert.equal(withData, 25, 'the data of the rows already read is never loaded again')
      const total = keyed.reduce((s, r) => s + r.rows.length, 0)
      assert.ok(total <= 2 * (25 + OPENCODE_SWEEP_ROWS) + 25, `rows asked for: ${total}`)
      counts.push(total)

      // No full scan of message or part: each query walks the primary key index
      const plain = closeLater(new (DatabaseSync())(fx.file, { readOnly: true }))
      for (const r of keyed) {
        const plan = plain.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all().map(x => String(x.detail))
        for (const d of plan.filter(x => /\b(part|message)\b/.test(x))) {
          assert.match(d, /^SEARCH (part|message) USING (COVERING )?INDEX sqlite_autoindex_(part|message)_1 \(id[>=<]/, `${d}\n${r.sql}`)
        }
        assert.ok(!plan.some(d => /TEMP B-TREE/.test(d)), `no sort of the table: ${plan.join(' | ')}`)
      }
      db.close()
      fx.close()
    }
    assert.equal(counts[0], counts[1], 'the rows asked for do not grow with the table')
  })

  it('bench in bytes: with a FULL window of recent rows with large data, a poll does not read that data', (tc) => {
    // 2,000 recent parts of 16 KB (32 MB of data), already seen: the window is full and nothing changed
    const fx = newDb()
    const big = JSON.stringify({ type: 'text', text: 'y'.repeat(16_000) })
    const windowBytes = OPENCODE_WINDOW_ROWS * big.length
    const start = NOW - 300_000
    let c = 0
    fx.batch(() => {
      for (let m = 0; m < OPENCODE_WINDOW_ROWS / 4; m++) {
        const t = start + m
        const mid = openCodeId('msg', t, ++c)
        fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{"role":"user"}')`)
        for (let p = 0; p < 4; p++) fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, ++c)}', '${mid}', 'ses_1', ${t}, ${t}, '${big}')`)
      }
    })
    const log: Recorded[] = []
    const db = open(fx.file, log)
    // Seen before the reader started: in the window (younger than OPENCODE_WINDOW_MS), not to deliver
    const boot = drain(db, keyCursors(NOW - 60_000))
    assert.equal(boot.cursors.part.key?.recent.length, OPENCODE_WINDOW_ROWS, 'the window is full')

    // One new small part: the poll reads the full window again (light), the sweep and one row of data
    const t = NOW - 2000
    const mid = openCodeId('msg', t, ++c)
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{"role":"user"}')`)
    fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, ++c)}', '${mid}', 'ses_1', ${t}, ${t}, '${DATA}')`)
    log.length = 0
    const before = bytesRead()
    const p = db.poll(boot.cursors)
    const read = bytesRead() === undefined || before === undefined ? undefined : bytesRead()! - before
    assert.equal(p.error, undefined)
    assert.equal(p.parts.length, 1)

    // Measured in bytes where the kernel reports them (Linux: /proc/self/io, `rchar` counts every read of
    // the file, cached or not; SQLite does not map the file by default)
    tc.diagnostic(`bytes read by the poll: ${read ?? 'not reported'} (window data: ${windowBytes})`)
    if (read !== undefined) {
      assert.ok(read < windowBytes / 2, `${read} bytes read for a window holding ${windowBytes} bytes of data`)
    }
    // Everywhere: the light reads ask SQLite only for the size in bytes of `data` (octet_length does not
    // load the content; length() counts characters, so it reads all of it, overflow pages included)
    const light = log.filter(r => (touches(r.sql, 'part') || touches(r.sql, 'message')) && !r.rows.some(row => 'data' in row))
    assert.ok(light.length > 0)
    for (const r of light) assert.doesNotMatch(r.sql, /(?<!octet_)length\(data\)/, r.sql)
    db.close(); fx.close()
  })

  it('more than 5 500 rows in the same millisecond are all read, each once, and the cursor moves past them', () => {
    const fx = newDb()
    const t = NOW - 60_000
    const ids: string[] = []
    const db = open(fx.file)
    // The reader is running (first poll done) when the rows arrive, as for an import while OpenCode runs
    const start = db.poll(keyCursors(NOW - 600_000)).cursors
    fx.batch(() => {
      fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
      for (let i = 1; i <= 6000; i++) {
        const id = openCodeId('prt', t, i)
        ids.push(id)
        fx.raw(`INSERT INTO part VALUES ('${id}', '${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
      }
    })
    const { polls, cursors } = drain(db, start, 500, 40)
    const seen = polls.flatMap(p => p.parts.map(x => x.id))
    assert.equal(seen.length, 6000)
    assert.equal(new Set(seen).size, 6000, 'each row once')
    assert.equal(polls[polls.length - 1].truncated, false, 'the reader is not stuck on the millisecond')
    const later = openCodeId('prt', t + 5, 7000)
    fx.raw(`INSERT INTO part VALUES ('${later}', '${openCodeId('msg', t, 0)}', 'ses_1', ${t + 5}, ${t + 5}, '{}')`)
    assert.deepEqual(db.poll(cursors).parts.map(x => x.id), [later])
    db.close(); fx.close()
  })

  it('limit: at the first poll, rows of the activity window below the window are not replayed, and are counted', () => {
    const fx = newDb()
    const t = NOW - 60_000
    const extra = 300
    fx.batch(() => {
      fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
      for (let i = 1; i <= OPENCODE_WINDOW_ROWS + extra; i++) {
        fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, i)}', '${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
      }
    })
    const db = open(fx.file)
    const { polls } = drain(db, keyCursors(NOW - 600_000), 1000)
    assert.equal(polls.flatMap(p => p.parts).length, OPENCODE_WINDOW_ROWS, 'the window, not more')
    const lost = polls.flatMap(p => p.lostPassed).reduce((s, l) => s + l.count, 0)
    assert.equal(lost, extra, 'each row not replayed is counted once')
    db.close(); fx.close()
  })

  it('ids that wrapped (48 bits of time, last wrap on 2026-08-14) do not hide the new rows behind the old ones', () => {
    const fx = newDb()
    // History from July 2026: its ids sort above every id written since the wrap
    const july = Date.UTC(2026, 6, 1)
    fill(fx, july, 3000)
    assert.ok(openCodeId('prt', july, 1) > openCodeId('prt', NOW, 1), 'the fixture reproduces the wrap')
    const recentMsg = openCodeId('msg', NOW - 120_000, 1)
    fx.raw(`INSERT INTO message VALUES ('${recentMsg}', 'ses_1', ${NOW - 120_000}, ${NOW - 120_000}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', NOW - 120_000, 2)}', '${recentMsg}', 'ses_1', ${NOW - 120_000}, ${NOW - 120_000}, '{}')`)
    const log: Recorded[] = []
    const db = open(fx.file, log)
    const boot = drain(db, keyCursors(NOW - 600_000))
    assert.deepEqual(boot.polls.flatMap(p => p.parts.map(x => x.id)), [openCodeId('prt', NOW - 120_000, 2)], 'the recent row is replayed')
    assert.deepEqual(boot.polls.flatMap(p => p.lostPassed), [])
    const t = NOW - 2000
    const mid = openCodeId('msg', t, 10)
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, 11)}', '${mid}', 'ses_1', ${t}, ${t}, '{}')`)
    log.length = 0
    const p = db.poll(boot.cursors)
    assert.deepEqual(p.parts.map(x => x.id), [openCodeId('prt', t, 11)])
    assert.deepEqual(p.messages.map(x => x.id), [mid])
    const withData = log.reduce((s, r) => s + r.rows.filter(row => 'data' in row).length, 0)
    assert.equal(withData, 2, 'the history above the new ids is not loaded')
    db.close(); fx.close()
  })

  it('ids that wrap while the reader runs: the new rows are read, the old window is not taken for losses', () => {
    const wrap = 27 * 2 ** 36 // 2028-10-17T20:04:31.872Z
    const clock = { t: wrap - 120_000 }
    const fx = newDb()
    fill(fx, wrap - 200_000, 50)
    const db = open(fx.file, [], () => clock.t)
    const boot = drain(db, keyCursors(clock.t - 600_000))
    assert.equal(boot.polls.flatMap(p => p.parts).length, 200)
    clock.t = wrap + 60_000
    const t = wrap + 30_000
    const mid = openCodeId('msg', t, 1)
    const pid = openCodeId('prt', t, 2)
    assert.ok(pid < openCodeId('prt', wrap - 200_000, 1), 'the new id sorts below the old ones')
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('${pid}', '${mid}', 'ses_1', ${t}, ${t}, '{}')`)
    const { polls } = drain(db, boot.cursors)
    assert.deepEqual(polls.flatMap(p => p.parts.map(x => x.id)), [pid])
    assert.deepEqual(polls.flatMap(p => p.messages.map(x => x.id)), [mid])
    assert.deepEqual(polls.flatMap(p => p.lostPassed), [], 'the rows of the old window did not change')
    db.close(); fx.close()
  })

  it('a part updated in place inside the window is read again once', () => {
    const fx = newDb()
    const t = NOW - 60_000
    const mid = openCodeId('msg', t, 1)
    const pid = openCodeId('prt', t, 2)
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('${pid}', '${mid}', 'ses_1', ${t}, ${t}, '{"state":"running"}')`)
    const db = open(fx.file)
    const first = db.poll(keyCursors(NOW - 600_000))
    assert.deepEqual(first.parts.map(x => x.data), ['{"state":"running"}'])
    assert.deepEqual(db.poll(first.cursors).parts, [], 'unchanged: not read again')
    fx.raw(`UPDATE part SET data = '{"state":"completed"}', time_updated = ${t + 30_000} WHERE id = '${pid}'`)
    const second = db.poll(first.cursors)
    assert.deepEqual(second.parts.map(x => x.data), ['{"state":"completed"}'])
    assert.deepEqual(second.lostPassed, [])
    assert.deepEqual(db.poll(second.cursors).parts, [], 'read once')
    db.close(); fx.close()
  })

  it('a part updated in place outside the window is not read again, and the loss is counted once for its session', () => {
    const fx = newDb()
    const old = NOW - OPENCODE_WINDOW_MS - 3_600_000
    const mid = openCodeId('msg', old, 1)
    const pid = openCodeId('prt', old, 2)
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${old}, ${old}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('${pid}', '${mid}', 'ses_1', ${old}, ${old}, '{"state":"running"}')`)
    const db = open(fx.file)
    const boot = db.poll(keyCursors(NOW - 600_000))
    assert.deepEqual(boot.parts, [])
    assert.deepEqual(boot.lostPassed, [])
    fx.raw(`UPDATE part SET data = '{"state":"completed"}', time_updated = ${NOW - 1000} WHERE id = '${pid}'`)
    const p = db.poll(boot.cursors)
    assert.deepEqual(p.parts, [], 'outside the window: not read (the documented limit)')
    assert.deepEqual(p.lostPassed, [{ sessionId: 'ses_1', count: 1 }], 'never silent')
    const again = db.poll(p.cursors)
    assert.deepEqual(again.lostPassed, [], 'counted once')
    db.close(); fx.close()
  })

  it('a tool part delivered while running is still read after it left the window: its completion is delivered, not lost', () => {
    const fx = newDb()
    const clock = { t: NOW }
    const t = NOW - 60_000
    const mid = openCodeId('msg', t, 1)
    const pid = openCodeId('prt', t, 2)
    const running = JSON.stringify({ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running' } })
    const done = JSON.stringify({ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed' } })
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{"role":"user"}')`)
    fx.raw(`INSERT INTO part VALUES ('${pid}', '${mid}', 'ses_1', ${t}, ${t}, '${running}')`)
    const db = open(fx.file, [], () => clock.t)
    const first = db.poll(keyCursors(NOW - 600_000))
    assert.deepEqual(first.parts.map(x => x.data), [running])
    // 20 minutes of silence, then newer rows: the running part leaves the window
    clock.t = NOW + 20 * 60_000
    const t2 = clock.t - 5000
    const mid2 = openCodeId('msg', t2, 3)
    fx.raw(`INSERT INTO message VALUES ('${mid2}', 'ses_1', ${t2}, ${t2}, '{"role":"user"}')`)
    const quiet = db.poll(first.cursors)
    assert.ok(quiet.cursors.part.key!.below >= pid, 'the part left the window')
    assert.deepEqual(quiet.lostPassed, [])
    // The tool finishes
    fx.raw(`UPDATE part SET data = '${done}', time_updated = ${clock.t - 1000} WHERE id = '${pid}'`)
    const p = db.poll(quiet.cursors)
    assert.deepEqual(p.parts.map(x => x.data), [done], 'the completion is read')
    assert.deepEqual(p.lostPassed, [], 'and not counted as a loss')
    const again = db.poll(p.cursors)
    assert.deepEqual(again.parts, [], 'read once')
    assert.deepEqual(again.lostPassed, [])
    // Finished: no longer followed. A later change is a loss, counted (the documented limit)
    fx.raw(`UPDATE part SET time_updated = ${clock.t - 500} WHERE id = '${pid}'`)
    clock.t += 1000
    const after = db.poll(again.cursors)
    assert.deepEqual(after.parts, [])
    assert.deepEqual(after.lostPassed, [{ sessionId: 'ses_1', count: 1 }])
    db.close(); fx.close()
  })

  it('an assistant message delivered before it completed is still read after it left the window', () => {
    const fx = newDb()
    const clock = { t: NOW }
    const t = NOW - 60_000
    const mid = openCodeId('msg', t, 1)
    fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{"role":"assistant","time":{"created":${t}}}')`)
    const db = open(fx.file, [], () => clock.t)
    const first = db.poll(keyCursors(NOW - 600_000))
    assert.equal(first.messages.length, 1)
    clock.t = NOW + 20 * 60_000
    const t2 = clock.t - 5000
    fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', t2, 3)}', 'ses_1', ${t2}, ${t2}, '{"role":"user"}')`)
    const quiet = db.poll(first.cursors)
    assert.ok(quiet.cursors.message.key!.below >= mid, 'the message left the window')
    const completed = `{"role":"assistant","time":{"created":${t},"completed":${clock.t - 1000}}}`
    fx.raw(`UPDATE message SET data = '${completed}', time_updated = ${clock.t - 1000} WHERE id = '${mid}'`)
    const p = db.poll(quiet.cursors)
    assert.deepEqual(p.messages.map(x => x.data), [completed])
    assert.deepEqual(p.lostPassed, [])
    db.close(); fx.close()
  })

  it('the rows still followed after they left the window are bounded, and a hostile list is data', () => {
    const fx = newDb()
    fill(fx, NOW - 60_000, 2)
    const db = open(fx.file)
    const huge = Array.from({ length: 50_000 }, (_, i) => [`prt_${String(i).padStart(26, '0')}`, 1])
    const hostile = {
      session: { time: 0 },
      message: { time: 0, mode: 'key', key: { below: '', top: '', recent: [], floor: 0, sweep: '', stray: [], open: [["'; DROP", 'x'], 5, null] } },
      part: { time: 0, mode: 'key', key: { below: 'prt_z', top: 'prt_z', recent: [], floor: 0, sweep: '', stray: [], open: huge } },
    } as unknown as OpenCodeCursors
    const p = db.poll(hostile)
    assert.equal(p.error, undefined)
    assert.ok((p.cursors.part.key?.open?.length ?? 0) <= OPENCODE_OPEN_ROWS)
    assert.deepEqual(p.cursors.message.key?.open ?? [], [])
    db.close(); fx.close()
  })

  it('a page of rows still settling is not reported as more rows waiting, and every row comes once settled', () => {
    const fx = newDb()
    const clock = { t: NOW }
    const db = open(fx.file, [], () => clock.t)
    const start = db.poll(keyCursors(NOW - 600_000)).cursors
    const t = NOW + 1000
    fx.batch(() => {
      fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
      for (let i = 1; i <= 20; i++) fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, i)}', '${openCodeId('msg', t, 0)}', 'ses_1', ${t}, ${t}, '{}')`)
    })
    clock.t = t + 50
    const first = db.poll(start, 5)
    assert.equal(first.settling, true)
    const again = db.poll(first.cursors, 5)
    assert.equal(again.truncated, false, 'giving the same settling rows again is not progress')
    clock.t = t + 10_000
    const { polls } = drain(db, again.cursors, 5)
    const ids = new Set([...first.parts, ...again.parts, ...polls.flatMap(p => p.parts)].map(x => x.id))
    assert.equal(ids.size, 20)
    db.close(); fx.close()
  })

  it('a row delivered less than 500 ms ago is not pushed out of the window: a change in the same millisecond is still read', () => {
    const fx = newDb()
    const clock = { t: NOW }
    // A full window of settled rows
    fill(fx, NOW - 120_000, OPENCODE_WINDOW_ROWS / 4)
    const db = open(fx.file, [], () => clock.t)
    const boot = drain(db, keyCursors(NOW - 600_000), 5000)
    // More than a window of new rows in one millisecond, delivered while they still settle
    const t = NOW + 1000
    clock.t = t + 10
    const mid = openCodeId('msg', t, 1)
    const first = openCodeId('prt', t, 2)
    fx.batch(() => {
      fx.raw(`INSERT INTO message VALUES ('${mid}', 'ses_1', ${t}, ${t}, '{}')`)
      for (let i = 2; i <= OPENCODE_WINDOW_ROWS + 100; i++) fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, i)}', '${mid}', 'ses_1', ${t}, ${t}, '{"v":1}')`)
    })
    const p = db.poll(boot.cursors, 5000)
    assert.ok(p.parts.some(x => x.id === first))
    // The lowest of them changes within the same millisecond
    fx.raw(`UPDATE part SET data = '{"v":2}' WHERE id = '${first}'`)
    clock.t = t + 2000
    const next = drain(db, p.cursors, 5000)
    const again = next.polls.flatMap(x => x.parts).filter(x => x.id === first)
    assert.deepEqual(again.map(x => x.data), ['{"v":2}'], 'given again once settled, with its last content')
    assert.deepEqual(next.polls.flatMap(x => x.lostPassed), [])
    db.close(); fx.close()
  })

  it('ids are ordered like SQLite orders them (UTF-8 bytes), not by UTF-16 units: no unchanged row is taken for a loss', () => {
    // Outside OpenCode's format (a hostile or foreign database): an astral character sorts below U+E000 in
    // UTF-16 units but above it in UTF-8 bytes, the order of SQLite
    const fx = newDb()
    const old = NOW - 20 * 60_000
    const t = NOW - 60_000
    fx.raw(`INSERT INTO message VALUES ('msg_A', 'ses_1', ${old}, ${old}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('prt_A', 'msg_A', 'ses_1', ${old}, ${old}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('prt_\u{1F600}', 'msg_A', 'ses_1', ${old}, ${old}, '{}')`)
    fx.raw(`INSERT INTO part VALUES ('prt_\uE000', 'msg_A', 'ses_1', ${t}, ${t}, '{}')`)
    const db = open(fx.file)
    const first = db.poll(keyCursors(NOW - 600_000))
    assert.deepEqual(first.parts.map(x => x.id), ['prt_\uE000'])
    assert.deepEqual(first.lostPassed, [], 'the row delivered is not also counted as lost')
    let cursors = first.cursors
    for (let i = 0; i < 3; i++) {
      const p = db.poll(cursors)
      assert.deepEqual(p.parts, [], 'nothing changed')
      assert.deepEqual(p.lostPassed, [], 'nothing changed: no loss')
      cursors = p.cursors
    }
    db.close(); fx.close()
  })

  it('the window is bounded in rows', () => {
    const fx = newDb()
    fill(fx, NOW - 120_000, Math.ceil((OPENCODE_WINDOW_ROWS + 400) / 4))
    const db = open(fx.file)
    const { cursors } = drain(db, keyCursors(NOW - 600_000), 1000)
    const key = cursors.part.key
    assert.ok(key, 'the part cursor follows the primary key')
    assert.ok(key.recent.length <= OPENCODE_WINDOW_ROWS, `${key.recent.length} rows in the window`)
    db.close(); fx.close()
  })

  it('a hostile key cursor is data: no query is broken by it', () => {
    const fx = newDb()
    fill(fx, NOW - 60_000, 2)
    const db = open(fx.file)
    const hostile = {
      session: { time: 0 },
      message: { time: 0, mode: 'key', key: { below: "x';--", top: 5, recent: [[1, 'a'], ["'; DROP", 1, 1]], floor: 'z', sweep: null, stray: 'no' } },
      part: { time: 0, mode: 'key', key: { below: '', top: '', recent: new Array(100_000).fill(['p', 1, 2]), floor: 0, sweep: '', stray: [] } },
    } as unknown as OpenCodeCursors
    const p = db.poll(hostile)
    assert.equal(p.error, undefined)
    assert.ok((p.cursors.part.key?.recent.length ?? 0) <= OPENCODE_WINDOW_ROWS)
    db.close(); fx.close()
  })
})
