// Idle drawing (#216): the gate that skips redundant frames and the viewport culling bounds. Pure logic, synthetic data.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createDrawGate, mixStamp, CALM_FRAME_MS, FROZEN_FRAME_MS, INTERACTION_HOLD_MS } from '@/components/agent-visualizer/canvas/draw-gate'
import { viewRectFor, boxInView, pointInView, CULL_MARGIN_PX } from '@/components/agent-visualizer/canvas/view-cull'

const calm = { stamp: 1, reducedMotion: false, animating: false }

test('gate: the first frame always draws', () => {
  const g = createDrawGate()
  assert.equal(g.shouldDraw({ now: 0, ...calm }), true)
})

test('gate: a calm scene is drawn at 10 fps at most, the frames in between are skipped', () => {
  const g = createDrawGate()
  g.shouldDraw({ now: 0, ...calm })
  let drawn = 0
  for (let t = 16; t < 1000; t += 16) if (g.shouldDraw({ now: t, ...calm })) drawn++
  assert.ok(drawn <= 10, `drawn ${drawn} frames in one second`)
  assert.ok(drawn >= 8, 'but it is still refreshed')
  assert.ok(g.skipped > 40)
  assert.equal(g.shouldDraw({ now: 1000 + CALM_FRAME_MS, ...calm }), true)
})

test('gate: a changed stamp (moved node, new tool call, camera move) draws immediately', () => {
  const g = createDrawGate()
  g.shouldDraw({ now: 0, ...calm })
  assert.equal(g.shouldDraw({ now: 16, ...calm }), false)
  assert.equal(g.shouldDraw({ now: 32, ...calm, stamp: 2 }), true)
  assert.equal(g.shouldDraw({ now: 48, ...calm, stamp: 2 }), false)
})

test('gate: an animated scene keeps the full frame rate', () => {
  const g = createDrawGate()
  for (let t = 0; t < 200; t += 16) assert.equal(g.shouldDraw({ now: t, ...calm, animating: true }), true)
})

test('gate: a moving camera keeps the full frame rate, even under reduced motion', () => {
  const g = createDrawGate()
  for (let t = 0; t < 200; t += 16) assert.equal(g.shouldDraw({ now: t, stamp: 1, reducedMotion: true, animating: false, moving: true }), true)
  assert.equal(g.shouldDraw({ now: 216, stamp: 1, reducedMotion: true, animating: false, moving: false }), false)
})

test('gate: under reduced motion the scene is redrawn on change, with a slow heartbeat', () => {
  const g = createDrawGate()
  const frozen = { stamp: 7, reducedMotion: true, animating: true }
  assert.equal(g.shouldDraw({ now: 0, ...frozen }), true)
  for (let t = 16; t < FROZEN_FRAME_MS; t += 16) assert.equal(g.shouldDraw({ now: t, ...frozen }), false, `t=${t}`)
  assert.equal(g.shouldDraw({ now: FROZEN_FRAME_MS, ...frozen }), true)
  assert.equal(g.shouldDraw({ now: FROZEN_FRAME_MS + 16, ...frozen, stamp: 8 }), true)
})

test('gate: an interaction wakes the loop for a second, invalidate forces one frame', () => {
  const g = createDrawGate()
  g.shouldDraw({ now: 0, ...calm })
  g.wake()
  assert.equal(g.shouldDraw({ now: 20, ...calm }), true)
  assert.equal(g.shouldDraw({ now: 40, ...calm }), true)
  assert.equal(g.shouldDraw({ now: 20 + INTERACTION_HOLD_MS - 1, ...calm }), true)
  assert.equal(g.shouldDraw({ now: 20 + INTERACTION_HOLD_MS, ...calm }), false, 'the hold is over')
  g.invalidate()
  assert.equal(g.shouldDraw({ now: 22 + INTERACTION_HOLD_MS, ...calm }), true)
})

test('stamp: mixing different values gives different fingerprints, and is stable', () => {
  const a = mixStamp(mixStamp(1, 10), 20)
  assert.equal(a, mixStamp(mixStamp(1, 10), 20))
  assert.notEqual(a, mixStamp(mixStamp(1, 10), 21))
  assert.notEqual(mixStamp(1, 0.5), mixStamp(1, 0.6))
  assert.doesNotThrow(() => mixStamp(1, NaN))
})

test('cull: the view rectangle follows pan and zoom and includes the margin', () => {
  const v = viewRectFor({ x: 0, y: 0, scale: 1 }, 800, 600)!
  assert.deepEqual(v, { minX: -CULL_MARGIN_PX, minY: -CULL_MARGIN_PX, maxX: 800 + CULL_MARGIN_PX, maxY: 600 + CULL_MARGIN_PX })
  const z = viewRectFor({ x: -2000, y: -1000, scale: 2 }, 800, 600, 0)!
  assert.deepEqual(z, { minX: 1000, minY: 500, maxX: 1400, maxY: 800 })
  assert.equal(viewRectFor({ x: 0, y: 0, scale: 1 }, 0, 600), undefined)
})

test('cull: boxes and points outside the view are rejected, partly visible ones kept, no view keeps everything', () => {
  const v = viewRectFor({ x: 0, y: 0, scale: 1 }, 800, 600, 0)!
  assert.equal(pointInView(v, 400, 300, 10), true)
  assert.equal(pointInView(v, 5000, 300, 10), false)
  assert.equal(pointInView(v, 805, 300, 10), true)
  assert.equal(boxInView(v, 900, 0, 1000, 100), false)
  assert.equal(boxInView(v, 700, 500, 1000, 900), true)
  assert.equal(boxInView(v, -500, -500, -1, -1), false)
  assert.equal(pointInView(undefined, 1e9, 1e9, 1), true)
  assert.equal(boxInView(undefined, 1e9, 1e9, 1e9, 1e9), true)
})
