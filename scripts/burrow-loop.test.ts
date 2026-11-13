// Burrow view: the frame loop. With motion, every animation frame; under reduced motion or Freeze motion, no animation
// frame at all, a slow timer instead (and a quick one when something changed).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowLoop } from '../web/lib/burrow/burrow-loop'

/** Virtual frames (every 16 ms) and timers */
function fakeHost() {
  let now = 0
  let id = 0
  const frames = new Map<number, (ts: number) => void>()
  const timers = new Map<number, { at: number; cb: () => void }>()
  let frameRequests = 0
  const host = {
    requestFrame(cb: (ts: number) => void): number { frameRequests++; frames.set(++id, cb); return id },
    cancelFrame(n: number): void { frames.delete(n) },
    setTimer(cb: () => void, ms: number): number { timers.set(++id, { at: now + ms, cb }); return id },
    clearTimer(n: number): void { timers.delete(n) },
  }
  /** Advances the virtual clock by `ms`, firing frames every 16 ms and the timers that fall due */
  const advance = (ms: number): void => {
    const end = now + ms
    while (now < end) {
      now = Math.min(end, now + 16)
      for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.cb() }
      const due = [...frames]
      frames.clear()
      for (const [, cb] of due) cb(now)
    }
  }
  return { host, advance, pendingFrames: () => frames.size, pendingTimers: () => timers.size, frameRequests: () => frameRequests }
}

test('with motion, one animation step per frame with the elapsed seconds, and no timer', () => {
  const h = fakeHost()
  const dts: number[] = []
  let calms = 0
  createBurrowLoop({ host: h.host, reduced: () => false, frame: (dt) => dts.push(dt), calm: () => calms++ })
  h.advance(16 * 11)
  assert.equal(dts.length, 10)                         // the first frame only takes the time
  for (const dt of dts) assert.ok(Math.abs(dt - 0.016) < 1e-9, String(dt))
  assert.equal(calms, 0)
  assert.equal(h.pendingTimers(), 0)
})

test('reduced motion: no animation frame is requested, a calm tick runs about twice a second', () => {
  const h = fakeHost()
  let frames = 0
  let calms = 0
  createBurrowLoop({ host: h.host, reduced: () => true, frame: () => frames++, calm: () => calms++ })
  h.advance(5000)
  assert.equal(frames, 0)
  assert.equal(h.frameRequests(), 0)
  assert.ok(calms >= 9 && calms <= 11, `${calms} calm ticks in 5 s`)
})

test('reduced motion: wake() brings the next calm tick forward, and repeated wakes do not postpone it', () => {
  const h = fakeHost()
  let calms = 0
  const loop = createBurrowLoop({ host: h.host, reduced: () => true, frame: () => {}, calm: () => calms++ })
  h.advance(200)
  const before = calms
  loop.wake()
  for (let i = 0; i < 10; i++) { h.advance(16); loop.wake() }   // a hover that keeps changing
  assert.ok(calms > before, 'a calm tick ran within ~160 ms of the first wake')
})

test('switching motion off stops the frames, switching it back on resumes them', () => {
  const h = fakeHost()
  let reduced = false
  let frames = 0
  let calms = 0
  const loop = createBurrowLoop({ host: h.host, reduced: () => reduced, frame: () => frames++, calm: () => calms++ })
  h.advance(160)
  assert.ok(frames > 0)
  reduced = true
  loop.wake()
  h.advance(32)
  const atStop = frames
  h.advance(2000)
  assert.equal(frames, atStop, 'no frame under reduced motion')
  assert.equal(h.pendingFrames(), 0)
  assert.ok(calms >= 3)
  reduced = false
  loop.wake()
  h.advance(160)
  assert.ok(frames > atStop + 5, 'frames again')
  assert.equal(h.pendingTimers(), 0, 'the calm timer is gone')
})

test('a motion change noticed without wake() is still followed (the next frame or calm tick switches)', () => {
  const h = fakeHost()
  let reduced = false
  let frames = 0
  let calms = 0
  createBurrowLoop({ host: h.host, reduced: () => reduced, frame: () => frames++, calm: () => calms++ })
  h.advance(100)
  reduced = true
  h.advance(1000)
  assert.equal(h.pendingFrames(), 0)
  assert.ok(calms >= 1)
  reduced = false
  const f = frames
  h.advance(1000)
  assert.ok(frames > f)
})

test('stop() cancels everything', () => {
  const h = fakeHost()
  let n = 0
  const loop = createBurrowLoop({ host: h.host, reduced: () => false, frame: () => n++, calm: () => n++ })
  h.advance(50)
  loop.stop()
  const at = n
  loop.wake()
  h.advance(2000)
  assert.equal(n, at)
  assert.equal(h.pendingFrames() + h.pendingTimers(), 0)
})
