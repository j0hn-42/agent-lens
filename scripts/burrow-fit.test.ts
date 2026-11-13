/**
 * Burrow view: the stage (560x315 picture) is fitted to the area the panels leave free, not to the whole scene.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fitStage } from '../web/lib/burrow/burrow-fit'

const MAP = { w: 560, h: 315 }
const NONE = { top: 0, right: 0, bottom: 0, left: 0 }

const inside = (f: { left: number; top: number; width: number; height: number }, r: { x: number; y: number; w: number; h: number }): boolean =>
  f.left >= r.x && f.top >= r.y && f.left + f.width <= r.x + r.w && f.top + f.height <= r.y + r.h

test('without panels the stage fills the scene as before, centred', () => {
  const f = fitStage({ w: 1120, h: 900 }, NONE, MAP)
  assert.ok(f)
  assert.equal(f.scale, 2)
  assert.equal(f.width, 1120)
  assert.equal(f.height, 630)
  assert.equal(f.left, 0)
  assert.equal(f.top, 135)
})

test('an open dock on the right: the stage stays left of it (the Library and the Laboratory are not covered)', () => {
  const f = fitStage({ w: 1600, h: 900 }, { ...NONE, right: 480 }, MAP)
  assert.ok(f)
  assert.ok(inside(f, { x: 0, y: 0, w: 1120, h: 900 }), JSON.stringify(f))
  assert.equal(f.scale, 2)
})

test('the top bar and the control bar: the stage sits between them', () => {
  const f = fitStage({ w: 1600, h: 900 }, { ...NONE, top: 64, bottom: 120 }, MAP)
  assert.ok(f)
  assert.ok(inside(f, { x: 0, y: 64, w: 1600, h: 716 }), JSON.stringify(f))
  // height-bound: the whole free height is used, centred across
  assert.ok(Math.abs(f.height - 716) <= 1)
  assert.ok(Math.abs(f.left - (1600 - f.width) / 2) <= 1)
})

test('the picture keeps its 16:9 shape and whole-pixel position', () => {
  for (const [w, h, ins] of [[1013, 777, { top: 61.5, right: 333.3, bottom: 97.2, left: 0 }], [700, 1200, NONE], [1919, 1079, { top: 70, right: 0, bottom: 50, left: 13 }]] as const) {
    const f = fitStage({ w, h }, ins, MAP)
    assert.ok(f)
    assert.ok(Math.abs(f.width / f.height - MAP.w / MAP.h) < 0.01, `${f.width}x${f.height}`)
    assert.ok(Number.isInteger(f.left) && Number.isInteger(f.top) && Number.isInteger(f.width) && Number.isInteger(f.height))
    assert.equal(f.width, Math.floor(MAP.w * f.scale))
  }
})

test('panels that would leave almost nothing are shrunk: the stage stays in the scene and visible', () => {
  const f = fitStage({ w: 800, h: 450 }, { top: 300, right: 700, bottom: 300, left: 200 }, MAP)
  assert.ok(f)
  assert.ok(f.width >= 160 && f.height >= 90, JSON.stringify(f))
  assert.ok(inside(f, { x: 0, y: 0, w: 800, h: 450 }), JSON.stringify(f))
})

test('never smaller than half size: a tiny scene shows part of the picture, centred on the free area', () => {
  const f = fitStage({ w: 200, h: 100 }, NONE, MAP)
  assert.ok(f)
  assert.equal(f.scale, 0.5)
  assert.equal(f.width, 280)
  assert.equal(f.left, -40)
})

test('unusable insets are ignored, an empty scene has no fit', () => {
  const f = fitStage({ w: 1120, h: 630 }, { top: Number.NaN, right: -50, bottom: Infinity, left: 0 }, MAP)
  assert.deepEqual(f, { scale: 2, left: 0, top: 0, width: 1120, height: 630 })
  assert.equal(fitStage({ w: 0, h: 500 }, NONE, MAP), null)
  assert.equal(fitStage({ w: 500, h: -1 }, NONE, MAP), null)
})
