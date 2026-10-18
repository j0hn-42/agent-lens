/**
 * OpenCodeSessionWatcher with the reader's cursor by primary key (#420 points 1 and 2): a mass import
 * does not stop the runtime, the data_version gate still skips the poll while nothing is written, the
 * polls that follow writes do not scan `message` or `part`, and a change the window missed reaches the
 * normalization_stats of its session. Real node:sqlite databases.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { OpenCodeSessionWatcher } from '../src/opencode-session-watcher'
import { OPENCODE_WINDOW_MS } from '../src/opencode-db'
import { nodeSqliteOpener, type IndexOpener } from '../src/session-index'
import type { AgentEvent } from '../src/protocol'
import { OpenCodeFixture, cleanupFixtures, openCodeId, sqliteAvailable, tmpDir } from './helpers/opencode-fixture'

// In the past of the real clock: the reader opened by the watcher does not read rows dated in the future
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000
const userMsg = { role: 'user', time: { created: T0 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } }

let watchers: OpenCodeSessionWatcher[] = []
afterEach(() => {
  try { for (const w of watchers) w.dispose() } finally {
    watchers = []
    cleanupFixtures()
  }
})

function recordingOpener(sqls: string[]): IndexOpener {
  const base = nodeSqliteOpener()
  if (!base) throw new Error('no node:sqlite')
  return (file, opts) => {
    const conn = base(file, opts)
    return { all(sql) { sqls.push(sql); return conn.all(sql) }, close: () => conn.close() }
  }
}

function setup(clock = { t: T0 }) {
  const fx = new OpenCodeFixture(path.join(tmpDir(), 'opencode.db'))
  const sqls: string[] = []
  const events: AgentEvent[] = []
  const w = new OpenCodeSessionWatcher(null, { dbFile: fx.file, now: () => clock.t, opener: recordingOpener(sqls) })
  watchers.push(w)
  w.onEvent(e => events.push(e))
  return { fx, w, sqls, events, clock }
}

const scansOf = (sqls: string[], table: string) => sqls.filter(s => new RegExp(`FROM ${table}\\b`).test(s))

describe('OpenCodeSessionWatcher: cursor by primary key (#420)', { skip: !sqliteAvailable() }, () => {
  it('a mass import of sessions and parts in one millisecond does not stop the runtime', () => {
    const { fx, w, events, clock } = setup()
    const t = T0 - 2000
    // Imported sessions share one millisecond, older than the activity window: none is attached (the
    // cap of followed sessions is not what this test is about)
    const imported = T0 - 86_400_000
    fx.batch(() => {
      for (let i = 0; i < 6000; i++) fx.session(`ses_imp${i}`, { created: imported, updated: imported })
      fx.session('ses_live', { created: t, updated: t })
      fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', t, 1)}', 'ses_live', ${t}, ${t}, '${JSON.stringify(userMsg)}')`)
      for (let i = 0; i < 12_000; i++) {
        fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', t, i + 2)}', '${openCodeId('msg', t, 1)}', 'ses_live', ${t}, ${t}, '{"type":"text","text":"x"}')`)
      }
    })
    w.start()
    for (let i = 0; i < 400; i++) w.scanNow(true)
    assert.equal(w.statusProblem(), undefined)
    assert.match(w.status(), /^OpenCode database/)
    // The runtime still follows what comes next
    clock.t = T0 + 5000
    fx.raw(`INSERT INTO message VALUES ('${openCodeId('msg', T0 + 4000, 1)}', 'ses_live', ${T0 + 4000}, ${T0 + 4000}, '${JSON.stringify({ ...userMsg, time: { created: T0 + 4000 } })}')`)
    fx.raw(`INSERT INTO part VALUES ('${openCodeId('prt', T0 + 4000, 2)}', '${openCodeId('msg', T0 + 4000, 1)}', 'ses_live', ${T0 + 4000}, ${T0 + 4000}, '${JSON.stringify({ type: 'text', text: 'after the import' })}')`)
    w.scanNow()
    assert.ok(events.some(e => e.sessionId === 'ses_live' && JSON.stringify(e.payload).includes('after the import')))
  })

  it('the data_version gate stays: no poll while nothing is written, then the poll after a write walks the primary key', () => {
    const { fx, w, sqls, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message(openCodeId('msg', T0 - 900, 1), 'ses_a', T0 - 900, userMsg)
    w.start()
    sqls.length = 0
    for (let i = 0; i < 5; i++) { clock.t += 1000; w.scanNow() }
    assert.deepEqual(sqls.filter(s => !/^PRAGMA data_version$/.test(s)), [], 'nothing but data_version while nothing changes')
    fx.message(openCodeId('msg', clock.t - 600, 2), 'ses_a', clock.t - 600, userMsg)
    clock.t += 1000
    w.scanNow()
    const keyed = [...scansOf(sqls, 'part'), ...scansOf(sqls, 'message')]
    assert.ok(keyed.length > 0)
    for (const s of keyed) assert.ok(!/ORDER BY (part|message)\.time_updated/.test(s), `no sort on time_updated: ${s}`)
  })

  it('a part changed outside the window is counted in the normalization_stats of its followed session', async () => {
    const { fx, w, events, clock } = setup()
    const old = T0 - OPENCODE_WINDOW_MS - 3_600_000
    fx.session('ses_a', { created: old, updated: T0 - 1000 })
    const oldMsg = openCodeId('msg', old, 1)
    const oldPart = openCodeId('prt', old, 2)
    fx.message(oldMsg, 'ses_a', old, userMsg)
    fx.part(oldPart, oldMsg, 'ses_a', old, old, { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'sleep 9999' }, time: { start: old } } })
    fx.message(openCodeId('msg', T0 - 900, 3), 'ses_a', T0 - 900, userMsg)
    w.start()
    assert.equal(w.isSessionActive('ses_a'), true)
    clock.t = T0 + 2000
    fx.part(oldPart, oldMsg, 'ses_a', old, T0 + 1000, { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'sleep 9999' }, output: 'done', time: { start: old, end: T0 + 1000 } } })
    w.scanNow()
    await new Promise(r => setTimeout(r, 20)) // a lone count is published by a timer
    const stats = events.filter(e => e.type === 'normalization_stats')
    assert.ok(stats.length > 0, 'the loss is published')
    assert.equal((stats[stats.length - 1].payload as { ignoredEvents: number }).ignoredEvents, 1)
  })
})
