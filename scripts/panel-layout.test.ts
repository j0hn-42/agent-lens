import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDockLayout, clampDockWidth, dockWidthForKey, dockWidthForDrag, dockWidthBounds, placePopup,
  intersects, bottom, right, createDockStore, SHEET_BREAKPOINT, RIGHT_DOCK, freeIntervals, findFreeSpot,
  type PanelId, type Rect, type DockEnv, type DockLayout,
} from '../web/lib/panel-layout'

const VIEWPORTS: Array<[number, number]> = [[1600, 900], [1280, 720], [1024, 640], [390, 844], [899, 700], [900, 640]]
const PANELS: PanelId[] = ['detail', 'link', 'files', 'conversation', 'timeline']
const TOPBAR_H = 68
const BAR_H = 56

/** Every subset of the docked panels (including the empty one). */
function subsets<T>(items: T[]): T[][] {
  return items.reduce<T[][]>((acc, it) => acc.concat(acc.map(s => [...s, it])), [[]])
}

/** Panels owned by other modules, as they are placed by their own CSS. */
function obstacleSets(w: number, h: number): Array<{ name: string; rects: Rect[] }> {
  const feed: Rect = { x: 12, y: TOPBAR_H + 8, w: Math.min(320, w - 24), h: 420 }
  const pill: Rect = { x: 12, y: TOPBAR_H + 8, w: Math.min(300, w - 24), h: 40 }
  const chat: Rect = { x: w - 12 - 300, y: h - 64 - 360, w: 300, h: 360 }
  return [
    { name: 'none', rects: [] },
    { name: 'feed pill', rects: [pill] },
    { name: 'feed expanded', rects: [feed] },
    { name: 'feed expanded + chat', rects: [feed, chat] },
    { name: 'feed pill + chat', rects: [pill, chat] },
  ]
}

function layoutFor(w: number, h: number, open: PanelId[], obstacles: Rect[], rightWidth?: number): DockLayout {
  return computeDockLayout({ viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, open, obstacles, rightWidth })
}

function assertGeometry(l: DockLayout, w: number, h: number, open: PanelId[], obstacles: Rect[], label: string) {
  const placed = Object.entries(l.rects) as Array<[PanelId, Rect]>
  const barTop = h - 16 - BAR_H
  for (const [id, r] of placed) {
    assert.ok(r.w > 0 && r.h > 0, `${label}: ${id} has an empty rect`)
    assert.ok(r.x >= 0 && r.y >= TOPBAR_H && right(r) <= w && bottom(r) <= barTop, `${label}: ${id} leaves the free band ${JSON.stringify(r)}`)
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(!intersects(placed[i][1], placed[j][1]), `${label}: ${placed[i][0]} overlaps ${placed[j][0]}`)
    }
  }
  if (l.mode === 'dock') {
    for (const [id, r] of placed) {
      for (const o of obstacles) assert.ok(!intersects(r, o), `${label}: ${id} covers a foreign panel ${JSON.stringify(o)}`)
    }
    assert.deepEqual(l.hidden, [])
    assert.deepEqual(Object.keys(l.rects).sort(), [...new Set(open)].sort(), `${label}: every open panel is placed`)
  } else {
    assert.ok(placed.length <= 1, `${label}: a sheet shows one panel at a time`)
    if (open.length) {
      assert.equal(placed[0][0], open[open.length - 1], `${label}: the newest panel is the sheet`)
      assert.equal(l.hidden.length, open.length - 1)
    }
  }
}

