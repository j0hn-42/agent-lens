import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_FRESHNESS_THRESHOLDS, deriveFreshness, lastKnownStateText, stampTouchedAgents, carryFreshness,
  freshnessKey, freshnessMap, buildFreshnessAnnouncement, type Freshness,
  deriveSilence, silenceText,
} from '../web/hooks/simulation/freshness'
import { createFreshnessClock } from '../web/hooks/use-freshness-clock'
import {
  STALE_AFTER_MS, TERMINAL_STATUS_VISIBLE_MS, FRESHNESS_TICK_MS, SILENT_AFTER_MS,
} from '../web/lib/canvas-constants'
import type { Agent } from '../web/lib/agent-types'

const T0 = 1_000_000_000_000

test('thresholds are the documented named constants', () => {
  assert.equal(STALE_AFTER_MS, 30_000)
  assert.equal(TERMINAL_STATUS_VISIBLE_MS, 2 * 60_000)
  assert.equal(FRESHNESS_TICK_MS, 1000)
  assert.deepEqual(DEFAULT_FRESHNESS_THRESHOLDS, {
    staleAfterMs: STALE_AFTER_MS, terminalVisibleMs: TERMINAL_STATUS_VISIBLE_MS,
  })
})

interface Row { name: string; state: string; source?: 'live' | 'history'; at?: number; age: number; expected: Freshness }
const rows: Row[] = [
  { name: 'live, just heard', state: 'thinking', at: T0, age: 0, expected: 'fresh' },
  { name: 'live, exactly 30 s is still fresh', state: 'tool_calling', at: T0, age: STALE_AFTER_MS, expected: 'fresh' },
  { name: 'live, 30 s + 1 ms is stale', state: 'tool_calling', at: T0, age: STALE_AFTER_MS + 1, expected: 'stale' },
  { name: 'idle also ages', state: 'idle', at: T0, age: STALE_AFTER_MS + 1, expected: 'stale' },
  { name: 'waiting for permission also ages', state: 'waiting_permission', at: T0, age: STALE_AFTER_MS + 1, expected: 'stale' },
  { name: 'history, just received, is only the last known state (#361)', state: 'thinking', source: 'history', at: T0, age: 0, expected: 'stale' },
  { name: 'history, 40 min later, is still only the last known state', state: 'tool_calling', source: 'history', at: T0, age: 40 * 60_000, expected: 'stale' },
  { name: 'history of a closed agent is closed', state: 'complete', source: 'history', at: T0, age: 0, expected: 'closed' },
  { name: 'error, just now', state: 'error', at: T0, age: 0, expected: 'error' },
  { name: 'error, exactly 2 min still visible', state: 'error', at: T0, age: TERMINAL_STATUS_VISIBLE_MS, expected: 'error' },
  { name: 'error, 2 min + 1 ms is closed', state: 'error', at: T0, age: TERMINAL_STATUS_VISIBLE_MS + 1, expected: 'closed' },
  { name: 'paused = interrupted, exactly 2 min', state: 'paused', at: T0, age: TERMINAL_STATUS_VISIBLE_MS, expected: 'interrupted' },
  { name: 'interrupted, 2 min + 1 ms is closed', state: 'paused', at: T0, age: TERMINAL_STATUS_VISIBLE_MS + 1, expected: 'closed' },
  { name: 'complete is closed at once', state: 'complete', at: T0, age: 0, expected: 'closed' },
  { name: 'complete stays closed', state: 'complete', at: T0, age: 150 * 60_000, expected: 'closed' },
  { name: 'never observed (no timestamp)', state: 'thinking', age: 0, expected: 'never-observed' },
  { name: 'never observed even for a terminal state', state: 'error', age: 0, expected: 'never-observed' },
  { name: 'a clock going backwards does not make it stale', state: 'thinking', at: T0, age: -STALE_AFTER_MS * 10, expected: 'fresh' },
]
for (const r of rows) {
  test(`deriveFreshness: ${r.name}`, () => {
    const agent = { state: r.state, lastEventAt: r.at, freshnessSource: r.source }
    assert.equal(deriveFreshness(agent, T0 + r.age), r.expected)
  })
}

test('deriveFreshness: a non-finite timestamp or clock is never observed, not fresh', () => {
  assert.equal(deriveFreshness({ state: 'thinking', lastEventAt: Number.NaN }, T0), 'never-observed')
  assert.equal(deriveFreshness({ state: 'thinking', lastEventAt: T0 }, Number.NaN), 'never-observed')
})

test('deriveFreshness: custom thresholds are honoured', () => {
  const th = { staleAfterMs: 10, terminalVisibleMs: 50 }
  assert.equal(deriveFreshness({ state: 'thinking', lastEventAt: 0 }, 10, th), 'fresh')
  assert.equal(deriveFreshness({ state: 'thinking', lastEventAt: 0 }, 11, th), 'stale')
  assert.equal(deriveFreshness({ state: 'error', lastEventAt: 0 }, 51, th), 'closed')
})

