import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  ActiveTimeTracker, SAMPLE_GAP_MAX_MS, CHRONO_CAP_MS, isActiveState, createChrono, formatActiveSince, activeSinceText,
  ACTIVE_UNKNOWN_TEXT,
} from '../web/lib/active-time'

test('only working states are active', () => {
  for (const s of ['thinking', 'tool_calling']) assert.equal(isActiveState(s), true, s)
  for (const s of ['idle', 'complete', 'error', 'paused', 'waiting_permission', 'nope']) assert.equal(isActiveState(s), false, s)
})

test('start/stop events accumulate only the active spans, pauses between turns are excluded', () => {
  const t = new ActiveTimeTracker()
  t.start(1000); t.stop(4000)       // 3 s
  t.start(60_000); t.stop(62_000)   // 2 s after a long pause
  assert.equal(t.totalMs(100_000), 5000)
  assert.equal(t.activeSince, null)
})

test('an open span counts up to now; duplicate start and stray stop are ignored', () => {
  const t = new ActiveTimeTracker()
  t.stop(500)
  t.start(1000); t.start(2000)
  assert.equal(t.activeSince, 1000)
  assert.equal(t.totalMs(3000), 2000)
  t.stop(3000); t.stop(9000)
  assert.equal(t.totalMs(10_000), 2000)
})

test('time going backwards never produces a negative or shrinking total', () => {
  const t = new ActiveTimeTracker()
  t.start(5000); t.stop(4000)
  assert.equal(t.totalMs(6000), 0)
  t.start(7000)
  assert.equal(t.totalMs(6000), 0)
})

test('nothing observed is unknown, not zero', () => {
  const t = new ActiveTimeTracker()
  assert.equal(t.totalMs(1000), null)
  t.start(1000)
  assert.equal(t.totalMs(1000), 0, 'observed, zero so far')
})

test('sampling bridges gaps of at most 15 s and never a larger one', () => {
  const t = new ActiveTimeTracker()
  t.sample(0, true)
  t.sample(SAMPLE_GAP_MAX_MS, true)           // exactly 15 s: bridged
  assert.equal(t.totalMs(SAMPLE_GAP_MAX_MS), SAMPLE_GAP_MAX_MS)
  t.sample(SAMPLE_GAP_MAX_MS * 2 + 1, true)   // 15.001 s hole: not bridged
  assert.equal(t.totalMs(SAMPLE_GAP_MAX_MS * 2 + 1), SAMPLE_GAP_MAX_MS)
  assert.equal(t.gaps, 1)
})

test('sampling: an inactive sample ends the span, an active to inactive step counts up to that sample', () => {
  const t = new ActiveTimeTracker()
  t.sample(0, true); t.sample(5000, false); t.sample(20_000, false); t.sample(21_000, true); t.sample(24_000, true)
  assert.equal(t.totalMs(24_000), 5000 + 3000)
})

test('chrono: grows by the monotonic clock, not the wall clock (clock jumps do not move it)', () => {
  let mono = 1000
  const c = createChrono({ startedAt: 10_000, wallNow: 70_000, monotonic: () => mono })   // 60 s already elapsed
  assert.equal(c.elapsedMs(), 60_000)
  mono += 5000
  assert.equal(c.elapsedMs(), 65_000)
})

test('chrono: a start in the future (skewed clock) is 0, and the value is capped', () => {
  const mono = 0
  const future = createChrono({ startedAt: 90_000, wallNow: 10_000, monotonic: () => mono })
  assert.equal(future.elapsedMs(), 0)
  const old = createChrono({ startedAt: 0, wallNow: CHRONO_CAP_MS * 3, monotonic: () => mono })
  assert.equal(old.elapsedMs(), CHRONO_CAP_MS)
  assert.equal(old.capped(), true)
})

test('formatActiveSince', () => {
  assert.equal(formatActiveSince(0), '0:00')
  assert.equal(formatActiveSince(65_000), '1:05')
  assert.equal(formatActiveSince(3_725_000), '1:02:05')
  assert.equal(formatActiveSince(CHRONO_CAP_MS, true), `${formatActiveSince(CHRONO_CAP_MS)}+`)
})

test('activeSinceText: only for a fresh agent with a known start; otherwise unknown', () => {
  assert.equal(activeSinceText({ activeSince: 1000 }, 'fresh', 4000), 'active for 0:03')
  assert.equal(activeSinceText({ activeSince: undefined }, 'fresh', 4000), ACTIVE_UNKNOWN_TEXT)
  for (const f of ['stale', 'closed', 'never-observed', 'interrupted', 'error'] as const) {
    assert.equal(activeSinceText({ activeSince: 1000 }, f, 4000), ACTIVE_UNKNOWN_TEXT, f)
  }
})