test('no two open panels overlap, none covers the bars or a foreign panel (all viewports x all panel subsets x obstacles)', () => {
  let docked = 0
  let total = 0
  for (const [w, h] of VIEWPORTS) {
    for (const { name, rects } of obstacleSets(w, h)) {
      for (const open of subsets(PANELS)) {
        const label = `${w}x${h} [${open.join(',') || 'none'}] + ${name}`
        const l = layoutFor(w, h, open, rects)
        assertGeometry(l, w, h, open, rects, label)
        total++
        if (l.mode === 'dock' && open.length > 0) docked++
        if (w < SHEET_BREAKPOINT && open.length) assert.equal(l.mode, 'sheet', `${label}: narrow viewports use sheets`)
      }
    }
  }
  assert.ok(total > 600)
  assert.ok(docked > 100, `docking must really happen (got ${docked} docked layouts)`)
})

test('wide viewports dock the usual combination: card + files + timeline next to the feed and the chat', () => {
  const [feed, chat] = [obstacleSets(1600, 900)[3].rects[0], obstacleSets(1600, 900)[3].rects[1]]
  const l = layoutFor(1600, 900, ['detail', 'files', 'timeline'], [feed, chat])
  assert.equal(l.mode, 'dock')
  const { detail, files, timeline } = l.rects as Record<string, Rect>
  // the card is under the feed (the bug of #32: it used to start at max(100, ...) inside the feed)
  assert.ok(detail.y >= bottom(feed) + 8 || detail.x >= right(feed) + 8)
  assert.ok(files.x + files.w <= 1600 - 12)
  assert.equal(files.w, 380)
  assert.ok(bottom(timeline) <= 900 - 16 - BAR_H - 8)
})

test('the card does not start inside the expanded feed even at 720px high', () => {
  const feed = obstacleSets(1280, 720)[2].rects[0]
  const l = layoutFor(1280, 720, ['detail'], [feed])
  assert.equal(l.mode, 'dock')
  assert.ok(!intersects(l.rects.detail!, feed))
})

test('the timeline narrows beside the chat instead of overlapping it (#32: chat vs timeline under ~1100px)', () => {
  const chat: Rect = { x: 1024 - 12 - 300, y: 640 - 64 - 360, w: 300, h: 360 }
  const l = layoutFor(1024, 640, ['timeline'], [chat])
  assert.equal(l.mode, 'dock')
  assert.ok(!intersects(l.rects.timeline!, chat))
  assert.ok(l.rects.timeline!.w >= 280)
})

test('below 900px every panel is a full-width sheet between the bars, newest open wins', () => {
  const l = layoutFor(390, 844, ['detail', 'timeline', 'files'], [])
  assert.equal(l.mode, 'sheet')
  assert.equal(l.sheetReason, 'narrow')
  assert.deepEqual(Object.keys(l.rects), ['files'])
  assert.deepEqual(l.hidden, ['detail', 'timeline'])
  const r = l.rects.files!
  assert.equal(r.x, 8)
  assert.equal(r.w, 390 - 16)
  assert.equal(r.y, TOPBAR_H)
  assert.equal(bottom(r), 844 - 16 - BAR_H - 8)
})

test('a layout that cannot fit falls back to a sheet instead of overlapping', () => {
  const wall: Rect = { x: 0, y: TOPBAR_H, w: 1000, h: 400 }
  const l = layoutFor(1000, 640, ['files'], [wall])
  assert.equal(l.mode, 'sheet')
  assert.equal(l.sheetReason, 'no-room')
})

test('the right dock follows the requested width, clamped', () => {
  assert.equal(layoutFor(1600, 900, ['files'], [], 500).rects.files!.w, 500)
  assert.equal(layoutFor(1600, 900, ['files'], [], 5000).rects.files!.w, dockWidthBounds(1600).max)
  assert.equal(layoutFor(1600, 900, ['files'], [], 10).rects.files!.w, RIGHT_DOCK.min)
})