test('lastKnownStateText names the state in words', () => {
  assert.equal(lastKnownStateText('thinking'), 'last known state: Thinking')
  assert.equal(lastKnownStateText('tool_calling'), 'last known state: Calling tool')
})

const ag = (id: string, over: Partial<Agent> = {}) => ({ id, name: id, state: 'thinking', ...over }) as Agent

test('stampTouchedAgents only stamps the agents whose object changed', () => {
  const a = ag('a'); const b = ag('b')
  const prev = new Map([['a', a], ['b', b]])
  const next = new Map([['a', a], ['b', { ...b, state: 'idle' } as Agent], ['c', ag('c')]])
  const out = stampTouchedAgents(prev, next, T0)
  assert.equal(out.get('a')!.lastEventAt, undefined, 'untouched agent keeps no stamp')
  assert.equal(out.get('b')!.lastEventAt, T0)
  assert.equal(out.get('b')!.freshnessSource, 'live')
  assert.equal(out.get('c')!.lastEventAt, T0, 'a new agent is stamped')
  assert.equal(stampTouchedAgents(prev, prev as Map<string, Agent>, T0), prev, 'no change: same map back')
})

test('carryFreshness restores the wall-clock stamps after a replay', () => {
  const prev = new Map([['a', ag('a', { lastEventAt: T0, freshnessSource: 'live' })], ['b', ag('b')]])
  const replayed = new Map([['a', ag('a')], ['b', ag('b')], ['z', ag('z')]])
  const out = carryFreshness(prev, replayed)
  assert.equal(out.get('a')!.lastEventAt, T0)
  assert.equal(out.get('b')!.lastEventAt, undefined)
  assert.equal(out.get('z')!.lastEventAt, undefined)
})

test('freshnessKey changes only when an agent crosses a threshold', () => {
  const agents = [ag('a', { lastEventAt: T0 }), ag('b', { lastEventAt: T0, state: 'complete' }), ag('n')]
  const k0 = freshnessKey(agents, T0 + 1000)
  assert.equal(k0, 'b=closed')
  assert.equal(freshnessKey(agents, T0 + 5000), k0, 'a plain tick leaves the key unchanged')
  assert.equal(freshnessKey(agents, T0 + STALE_AFTER_MS + 1), 'a=stale|b=closed')
})

test('buildFreshnessAnnouncement: one aggregated message for stale and closed, none otherwise', () => {
  const names = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma'], ['d', 'Delta'], ['e', 'Eps']])
  const prev = new Map<string, Freshness>([['a', 'fresh'], ['b', 'fresh'], ['c', 'fresh'], ['d', 'fresh'], ['e', 'fresh']])
  assert.equal(buildFreshnessAnnouncement(prev, prev, names), null, 'no change: silence')
  const one = buildFreshnessAnnouncement(prev, new Map<string, Freshness>([...prev, ['a', 'stale']]), names)
  assert.equal(one, 'Alpha is no longer reporting, showing the last known state.')
  const many = buildFreshnessAnnouncement(
    prev, new Map<string, Freshness>([['a', 'stale'], ['b', 'stale'], ['c', 'stale'], ['d', 'stale'], ['e', 'closed']]), names,
  )
  assert.equal(many, 'Alpha, Beta, Gamma and 1 more are no longer reporting, showing the last known state. Eps closed.')
  assert.equal(
    buildFreshnessAnnouncement(prev, new Map<string, Freshness>([...prev, ['a', 'error']]), names), null,
    'only stale / closed are announced',
  )
  assert.equal(buildFreshnessAnnouncement(new Map(), prev, names), null, 'first reading is a baseline')
  const stalePrev = new Map<string, Freshness>([['a', 'stale']])
  assert.equal(buildFreshnessAnnouncement(stalePrev, new Map<string, Freshness>([['a', 'stale']]), names), null, 'already stale: not repeated')
  assert.deepEqual([...freshnessMap([ag('a', { lastEventAt: T0 })], T0)], [['a', 'fresh']])
})

test('buildFreshnessAnnouncement: a live agent whose status now comes from a replayed history is not said to stop reporting (#361)', () => {
  const names = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']])
  const prev = new Map<string, Freshness>([['a', 'fresh'], ['b', 'fresh'], ['c', 'fresh']])
  const next = new Map<string, Freshness>([['a', 'stale'], ['b', 'stale'], ['c', 'fresh']])
  assert.equal(
    buildFreshnessAnnouncement(prev, next, names, new Set(['a'])),
    'Beta is no longer reporting, showing the last known state. Alpha shows a state read from history.',
  )
  assert.equal(
    buildFreshnessAnnouncement(prev, new Map<string, Freshness>([['a', 'stale'], ['b', 'stale'], ['c', 'fresh']]), names, new Set(['a', 'b'])),
    'Alpha, Beta show a state read from history.',
  )
})

