/**
 * OpenCodeSessionWatcher (#346): attaches the root sessions of the workspace found in the database,
 * stamps every event with the root session id, releases idle sessions and survives a missing,
 * locked or hostile database. Real node:sqlite databases; skipped where this Node has none.
 */
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import fs from 'node:fs'
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
    // A silence is not an end: the idle release fires no `ended` (only an archived root does)
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    assert.equal(lifecycle.some(l => l.type === 'ended'), false)
    assert.equal(w.isActive(), false)
    fx.message('msg_2', 'ses_a', clock.t, { ...userMsg, time: { created: clock.t } })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'started'])
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
    fx.message('msg_0', 'ses_a', T0 - 600, userMsg) // a commit, so that the data_version gate lets the poll through
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

  it('I2: a far-future session row does not freeze the cursor, a later session is still read', () => {
    const { fx, w, lifecycle, clock } = setup()
    fx.session('ses_future', { created: T0, updated: 9e15 })
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.deepEqual(lifecycle.map(l => l.sessionId), ['ses_a'])
    clock.t = T0 + 5000
    fx.session('ses_b', { created: clock.t, updated: clock.t })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.sessionId), ['ses_a', 'ses_b'])
  })

  describe('I3: the workspace verdict of a root is computed once', () => {
    const realpathCalls = (spy: { mock: { calls: { arguments: unknown[] }[] } }, dir: string) =>
      spy.mock.calls.filter(c => c.arguments[0] === dir).length

    it('200 messages of one out-of-workspace root cost exactly one realpath', () => {
      const { fx, w } = setup('/w')
      fx.session('ses_x', { dir: '/other-ws', created: T0 - 5000, updated: T0 - 1000 })
      fx.batch(() => { for (let i = 0; i < 200; i++) fx.message(`msg_${i}`, 'ses_x', T0 - 900, userMsg) })
      const spy = mock.method(fs, 'realpathSync')
      try {
        w.start()
        w.scanNow()
        assert.equal(realpathCalls(spy, '/other-ws'), 1)
        assert.equal(w.isActive(), false)
      } finally { spy.mock.restore() }
    })

    it('a root refused by the cap costs no realpath', () => {
      const { fx, w } = setup('/w')
      for (let i = 0; i < OPENCODE_MAX_WATCHED_SESSIONS; i++) fx.session(`ses_${i}`, { dir: '/w', created: T0 - 5000, updated: T0 - 1000 - i })
      fx.session('ses_capped', { dir: '/w/capped', created: T0 - 5000, updated: T0 - 100000 })
      for (let i = 0; i < 20; i++) fx.message(`msg_${i}`, 'ses_capped', T0 - 900, userMsg)
      const spy = mock.method(fs, 'realpathSync')
      try {
        w.start()
        assert.equal(w.getActiveSessions().length, OPENCODE_MAX_WATCHED_SESSIONS)
        assert.equal(realpathCalls(spy, '/w/capped'), 0)
      } finally { spy.mock.restore() }
    })

    it('a changed directory is evaluated again', () => {
      const { fx, w, clock } = setup('/w')
      fx.session('ses_x', { dir: '/other-ws', created: T0 - 5000, updated: T0 - 1000 })
      const spy = mock.method(fs, 'realpathSync')
      try {
        w.start()
        assert.equal(w.isActive(), false)
        clock.t = T0 + 1000
        fx.session('ses_x', { dir: '/w/moved', created: T0 - 5000, updated: clock.t })
        w.scanNow()
        assert.equal(realpathCalls(spy, '/w/moved'), 1)
        assert.equal(w.isActive(), true)
      } finally { spy.mock.restore() }
    })
  })

  describe('I4: one poll per tick', () => {
    const MESSAGES = 1200
    const seed = (fx: OpenCodeFixture) => {
      fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
      fx.batch(() => { for (let i = 0; i < MESSAGES; i++) fx.message(`msg_${String(i).padStart(5, '0')}`, 'ses_a', T0 - 900 + i, userMsg) })
    }
    const tick = () => new Promise<void>(r => setImmediate(r))

    it('drains a multi-poll backlog across ticks, one poll per tick', async () => {
      const { fx, w } = setup()
      seed(fx)
      const w2 = w as unknown as { scanNow(): void; db: { poll: (...a: unknown[]) => { messages: unknown[]; truncated: boolean } } | null }
      const scan = mock.method(w2, 'scanNow')
      w.start()
      const db = w2.db!
      const real = db.poll.bind(db)
      const polls: { n: number; truncated: boolean }[] = []
      db.poll = (...a: unknown[]) => { const p = real(...a); polls.push({ n: p.messages.length, truncated: p.truncated }); return p }
      // start() did its own (first) poll before the spy: the rest must come through the scheduled scans
      for (let i = 0; i < 20 && scan.mock.callCount() < 4; i++) await tick()
      assert.ok(scan.mock.callCount() >= 3, 'scans were chained through setImmediate')
      const delivered = polls.reduce((a, p) => a + p.n, 0)
      assert.ok(polls.every(p => p.n <= 500), 'no poll exceeds the limit')
      assert.ok(delivered > 0)
      assert.equal(polls.at(-1)?.truncated, false)
    })

    it('a dispose in the middle of the backlog leaves no pending scan', async () => {
      const { fx, w } = setup()
      seed(fx)
      const scan = mock.method(w as unknown as { scanNow(): void }, 'scanNow')
      w.start()
      assert.equal(scan.mock.callCount(), 1, 'start() runs one poll only')
      w.dispose()
      await tick(); await tick(); await tick()
      assert.equal(scan.mock.callCount(), 1)
    })
  })

  it('M2: an unavailable database is logged with warn, once per status change', () => {
    const dir = tmpDir()
    const w = new OpenCodeSessionWatcher('/w', { dbFile: path.join(dir, 'absent.db'), now: () => T0 })
    watchers.push(w)
    const warn = mock.method(console, 'warn', () => undefined)
    try {
      w.start()
      w.scanNow()
      w.scanNow()
      assert.equal(warn.mock.callCount(), 1)
      assert.match(String(warn.mock.calls[0].arguments.join(' ')), /not found/)
    } finally { warn.mock.restore() }
  })

  it('N1: rows sharing one millisecond cannot keep the scan chain spinning', async () => {
    const { fx, w, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.batch(() => { for (let i = 0; i < 6000; i++) fx.message(`msg_${String(i).padStart(5, '0')}`, 'ses_a', T0 - 900, userMsg) })
    w.start()
    const internal = w as unknown as { db: { poll: (...a: unknown[]) => unknown } }
    const real = internal.db.poll.bind(internal.db)
    let polls = 0
    internal.db.poll = (...a: unknown[]) => { polls++; return real(...a) }
    const tick = () => new Promise<void>(r => setImmediate(r))
    for (let i = 0; i < 150; i++) await tick()
    assert.ok(polls <= 51, `the chain stopped by itself (${polls} polls)`)
    const settled = polls
    for (let i = 0; i < 5; i++) await tick()
    assert.equal(polls, settled, 'no scan left pending')
    // The drained database did not change: the next tick is skipped by the data_version gate, then the
    // periodic recheck polls again
    w.scanNow()
    assert.equal(polls, settled, 'an unchanged database is not scanned again at once')
    clock.t += 60_000
    w.scanNow()
    assert.equal(polls, settled + 1)
  })

  it('N6: a read error shows once with the OpenCode prefix', () => {
    const { fx, w } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    const internal = w as unknown as { db: { poll: (...a: unknown[]) => unknown } }
    internal.db.poll = () => ({ sessions: [], messages: [], parts: [], skippedRows: 0, truncated: false, cursors: undefined, error: 'OpenCode: the database could not be read (locked).' })
    const warn = mock.method(console, 'warn', () => undefined)
    fx.message('msg_0', 'ses_a', T0 - 600, userMsg)
    try { w.scanNow() } finally { warn.mock.restore() }
    assert.equal(w.status(), 'OpenCode: the database could not be read (locked).')
  })

  it('I-A: a sub-agent that appears while its root is released is replayed when the root reattaches', () => {
    const { fx, w, events, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    w.start()
    clock.t = T0 + (ACTIVE_SESSION_AGE_S + 5) * 1000
    w.scanNow()
    assert.equal(w.isActive(), false)
    // One poll: the new child, then activity of the root and of the child
    fx.session('ses_child', { parent: 'ses_a', created: clock.t, updated: clock.t, title: 'sub' })
    fx.message('msg_2', 'ses_a', clock.t, { ...userMsg, time: { created: clock.t } })
    fx.message('msg_c', 'ses_child', clock.t + 1, { ...userMsg, time: { created: clock.t + 1 } })
    fx.part('prt_c', 'msg_c', 'ses_child', clock.t + 1, clock.t + 1, { type: 'text', text: 'from child' })
    w.scanNow()
    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.filter(e => (e.payload as { isMain?: boolean }).isMain).length, 1, 'one main spawn')
    const child = spawns.filter(e => (e.payload as { isMain?: boolean }).isMain !== true)
    assert.equal(child.length, 1, 'the sub-agent is spawned')
    assert.equal(child[0].sessionId, 'ses_a')
    assert.ok(events.some(e => e.type === 'message' && JSON.stringify(e.payload).includes('from child')))
  })

  describe('I-B: data_version gate', () => {
    type Poll = { sessions: unknown[]; messages: unknown[]; parts: unknown[]; skippedRows: number; truncated: boolean; cursors: unknown; error?: string }
    function counted(w: OpenCodeSessionWatcher, override?: () => Poll | undefined) {
      const internal = w as unknown as { db: { poll: (...a: unknown[]) => Poll } }
      const real = internal.db.poll.bind(internal.db)
      const state = { polls: 0 }
      internal.db.poll = (...a: unknown[]) => { state.polls++; return override?.() ?? real(...a) }
      return state
    }

    it('polls first, skips while the database is unchanged, polls again when it changed', () => {
      const { fx, w } = setup()
      fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
      w.start()
      const c = counted(w)
      w.scanNow(); w.scanNow()
      assert.equal(c.polls, 0, 'unchanged: no poll')
      fx.message('msg_1', 'ses_a', T0 - 500, userMsg)
      w.scanNow()
      assert.equal(c.polls, 1, 'changed: poll')
      w.scanNow()
      assert.equal(c.polls, 1)
    })

    it('polls again after an error, and after a truncated poll', () => {
      const { fx, w } = setup()
      fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
      w.start()
      let mode: 'error' | 'truncated' | 'real' = 'error'
      const empty = { sessions: [], messages: [], parts: [], skippedRows: 0, cursors: undefined }
      const c = counted(w, () => {
        if (mode === 'error') return { ...empty, truncated: false, error: 'OpenCode: locked' }
        if (mode === 'truncated') return { ...empty, truncated: true, cursors: (w as unknown as { cursors: unknown }).cursors }
        return undefined
      })
      fx.message('msg_1', 'ses_a', T0 - 500, userMsg)
      w.scanNow()               // error poll (database changed)
      assert.equal(c.polls, 1)
      mode = 'truncated'
      w.scanNow()               // no change, but the last poll failed: poll again
      assert.equal(c.polls, 2)
      mode = 'real'
      w.scanNow()               // no change, but the last poll was truncated: poll again
      assert.equal(c.polls, 3)
      w.scanNow()               // complete poll: now skipped
      assert.equal(c.polls, 3)
    })

    it('forces a poll after 60 s on the injected clock, and the idle release keeps running while polls are skipped', () => {
      const { fx, w, clock } = setup()
      fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
      fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
      w.start()
      const c = counted(w)
      clock.t = T0 + 59_000
      w.scanNow()
      assert.equal(c.polls, 0)
      clock.t = T0 + 60_000
      w.scanNow()
      assert.equal(c.polls, 1, 'forced')
      // Ticks every 20 s: polls are mostly skipped, the session is still released once idle
      let ticks = 0
      while (w.isActive() && ticks < 100) { clock.t += 20_000; ticks++; w.scanNow() }
      assert.equal(w.isActive(), false, 'idle session released')
      assert.equal(ticks, 28)
      assert.ok(c.polls < ticks, `most ticks skipped the poll (${c.polls} polls, ${ticks} ticks)`)
    })
  })
  it('#420: a database deleted then recreated is reopened and read again', () => {
    const { dir, fx, w, events, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.equal(w.isSessionActive('ses_a'), true)
    fx.close()
    fs.rmSync(path.join(dir, 'opencode.db'))
    clock.t = T0 + 1000
    w.scanNow()
    assert.match(w.status(), /not found/, 'the vanished file is reported, not read as OK')
    const fx2 = new OpenCodeFixture(path.join(dir, 'opencode.db'))
    fx2.session('ses_b', { created: T0 + 500, updated: T0 + 900 })
    fx2.message('msg_b', 'ses_b', T0 + 950, userMsg)
    clock.t = T0 + 2000
    w.scanNow()
    assert.doesNotMatch(w.status(), /not found/)
    assert.equal(w.isSessionActive('ses_b'), true, 'the new file is read')
    assert.ok(events.some(e => e.sessionId === 'ses_b'))
    fx2.close()
  })

  it('#420: a database replaced in place (new inode, same path) is reopened', () => {
    const { dir, fx, w, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    fx.close()
    const file = path.join(dir, 'opencode.db')
    fs.rmSync(file)
    const fx2 = new OpenCodeFixture(file)
    fx2.session('ses_c', { created: T0 + 500, updated: T0 + 900 })
    clock.t = T0 + 2000
    w.scanNow()
    assert.equal(w.isSessionActive('ses_c'), true)
    fx2.close()
  })
})