test('clampDockWidth and key / drag resizing', () => {
  assert.equal(clampDockWidth(380, 1600), 380)
  assert.equal(clampDockWidth(100, 1600), RIGHT_DOCK.min)
  assert.equal(clampDockWidth(5000, 1600), 720)
  assert.equal(clampDockWidth(5000, 1000), 600, 'never more than 60% of the viewport')
  assert.equal(clampDockWidth(Number.NaN, 1600), RIGHT_DOCK.default)
  assert.equal(dockWidthForKey(380, 'ArrowLeft', false, 1600), 396)
  assert.equal(dockWidthForKey(380, 'ArrowLeft', true, 1600), 444)
  assert.equal(dockWidthForKey(380, 'ArrowRight', false, 1600), 364)
  assert.equal(dockWidthForKey(380, 'ArrowRight', true, 1600), 316)
  assert.equal(dockWidthForKey(RIGHT_DOCK.min, 'ArrowRight', true, 1600), RIGHT_DOCK.min)
  assert.equal(dockWidthForKey(380, 'Home', false, 1600), RIGHT_DOCK.min)
  assert.equal(dockWidthForKey(380, 'End', false, 1600), 720)
  assert.equal(dockWidthForKey(380, 'a', false, 1600), null)
  // dragging left widens the dock
  assert.equal(dockWidthForDrag(380, 1000, 900, 1600), 480)
  assert.equal(dockWidthForDrag(380, 1000, 1100, 1600), 280)
})

test('popups stay inside the viewport and between the bars', () => {
  for (const [w, h] of VIEWPORTS) {
    const env = { viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H }
    for (const anchor of [{ x: 0, y: 0 }, { x: w, y: h }, { x: w / 2, y: h / 2 }, { x: -50, y: 9999 }]) {
      const p = placePopup(anchor, { w: 320, h: 200 }, env)
      const label = `${w}x${h} @${anchor.x},${anchor.y}`
      assert.ok(p.left >= 8 && p.left + p.width <= w - 8, `${label}: x`)
      assert.ok(p.top >= TOPBAR_H, `${label}: under the top bar`)
      assert.ok(p.top + Math.min(200, p.maxHeight) <= h - 16 - BAR_H - 8, `${label}: above the control bar`)
    }
  }
})

test('freeIntervals / findFreeSpot', () => {
  const blockers: Rect[] = [{ x: 0, y: 100, w: 100, h: 100 }]
  assert.deepEqual(freeIntervals(blockers, 0, 100, 0, 500), [[0, 92], [208, 500]])
  assert.equal(findFreeSpot(50, 50, { x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 100, h: 100 }]), null)
})

function fakeEnv(over: Partial<DockEnv> = {}): DockEnv {
  return { viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, obstacles: [], ...over }
}

test('store: panels register, the snapshot is stable until something changes, and obstacles re-flow the card', () => {
  let env = fakeEnv()
  const store = createDockStore(() => env)
  let notified = 0
  const unsub = store.subscribe(() => { notified++ })
  const first = store.getSnapshot()
  assert.equal(store.getSnapshot(), first)
  store.setOpen('detail', true)
  const withCard = store.getSnapshot()
  assert.notEqual(withCard, first)
  assert.ok(withCard.layout.rects.detail)
  store.setOpen('detail', true)
  assert.equal(store.getSnapshot(), withCard, 'registering twice changes nothing')
  const topBefore = withCard.layout.rects.detail!.y
  env = fakeEnv({ obstacles: [{ x: 12, y: TOPBAR_H + 8, w: 320, h: 420 }] })
  store.measure()
  assert.ok(store.getSnapshot().layout.rects.detail!.y >= topBefore)
  assert.ok(!intersects(store.getSnapshot().layout.rects.detail!, { x: 12, y: TOPBAR_H + 8, w: 320, h: 420 }))
  store.setRightWidth(500)
  assert.equal(store.getRightWidth(), 500)
  store.setOpen('files', true)
  assert.equal(store.getSnapshot().layout.rects.files!.w, 500)
  store.setOpen('detail', false)
  assert.equal(store.getSnapshot().layout.rects.detail, undefined)
  assert.ok(notified >= 4)
  unsub()
})