test('carryFreshness carries the SOURCE of the stamp too (history stays history after a seek)', () => {
  const prev = new Map([
    ['h', ag('h', { lastEventAt: T0, freshnessSource: 'history' })],
    ['l', ag('l', { lastEventAt: T0, freshnessSource: 'live' })],
  ])
  const out = carryFreshness(prev, new Map([['h', ag('h')], ['l', ag('l')]]))
  assert.equal(out.get('h')!.freshnessSource, 'history')
  assert.equal(out.get('l')!.freshnessSource, 'live')
})

test('buildFreshnessAnnouncement: an agent first seen already stale or closed is a baseline, not an announcement', () => {
  const names = new Map([['n', 'Newcomer'], ['m', 'Mover']])
  const prev = new Map<string, Freshness>([['m', 'fresh']])
  assert.equal(buildFreshnessAnnouncement(prev, new Map<string, Freshness>([['m', 'fresh'], ['n', 'stale']]), names), null, 'new + stale')
  assert.equal(buildFreshnessAnnouncement(prev, new Map<string, Freshness>([['m', 'fresh'], ['n', 'closed']]), names), null, 'new + closed')
  assert.equal(
    buildFreshnessAnnouncement(prev, new Map<string, Freshness>([['m', 'stale'], ['n', 'stale']]), names),
    'Mover is no longer reporting, showing the last known state.',
    'only the agent that was known before is announced',
  )
})

// ─── Shared clock ────────────────────────────────────────────────────────────

function fakeEnv() {
  let now = T0
  let hidden = false
  let fn: (() => void) | null = null
  let visibility: (() => void) | null = null
  let intervals = 0
  const env = {
    now: () => now,
    isHidden: () => hidden,
    setInterval: (f: () => void, ms: number) => { assert.equal(ms, FRESHNESS_TICK_MS); fn = f; intervals++; return 1 },
    clearInterval: () => { fn = null },
    onVisibilityChange: (f: () => void) => { visibility = f; return () => { visibility = null } },
  }
  return {
    env,
    advance(ms: number) { now += ms; fn?.() },
    hide() { hidden = true; visibility?.() },
    show() { hidden = false; visibility?.() },
    get running() { return fn !== null },
    get intervals() { return intervals },
    get watching() { return visibility !== null },
  }
}

test('clock: ticks once per period for every subscriber and updates getNow', () => {
  const f = fakeEnv()
  const clock = createFreshnessClock(f.env)
  let a = 0; let b = 0
  const offA = clock.subscribe(() => a++)
  const offB = clock.subscribe(() => b++)
  assert.equal(f.intervals, 1, 'ONE timer for all subscribers')
  f.advance(1000)
  assert.deepEqual([a, b], [1, 1])
  assert.equal(clock.getNow(), T0 + 1000)
  offA(); f.advance(1000)
  assert.deepEqual([a, b], [1, 2])
  offB()
  assert.equal(f.running, false, 'no subscriber: the timer is stopped')
  assert.equal(f.watching, false)
})

test('clock: paused while the document is hidden, catches up when visible again', () => {
  const f = fakeEnv()
  const clock = createFreshnessClock(f.env)
  let n = 0
  clock.subscribe(() => n++)
  f.advance(1000)
  assert.equal(n, 1)
  f.hide()
  assert.equal(f.running, false, 'timer cleared while hidden')
  f.advance(5000)
  assert.equal(n, 1, 'no tick while hidden')
  f.show()
  assert.equal(n, 2, 'one immediate catch-up tick when visible again')
  assert.equal(f.running, true)
  f.advance(1000)
  assert.equal(n, 3)
})

test('clock: subscribing while hidden does not start the timer', () => {
  const f = fakeEnv()
  f.hide()
  const clock = createFreshnessClock(f.env)
  clock.subscribe(() => {})
  assert.equal(f.running, false)
  f.show()
  assert.equal(f.running, true)
})

// Silent or waiting for a permission (#226): only what the events prove, never "stuck" as a verdict.
test('SILENT_AFTER_MS is five minutes, well past the stale threshold', () => {
  assert.equal(SILENT_AFTER_MS, 5 * 60_000)
  assert.ok(SILENT_AFTER_MS > STALE_AFTER_MS)
})

