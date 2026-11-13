/**
 * Burrow view: the stage (560x315 picture) is fitted to the area the panels leave free, not to the whole scene.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { burrowLayout, controlColumn, type StageInsets } from '../web/lib/burrow/burrow-fit'

const MAP = { w: 560, h: 315 }
const NONE = { top: 0, right: 0, bottom: 0, left: 0 }
/** The stage of the burrow's layout (landscape in every case below but the portrait ones) */
const fitStage = (c: { w: number; h: number }, ins: StageInsets, map: { w: number; h: number }) => burrowLayout(c, ins, map)?.stage ?? null

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

test('the control column sits left of a docked panel, and keeps usable room when the panel takes most of the scene', () => {
  assert.deepEqual(controlColumn(1200, 400), { right: 408, room: 784 })
  assert.deepEqual(controlColumn(1200, 0), { right: 8, room: 1184 })
  // 320 px wide (200 % zoom of a 640 px window) with a 400 px dock: the column is not pushed off the left edge
  const narrow = controlColumn(320, 400)
  assert.ok(narrow.room >= 176, `room ${narrow.room}`)
  assert.ok(narrow.right + narrow.room <= 320 - 8, 'nothing past the left gutter')
  assert.ok(narrow.right >= 8)
  // a scene narrower than the minimum gives the column the whole width, never a negative room
  assert.deepEqual(controlColumn(150, 400), { right: 8, room: 134 })
  assert.deepEqual(controlColumn(800, Number.NaN), controlColumn(800, 0))
})

test('a wide free area keeps the landscape layout: the stage centred, no list panel', () => {
  for (const [w, h, ins] of [[1600, 900, { ...NONE, top: 64, bottom: 120 }], [1120, 900, NONE], [580, 400, NONE], [700, 1200, NONE]] as const) {
    const l = burrowLayout({ w, h }, ins, MAP)
    assert.ok(l)
    assert.equal(l.list, null, `${w}x${h}`)
  }
  assert.deepEqual(burrowLayout({ w: 700, h: 1200 }, NONE, MAP)?.stage, { scale: 1.25, left: 0, top: 404, width: 700, height: 393 }, 'centred, not at the top')
})

test('a narrow portrait free area (a phone): the stage spans the free width at its top, the list fills the rest below', () => {
  const ins = { ...NONE, top: 60, bottom: 80 }
  const l = burrowLayout({ w: 390, h: 844 }, ins, MAP)
  assert.ok(l)
  assert.ok(l.list, 'a list panel in portrait')
  assert.equal(l.stage.width, 390, 'full free width')
  assert.equal(l.stage.left, 0)
  assert.equal(l.stage.top, 60, 'at the top of the free area, not centred')
  assert.ok(Math.abs(l.stage.width / l.stage.height - MAP.w / MAP.h) < 0.01)
  // the list sits under the stage, inside the free area, and keeps the scene's gutters
  assert.ok(l.list.top >= l.stage.top + l.stage.height, JSON.stringify(l))
  assert.ok(l.list.top + l.list.height <= 844 - 80, JSON.stringify(l))
  assert.ok(l.list.left >= 0 && l.list.left + l.list.width <= 390)
  assert.ok(l.list.height > 200, `room for rows: ${l.list.height}`)
  for (const v of Object.values(l.list)) assert.ok(Number.isInteger(v))
})

test('the free area decides, not the window: a dock that leaves a narrow tall strip switches to portrait, one that leaves a wide strip does not', () => {
  const tall = burrowLayout({ w: 900, h: 1000 }, { ...NONE, right: 420 }, MAP)
  assert.ok(tall?.list, 'a 480 px wide, 1000 px high free area is portrait')
  assert.ok(tall.list.left + tall.list.width <= 480, 'the list stays left of the dock')
  assert.equal(burrowLayout({ w: 900, h: 450 }, { ...NONE, right: 420 }, MAP)?.list, null, '480x450: not taller than wide')
  assert.equal(burrowLayout({ w: 640, h: 1000 }, NONE, MAP)?.list, null, 'not narrower than 600 px')
})

test('portrait without room left under the stage for a row keeps the landscape layout', () => {
  // 200 wide: the stage is drawn at half size (280x157) and leaves too little under it in a 220 px high area
  assert.equal(burrowLayout({ w: 200, h: 220 }, NONE, MAP)?.list, null)
  assert.equal(burrowLayout({ w: 0, h: 500 }, NONE, MAP), null)
})
