/**
 * OpenCodeSessionWatcher (#346): attaches the root sessions of the workspace found in the database,
 * stamps every event with the root session id, releases idle sessions and survives a missing,
 * locked or hostile database. Real node:sqlite databases; skipped where this Node has none.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { OpenCodeSessionWatcher } from '../src/opencode-session-watcher'
import { ACTIVE_SESSION_AGE_S, OPENCODE_MAX_WATCHED_SESSIONS } from '../src/constants'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'
import { OpenCodeFixture, sqliteAvailable, tmpDir } from './helpers/opencode-fixture'

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0)
const userMsg = { role: 'user', time: { created: T0 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } }

let watchers: OpenCodeSessionWatcher[] = []
afterEach(() => { for (const w of watchers) w.dispose(); watchers = [] })

function setup(workspace: string | null = '/w', clock = { t: T0 }) {
  const dir = tmpDir()
  const fx = new OpenCodeFixture(path.join(dir, 'opencode.db'))
  const events: AgentEvent[] = []
  const lifecycle: SessionLifecycleEvent[] = []
  const w = new OpenCodeSessionWatcher(workspace, { dbFile: fx.file, now: () => clock.t })
  watchers.push(w)
  w.onEvent(e => events.push(e))
  w.onSessionLifecycle(l => lifecycle.push(l))
  return { dir, fx, w, events, lifecycle, clock }
}

describe('OpenCodeSessionWatcher', { skip: !sqliteAvailable() }, () => {
  it('attaches a recent root session of the workspace and stamps events with its id', () => {
    const { fx, w, events, lifecycle } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    fx.part('prt_1', 'msg_1', 'ses_a', T0 - 900, T0 - 900, { type: 'text', text: 'hello' })
    w.start()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    assert.equal(lifecycle[0].sessionId, 'ses_a')
    assert.equal(lifecycle[0].runtime, 'opencode')
    assert.ok(events.some(e => e.type === 'agent_spawn'))
    assert.ok(events.length > 0 && events.every(e => e.sessionId === 'ses_a'))
    assert.deepEqual(w.getActiveSessions().map(s => [s.id, s.runtime, s.status]), [['ses_a', 'opencode', 'active']])
    assert.equal(w.isSessionActive('ses_a'), true)
  })

  it('ignores a session whose directory is outside the workspace', () => {
    const { fx, w, lifecycle } = setup('/w')
    fx.session('ses_x', { dir: '/other', created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.equal(lifecycle.length, 0)
    assert.equal(w.isActive(), false)
  })

  it('attaches an old root session as soon as a message arrives (activity does not bump session.time_updated)', () => {
    const { fx, w, lifecycle, clock } = setup()
    const old = T0 - (ACTIVE_SESSION_AGE_S + 3600) * 1000
    fx.session('ses_old', { created: old, updated: old })
    w.start()
    assert.equal(lifecycle.length, 0)
    clock.t = T0 + 1000
    fx.message('msg_n', 'ses_old', clock.t, userMsg)
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
  })

  it('does not replay messages older than the activity window', () => {
    const { fx, w, events } = setup()
    fx.session('ses_a', { created: T0 - 9e6, updated: T0 - 1000 })
    fx.message('msg_old', 'ses_a', T0 - (ACTIVE_SESSION_AGE_S + 60) * 1000, { ...userMsg })
    fx.part('prt_old', 'msg_old', 'ses_a', 1, T0 - (ACTIVE_SESSION_AGE_S + 60) * 1000, { type: 'text', text: 'ancien' })
    fx.message('msg_new', 'ses_a', T0 - 900, { ...userMsg })
    fx.part('prt_new', 'msg_new', 'ses_a', T0 - 900, T0 - 900, { type: 'text', text: 'recent' })
    w.start()
    // Positive control: the in-window part comes out, the out-of-window one does not
    assert.equal(events.some(e => e.type === 'message' && JSON.stringify(e.payload).includes('recent')), true)
    assert.equal(events.some(e => e.type === 'message' && JSON.stringify(e.payload).includes('ancien')), false)
  })

  it('routes a sub-agent session to the root session and emits no duplicate on a second scan', () => {
    const { fx, w, events } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.session('ses_child', { parent: 'ses_a', created: T0 - 800, updated: T0 - 500, title: 'sub' })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    fx.message('msg_c', 'ses_child', T0 - 400, { ...userMsg, time: { created: T0 - 400 } })
    fx.part('prt_c', 'msg_c', 'ses_child', T0 - 400, T0 - 400, { type: 'text', text: 'from child' })
    w.start()
    assert.ok(events.every(e => e.sessionId === 'ses_a'))
    assert.ok(events.some(e => e.type === 'agent_spawn' && (e.payload as { isMain?: boolean }).isMain !== true), 'sub-agent spawn')
    assert.ok(events.some(e => e.type === 'message' && JSON.stringify(e.payload).includes('from child')), 'child message routed to the root')
    // Force a re-delivery of the same rows: nothing may be emitted twice
    const first = events.length
    const internal = w as unknown as { cursors: unknown }
    internal.cursors = { session: { time: 0, seen: [] }, message: { time: 0, seen: [] }, part: { time: 0, seen: [] } }
    w.scanNow()
    assert.equal(events.length, first)
  })

  it('releases an idle session, then reattaches it on new activity without a second spawn', () => {
    const { fx, w, events, lifecycle, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    w.start()
    const spawns = () => events.filter(e => e.type === 'agent_spawn' && (e.payload as { isMain?: boolean }).isMain).length
    assert.equal(spawns(), 1)
    clock.t = T0 + (ACTIVE_SESSION_AGE_S + 5) * 1000
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended'])
    assert.equal(w.isActive(), false)
    fx.message('msg_2', 'ses_a', clock.t, { ...userMsg, time: { created: clock.t } })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended', 'started'])
    assert.equal(spawns(), 1)
  })

  it('ends an archived root session and does not reattach it', () => {
    const { fx, w, lifecycle, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    clock.t = T0 + 1000
    fx.session('ses_a', { created: T0 - 5000, updated: clock.t, archived: clock.t })
    w.scanNow()
    fx.message('msg_1', 'ses_a', clock.t + 1, userMsg)
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended'])
  })

  it('waits for a missing database, reports why, then attaches when it appears', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'opencode.db')
    const lifecycle: SessionLifecycleEvent[] = []
    const w = new OpenCodeSessionWatcher('/w', { dbFile: file, now: () => T0 })
    watchers.push(w)
    w.onSessionLifecycle(l => lifecycle.push(l))
    w.start()
    assert.match(w.status(), /not found/)
    const fx = new OpenCodeFixture(file)
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    assert.doesNotMatch(w.status(), /not found/)
  })

  it('never exposes a hostile directory as cwd, and does not attach it to a workspace', () => {
    const { fx, w } = setup(null)
    fx.session('ses_ctl', { dir: '/w/\u001b[2Jx', created: T0 - 5000, updated: T0 - 1000 })
    fx.session('ses_rel', { dir: '../etc', created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.deepEqual(w.getActiveSessions().map(s => s.id).sort(), ['ses_ctl', 'ses_rel'])
    // The reader already strips control characters from the directory; the watcher keeps its own check
    // and drops a relative path. Either way no control character and no relative path reaches the cwd.
    for (const s of w.getActiveSessions()) assert.ok(s.cwd === undefined || (path.isAbsolute(s.cwd) && !/[\u0000-\u001f\u007f-\u009f]/.test(s.cwd)))
    assert.equal(w.getActiveSessions().find(s => s.id === 'ses_rel')?.cwd, undefined)
    const strict = setup('/w')
    strict.fx.session('ses_rel', { dir: '../w', created: T0 - 5000, updated: T0 - 1000 })
    strict.w.start()
    assert.equal(strict.w.isActive(), false)
    // The watcher's own check, defence in depth behind the reader: control, C1 and bidi-override paths
    const safe = (d: string | null) => (w as unknown as { safeDirectory(d: string | null): string | undefined }).safeDirectory(d)
    assert.equal(safe('/w/\u001bx'), undefined)
    assert.equal(safe('/w/\u0085x'), undefined)
    assert.equal(safe('/w/\u202ex'), undefined)
    assert.equal(safe('/w/\u2066x'), undefined)
    assert.equal(safe('../etc'), undefined)
    assert.equal(safe('/w/ok'), '/w/ok')
  })

  it(`follows at most ${OPENCODE_MAX_WATCHED_SESSIONS} root sessions`, () => {
    const { fx, w } = setup()
    // ses_0 is the newest, ses_27 the oldest: the 25 most recently updated must win
    for (let i = 0; i < OPENCODE_MAX_WATCHED_SESSIONS + 3; i++) fx.session(`ses_${i}`, { created: T0 - 5000, updated: T0 - 1000 - i })
    w.start()
    const expected = Array.from({ length: OPENCODE_MAX_WATCHED_SESSIONS }, (_, i) => `ses_${i}`).sort()
    assert.deepEqual(w.getActiveSessions().map(s => s.id).sort(), expected)
  })

  it('survives a failing poll and recovers on the next one', () => {
    const { fx, w, lifecycle } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    const internal = w as unknown as { db: { poll: (...a: unknown[]) => unknown } }
    const real = internal.db.poll.bind(internal.db)
    internal.db.poll = () => ({ sessions: [], messages: [], parts: [], skippedRows: 0, truncated: false, cursors: undefined, error: 'database is locked' })
    assert.doesNotThrow(() => w.scanNow())
    assert.match(w.status(), /locked/)
    internal.db.poll = real
    fx.message('msg_1', 'ses_a', T0 - 500, userMsg)
    w.scanNow()
    assert.doesNotMatch(w.status(), /locked/)
    assert.equal(lifecycle.length, 1)
  })

  it('ignores a completed tool part whose message predates the activity window', () => {
    const { fx, w, events } = setup()
    const old = T0 - (ACTIVE_SESSION_AGE_S + 60) * 1000
    fx.session('ses_a', { created: T0 - 9e6, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', old, userMsg)
    fx.part('prt_t', 'msg_1', 'ses_a', old, T0 - 500, { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'x', time: { start: 1, end: 2 } } })
    w.start()
    // The message of the part predates the window and is never read: the parser has no message to attach
    // the part to and ignores it, so neither a tool_call_end without start nor a lone start comes out
    assert.deepEqual(events.filter(e => e.type.startsWith('tool_call')), [])
  })
})