interface SilenceRow { name: string; state: string; source?: 'live' | 'history'; at?: number; age: number; expected: unknown }
const silenceRows: SilenceRow[] = [
  { name: 'fresh agent: nothing to report', state: 'thinking', at: T0, age: 1000, expected: null },
  { name: 'stale but under 5 min: only "last known state"', state: 'thinking', at: T0, age: SILENT_AFTER_MS, expected: null },
  { name: 'silent one millisecond past 5 min', state: 'thinking', at: T0, age: SILENT_AFTER_MS + 1, expected: { kind: 'silent', ms: SILENT_AFTER_MS + 1 } },
  { name: 'a long tool call is silent, not "blocked"', state: 'tool_calling', at: T0, age: 10 * 60_000, expected: { kind: 'silent', ms: 10 * 60_000 } },
  { name: 'idle also reports silence', state: 'idle', at: T0, age: 6 * 60_000, expected: { kind: 'silent', ms: 6 * 60_000 } },
  { name: 'a pending permission is told apart from silence', state: 'waiting_permission', at: T0, age: 6 * 60_000, expected: { kind: 'permission', ms: 6 * 60_000 } },
  { name: 'a permission pending for under 5 min is not reported', state: 'waiting_permission', at: T0, age: SILENT_AFTER_MS, expected: null },
  { name: 'history status: its age is not wall-clock proof', state: 'thinking', source: 'history', at: T0, age: 20 * 60_000, expected: null },
  { name: 'history permission: not proven either', state: 'waiting_permission', source: 'history', at: T0, age: 20 * 60_000, expected: null },
  { name: 'complete is closed, not silent', state: 'complete', at: T0, age: 60 * 60_000, expected: null },
  { name: 'error is closed, not silent', state: 'error', at: T0, age: 60 * 60_000, expected: null },
  { name: 'interrupted is closed, not silent', state: 'paused', at: T0, age: 60 * 60_000, expected: null },
  { name: 'never observed: no silence can be claimed', state: 'thinking', age: 0, expected: null },
  { name: 'a clock going backwards claims nothing', state: 'thinking', at: T0, age: -SILENT_AFTER_MS * 2, expected: null },
]
for (const r of silenceRows) {
  test(`deriveSilence: ${r.name}`, () => {
    const out = deriveSilence({ state: r.state, lastEventAt: r.at, freshnessSource: r.source }, T0 + r.age)
    if (r.expected === null) return assert.equal(out, null)
    const exp = r.expected as { kind: string; ms: number }
    assert.equal(out?.kind, exp.kind)
    assert.equal(out?.ms, exp.ms)
  })
}

test('deriveSilence: a non-finite clock claims nothing; custom threshold is honoured', () => {
  assert.equal(deriveSilence({ state: 'thinking', lastEventAt: T0 }, Number.NaN), null)
  assert.equal(deriveSilence({ state: 'thinking', lastEventAt: 0 }, 60_000, 40_000)?.kind, 'silent')
})

test('silenceText: whole minutes in words, last known state kept, permission said as such', () => {
  assert.equal(silenceText({ kind: 'silent', ms: 6 * 60_000 + 59_000 }, 'thinking'), 'last known state: Thinking, silent for 6 min')
  assert.equal(silenceText({ kind: 'silent', ms: 61 * 60_000 }, 'tool_calling'), 'last known state: Calling tool, silent for 1 h 1 min')
  assert.equal(silenceText({ kind: 'permission', ms: 7 * 60_000 }, 'waiting_permission'), 'waiting for permission for 7 min')
})

test('freshnessKey follows the minute of a silent agent, and still ignores plain ticks', () => {
  const agents = [ag('a', { lastEventAt: T0 }), ag('p', { lastEventAt: T0, state: 'waiting_permission' })]
  const k = freshnessKey(agents, T0 + SILENT_AFTER_MS + 1000)
  assert.equal(k, 'a=stale:5m|p=stale:5m')
  assert.equal(freshnessKey(agents, T0 + SILENT_AFTER_MS + 30_000), k, 'same minute, same key')
  assert.equal(freshnessKey(agents, T0 + SILENT_AFTER_MS + 61_000), 'a=stale:6m|p=stale:6m')
})

test('a replayed (history) status reads as last known state on every surface, from the moment it is received (#361)', async () => {
  const { agentActivityCounts } = await import('../web/lib/chrome-utils')
  const { agentRowView } = await import('../web/lib/row-sync')
  const replayed = { id: 'h', name: 'h', state: 'thinking', lastEventAt: T0, freshnessSource: 'history' as const }
  // Top bar: never counted active
  assert.deepEqual(agentActivityCounts([replayed], T0), { active: 0, done: 0, stale: 1 })
  // Sessions panel row (the text alternative to the canvas): the state is said to be the last known one
  const view = agentRowView(replayed as Parameters<typeof agentRowView>[0], T0 + 31_000)
  assert.equal(view.stale, true)
  assert.equal(view.detail, 'last known state: Thinking')
  assert.equal(deriveSilence(replayed, T0 + 40 * 60_000), null, 'and never a wall-clock silence')
})
