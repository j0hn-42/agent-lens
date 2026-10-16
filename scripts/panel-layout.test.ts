import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDockLayout, clampDockWidth, leftPanelWidthBounds, clampLeftPanelWidth, dockWidthForKey, dockWidthForDrag, dockWidthBounds, placePopup,
  intersects, bottom, right, createDockStore, OBSTACLE_SELECTORS, SHEET_BREAKPOINT, SHEET_NOTICE_H, MIN_MAIN_H, RIGHT_DOCK, freeIntervals, findFreeSpot,
  topbarStack, TOPBAR_STACK_TOP, TOPBAR_STACK_GAP, BANNER_MIN_TOP,
  type PanelId, type Rect, type DockEnv, type DockLayout,
} from '../web/lib/panel-layout'

const VIEWPORTS: Array<[number, number]> = [[1600, 900], [1280, 720], [1024, 640], [390, 844], [899, 700], [900, 640]]
const PANELS: PanelId[] = ['detail', 'system', 'link', 'files', 'conversation', 'timeline']
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
      // #410: the band for the "N panels hidden" notice is kept free under the top bar (when there is room for it)
      if (l.hidden.length > 0 && l.area.h - SHEET_NOTICE_H >= MIN_MAIN_H) {
        assert.ok(placed[0][1].y >= TOPBAR_H + SHEET_NOTICE_H, `${label}: the sheet starts below the notice band`)
      }
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

test('System docks in the left column, below the agent card', () => {
  const l = layoutFor(1600, 900, ['detail', 'system'], [])
  assert.equal(l.mode, 'dock')
  const { detail, system } = l.rects as Record<string, Rect>
  assert.ok(system, 'System has a rect')
  assert.ok(!intersects(detail, system))
  assert.equal(system.x, detail.x, 'same column')
  assert.ok(system.y >= bottom(detail) + 8, 'below the card')
  assert.ok(system.h >= 120)
})

test('System alone takes the top of the left column and its width is reserved for the Sessions list', () => {
  const l = layoutFor(1600, 900, ['system'], [])
  assert.equal(l.mode, 'dock')
  assert.equal(l.rects.system!.x, 12)
  assert.equal(l.rects.system!.y, l.area.y)
  assert.equal(leftPanelWidthBounds(1600, ['system'], 380).max, 1600 - 24 - 240 - 8)
})

test('System is a full-width sheet on a narrow viewport', () => {
  const l = layoutFor(390, 844, ['system'], [])
  assert.equal(l.mode, 'sheet')
  assert.equal(l.sheetReason, 'narrow')
  assert.ok(l.rects.system)
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
  // #410: a band under the top bar is kept for the "N panels hidden" notice, so the sheet never sits under it
  assert.equal(r.y, TOPBAR_H + SHEET_NOTICE_H)
  assert.equal(bottom(r), 844 - 16 - BAR_H - 8)
})

test('the band follows the measured height of the notice, never below the minimum (#410)', () => {
  const at = (noticeH?: number) => computeDockLayout({ viewport: { w: 320, h: 700 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['detail', 'timeline', 'files'], noticeH }).rects.files!
  assert.equal(at(undefined).y, TOPBAR_H + SHEET_NOTICE_H)
  assert.equal(at(20).y, TOPBAR_H + SHEET_NOTICE_H)
  assert.equal(at(90).y, TOPBAR_H + 90 + 4)
})

test('no band when the area is too short to keep a usable sheet (#410)', () => {
  const l = computeDockLayout({ viewport: { w: 390, h: 200 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['detail', 'files'] })
  assert.equal(l.mode, 'sheet')
  assert.ok(l.rects.files!.h > 0)
  assert.equal(l.rects.files!.y, l.area.y)
})

test('a lone sheet keeps the whole area: no notice band when nothing is hidden (#410)', () => {
  const l = layoutFor(390, 844, ['files'], [])
  assert.deepEqual(l.hidden, [])
  assert.equal(l.rects.files!.y, TOPBAR_H)
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

test('left panel (Sessions): grows to the free room, never into the right dock nor the agent card', () => {
  for (const [w, h] of VIEWPORTS.filter(([vw]) => vw >= SHEET_BREAKPOINT)) {
    for (const open of subsets(PANELS)) {
      const layout = computeDockLayout({ viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, open, rightWidth: RIGHT_DOCK.default })
      const { min, max } = leftPanelWidthBounds(w, open, layout.rightWidth)
      assert.ok(min <= max && max <= w - 24, `${w}: bounds ${min}..${max}`)
      const sessions: Rect = { x: 12, y: TOPBAR_H, w: max, h: 400 }
      for (const id of ['link', 'files', 'conversation'] as const) {
        const r = layout.rects[id]
        if (r && layout.mode === 'dock') assert.ok(!intersects(sessions, r), `${w}x${h} [${open}]: sessions ${max}px overlaps ${id}`)
      }
      if (open.includes('detail') && max > 0) assert.ok(w - 12 - max >= 240, `${w}: the agent card keeps its room`)
    }
  }
})

test('left panel (Sessions): the whole width when nothing is open, minus the right dock and the card otherwise', () => {
  assert.equal(leftPanelWidthBounds(1600, [], 380).max, 1600 - 24)
  assert.equal(leftPanelWidthBounds(1600, ['conversation'], 380).max, 1600 - 24 - 380 - 8)
  assert.equal(leftPanelWidthBounds(1600, ['conversation', 'detail'], 380).max, 1600 - 24 - 380 - 8 - 240 - 8)
  assert.deepEqual(leftPanelWidthBounds(700, ['files'], 380), dockWidthBounds(700))
  assert.equal(leftPanelWidthBounds(900, ['files'], 540).min, 280 > 900 - 24 - 548 ? 900 - 24 - 548 : 280)
  assert.equal(clampLeftPanelWidth(NaN, 480, { min: 280, max: 900 }), 480)
  assert.equal(clampLeftPanelWidth(5000, 480, { min: 280, max: 900 }), 900)
})

test('permission cards are an obstacle: the right dock is placed below them, whatever the top bar height (#370)', () => {
  assert.ok((OBSTACLE_SELECTORS as readonly string[]).includes('[data-permission-requests]'))
  const cards: Rect = { x: 1600 - 12 - 448, y: TOPBAR_H, w: 448, h: 200 }
  const layout = computeDockLayout({ viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['conversation'], obstacles: [cards] })
  assert.equal(layout.mode, 'dock')
  assert.ok(!intersects(layout.rects.conversation!, cards))
  assert.ok(layout.rects.conversation!.y >= bottom(cards))
})

// #453: the truncation banner sits under the hidden-panels notice, in one column under the top bar, and a sheet
// keeps their measured height free (the banner used to cover the notice and the top of the sheet below 900 px).
const sheetAt = (w: number, h: number, open: PanelId[], noticeH?: number, bannerH?: number, obstacles: Rect[] = []) =>
  computeDockLayout({ viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, open, noticeH, bannerH, obstacles })

test('topbarStack: the banner goes under the notice, never above its own slot, and the band ends under the lower one (#453)', () => {
  assert.deepEqual(topbarStack(0, 0, 0), { bannerTop: null, band: 0 }, 'nothing drawn: no band')
  assert.deepEqual(topbarStack(2, 55, 0), { bannerTop: null, band: TOPBAR_STACK_TOP + 55 + 2 })
  assert.deepEqual(topbarStack(1, 0, 0), { bannerTop: null, band: SHEET_NOTICE_H }, 'the notice keeps its minimum height')
  assert.deepEqual(topbarStack(0, 0, 30), { bannerTop: BANNER_MIN_TOP, band: BANNER_MIN_TOP + 30 + 2 }, 'alone, the banner keeps its slot')
  const both = topbarStack(2, 55, 78)
  assert.equal(both.bannerTop, TOPBAR_STACK_TOP + 55 + TOPBAR_STACK_GAP, 'right under the notice')
  assert.equal(both.band, both.bannerTop! + 78 + 2)
  assert.ok(topbarStack(1, 40, 30).bannerTop! >= BANNER_MIN_TOP)
  assert.deepEqual(topbarStack(1, NaN, NaN), topbarStack(1, 0, 0), 'unmeasured values count as nothing drawn')
})

test('sheet + banner: the sheet starts under the banner, the banner under the notice, at 320, 390, 600 and 899 px (#453)', () => {
  for (const w of [320, 390, 600, 899]) {
    for (const [noticeH, bannerH] of [[40, 38], [55, 78], [40, 46]] as const) {
      const l = sheetAt(w, 844, ['detail', 'timeline', 'files'], noticeH, bannerH)
      const s = topbarStack(l.hidden.length, noticeH, bannerH)
      const noticeBottom = TOPBAR_H + TOPBAR_STACK_TOP + noticeH
      const bannerTop = TOPBAR_H + s.bannerTop!
      assert.equal(l.mode, 'sheet')
      assert.ok(bannerTop >= noticeBottom + TOPBAR_STACK_GAP, `${w}px: the banner does not cover the notice`)
      assert.ok(l.rects.files!.y >= bannerTop + bannerH, `${w}px: the sheet starts under the banner (${l.rects.files!.y} < ${bannerTop + bannerH})`)
    }
  }
})

test('a lone sheet keeps a band for the banner, none without it (#453)', () => {
  assert.equal(sheetAt(390, 844, ['detail'], 0, 0).rects.detail!.y, TOPBAR_H)
  const l = sheetAt(390, 844, ['detail'], 0, 46)
  assert.ok(l.rects.detail!.y >= TOPBAR_H + BANNER_MIN_TOP + 46, 'the card sheet does not slide under the banner')
})

test('a no-room sheet (wide viewport) keeps the band for the banner too (#453)', () => {
  const banner: Rect = { x: 300, y: TOPBAR_H + BANNER_MIN_TOP, w: 400, h: 30 }
  const wall: Rect = { x: 0, y: TOPBAR_H, w: 1000, h: 400 }
  const l = sheetAt(1000, 640, ['files'], 0, 30, [wall, banner])
  assert.equal(l.sheetReason, 'no-room')
  assert.ok(l.rects.files!.y >= bottom(banner))
})

test('no band when the stack would leave no usable sheet, banner included (#453)', () => {
  // Area of 220 px: room for the notice band alone (44), not for the notice and a 120 px banner (168)
  const l = sheetAt(390, TOPBAR_H + 220 + 16 + BAR_H + 8, ['detail', 'files'], 40, 120)
  assert.equal(l.area.h, 220)
  assert.equal(l.rects.files!.y, l.area.y)
})

test('store: a measured banner re-flows the sheet (#453)', () => {
  let env = fakeEnv({ viewport: { w: 390, h: 844 } })
  const store = createDockStore(() => env)
  store.setOpen('detail', true)
  assert.equal(store.getSnapshot().layout.rects.detail!.y, TOPBAR_H)
  env = fakeEnv({ viewport: { w: 390, h: 844 }, bannerH: 46 })
  store.measure()
  assert.ok(store.getSnapshot().layout.rects.detail!.y >= TOPBAR_H + BANNER_MIN_TOP + 46)
})
