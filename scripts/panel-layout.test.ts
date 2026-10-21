import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDockLayout, clampDockWidth, leftPanelWidthBounds, clampLeftPanelWidth, dockWidthForKey, dockWidthForDrag, dockWidthBounds, placePopup,
  leftDockWidthBounds, leftHeightBounds, DETAIL_SIZE, SYSTEM_SIZE,
  intersects, bottom, right, createDockStore, OBSTACLE_SELECTORS, SHEET_BREAKPOINT, SHEET_NOTICE_H, MIN_MAIN_H, RIGHT_DOCK, freeIntervals, findFreeSpot,
  topbarStack, permissionsBand, POPUP_MIN_H, TOPBAR_STACK_TOP, TOPBAR_STACK_GAP, BANNER_MIN_TOP,
  type PanelId, type Rect, type DockEnv, type DockLayout,
} from '../web/lib/panel-layout'
import { DEFAULT_UI_PREFS, sanitizePref } from '../web/lib/ui-preferences'

const VIEWPORTS: Array<[number, number]> = [[1600, 900], [1280, 720], [1024, 640], [390, 844], [899, 700], [900, 640], [320, 568], [640, 360], [640, 300]]
const PANELS: PanelId[] = ['detail', 'system', 'link', 'files', 'conversation', 'timeline']
const TOPBAR_H = 68
const BAR_H = 56
/** Height the cards' title and intro take, as measureDockEnv reads it (#536) */
const HEAD_H = 62
/** Narrowest column beside the cards and smallest height under them that placePopup uses (#558, panel-layout.ts) */
const POPUP_MIN_W = 160
const POPUP_FIT_MIN_H = 64

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
  assert.equal(leftPanelWidthBounds(1600, ['system'], 380, l.leftWidth).max, 1600 - 24 - l.leftWidth - 8)
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

test('popups never cover the permission cards under the top bar (#410)', () => {
  for (const [w, h] of VIEWPORTS) {
    // Cards as drawn by CSS: right-3, width min(28rem, 100% - 1.5rem), so they span the right part of the canvas
    const permissionsW = Math.min(448, w - 24)
    const permissionsX = w - 12 - permissionsW
    for (const permissionsH of [0, 120, 260]) {
      const env = { viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, permissionsH, permissionsHeadH: permissionsH > 0 ? Math.min(HEAD_H, permissionsH) : 0, permissionsX, permissionsW }
      const slot = TOPBAR_H + (permissionsH > 0 ? permissionsH + 4 : 0)
      const barTop = h - 16 - BAR_H - 8
      for (const anchor of [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h / 2 }]) {
        const p = placePopup(anchor, { w: 320, h: 200 }, env)
        const label = `${w}x${h} perm=${permissionsH} @${anchor.x},${anchor.y}`
        const overCards = p.left < permissionsX + permissionsW && p.left + p.width > permissionsX
        assert.ok(p.maxHeight > 0, `${label}: the popup keeps a usable height (${p.maxHeight})`)
        assert.ok(p.top + Math.min(200, p.maxHeight) <= Math.max(barTop, p.top), `${label}: above the control bar`)
        const box = { x: p.left, y: p.top, w: p.width, h: Math.min(200, p.maxHeight) }
        const cardsBox = { x: permissionsX, y: TOPBAR_H, w: permissionsW, h: permissionsH }
        if (overCards && barTop - slot >= POPUP_MIN_H) assert.ok(p.top >= Math.min(slot, h), `${label}: under the cards (top ${p.top} < ${slot})`)
        if (!p.coversCards) {
          // #558: off the cards (under or beside them), with at least a header and a line
          if (permissionsH > 0) assert.equal(intersects(box, cardsBox), false, `${label}: popup ${JSON.stringify(box)} over the cards`)
          assert.ok(p.maxHeight >= Math.min(POPUP_FIT_MIN_H, barTop - TOPBAR_H), `${label}: usable height (${p.maxHeight})`)
        } else {
          // The floor only when there is no room under nor beside the cards; their title and intro still win (#536)
          assert.ok(permissionsH > 0 && barTop - slot < POPUP_FIT_MIN_H, `${label}: the floor while there was room under the cards`)
          assert.ok(Math.max(permissionsX - 4 - 8, w - 8 - (permissionsX + permissionsW + 4)) < POPUP_MIN_W, `${label}: the floor while there was room beside the cards`)
          const headEnd = env.permissionsHeadH + 4
          assert.ok(p.maxHeight >= Math.min(POPUP_MIN_H, barTop - TOPBAR_H - headEnd), `${label}: at least the readable floor (${p.maxHeight})`)
        }
        if (overCards && permissionsH > 0 && barTop > TOPBAR_H + env.permissionsHeadH) assert.ok(p.top >= TOPBAR_H + env.permissionsHeadH, `${label}: title and intro of the cards stay clear (top ${p.top})`)
      }
    }
  }
})

test('640x300 (200 % zoom of 1280x600), cards over the whole width: no room under nor beside them, the popup starts under the cards title, which wins over the floor (#536, #558)', () => {
  const [w, h] = [640, 300]
  const env = { viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, permissionsH: 180, permissionsHeadH: HEAD_H, permissionsX: 12, permissionsW: w - 24 }
  const p = placePopup({ x: w / 2, y: 0 }, { w: 320, h: 400 }, env)
  assert.ok(p.top >= TOPBAR_H + HEAD_H, `top ${p.top} is over the title (cards start at ${TOPBAR_H}, head ${HEAD_H})`)
  assert.ok(p.maxHeight > 0, `maxHeight ${p.maxHeight}`)
  assert.equal(p.coversCards, true, 'the popup covers the lower part of the cards')
  const clear = placePopup({ x: w / 2, y: 0 }, { w: 320, h: 400 }, { ...env, permissionsX: undefined, permissionsW: undefined, permissionsH: 0, permissionsHeadH: 0 })
  assert.equal(clear.coversCards, false)
})

test('popups keep a readable height when the cards take the whole column (#410, reflow)', () => {
  // 320x568 and 640x360 (200 % zoom): cards at their 60vh cap, over the whole width (nothing beside them)
  for (const [w, h, expected, covers] of [[320, 568, 75, false], [640, 360, 146, true]] as const) {
    const env = { viewport: { w, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, permissionsH: Math.round(h * 0.6), permissionsHeadH: HEAD_H, permissionsX: 12, permissionsW: w - 24 }
    const p = placePopup({ x: w / 2, y: 0 }, { w: 320, h: 400 }, env)
    // 320x568: 75 px are left under the cards, the popup takes them and scrolls (#558). 640x360: nothing is left, the
    // floor applies, and the cards' title and intro win over it (#536): the popup starts under them
    assert.ok(p.top >= TOPBAR_H + HEAD_H, `${w}x${h}: top ${p.top} is over the title and intro (head ends at ${TOPBAR_H + HEAD_H})`)
    assert.equal(p.maxHeight, expected, `${w}x${h}: maxHeight`)
    assert.equal(p.coversCards, covers, `${w}x${h}: coversCards`)
    if (!covers) assert.ok(p.top >= TOPBAR_H + permissionsBand(env.permissionsH), `${w}x${h}: under the cards (top ${p.top})`)
    assert.ok(p.top + p.maxHeight <= h - 16 - BAR_H - 8, `${w}x${h}: ends above the control bar`)
  }
})

test('a popup never lies over drawn permission cards when there is room beside or under them (#558, measured in Chromium)', () => {
  // Geometry read in the browser (popup-permission.e2e.ts): top bar, control bar, the cards' box and their title + intro
  const cases = [
    { vp: [320, 568], topbarH: 126, controlBarH: 98, cards: { x: 12, w: 296, h: 170, head: 82 } },
    { vp: [640, 360], topbarH: 76, controlBarH: 70, cards: { x: 180, w: 448, h: 108, head: 66 } },
    { vp: [640, 300], topbarH: 76, controlBarH: 70, cards: { x: 180, w: 448, h: 90, head: 66 } },
  ] as const
  for (const c of cases) {
    const [w, h] = c.vp
    const env = { viewport: { w, h }, topbarH: c.topbarH, controlBarH: c.controlBarH, permissionsH: c.cards.h, permissionsHeadH: c.cards.head, permissionsX: c.cards.x, permissionsW: c.cards.w }
    const bottomLimit = h - 16 - c.controlBarH - 8
    for (const size of [{ w: 320, h: 200 }, { w: 300, h: POPUP_MIN_H }]) {
      for (const anchor of [{ x: 0, y: 0 }, { x: w / 2, y: h / 2 }, { x: w, y: h }]) {
        const p = placePopup(anchor, size, env)
        const label = `${w}x${h} ${size.w}x${size.h} @${anchor.x},${anchor.y}`
        const box = { x: p.left, y: p.top, w: p.width, h: Math.min(size.h, p.maxHeight) }
        const cards = { x: c.cards.x, y: c.topbarH, w: c.cards.w, h: c.cards.h }
        assert.equal(intersects(box, cards), false, `${label}: popup ${JSON.stringify(box)} lies over the cards ${JSON.stringify(cards)}`)
        assert.equal(p.coversCards, false, `${label}: coversCards`)
        assert.ok(p.maxHeight >= POPUP_FIT_MIN_H, `${label}: a usable height (${p.maxHeight})`)
        assert.ok(p.left >= 8 && p.left + p.width <= w - 8, `${label}: inside the window`)
        assert.ok(p.top >= c.topbarH && p.top + box.h <= bottomLimit, `${label}: between the bars`)
      }
    }
  }
})

test('popups ignore the card slot where the cards are not (#410, horizontal overlap)', () => {
  const env = { viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, permissionsH: 400, permissionsX: 1600 - 12 - 448, permissionsW: 448 }
  const left = placePopup({ x: 300, y: 0 }, { w: 320, h: 200 }, env)
  assert.equal(left.top, TOPBAR_H, 'left half: not pushed under cards that are on the right')
  const right = placePopup({ x: 1500, y: 0 }, { w: 320, h: 200 }, env)
  assert.ok(right.top >= TOPBAR_H + 400 + 4, 'right: under the cards')
  const unknown = placePopup({ x: 300, y: 0 }, { w: 320, h: 200 }, { ...env, permissionsX: undefined, permissionsW: undefined })
  assert.ok(unknown.top >= TOPBAR_H + 400 + 4, 'unknown extent: the whole width is kept (safe reading)')
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
  assert.equal(leftPanelWidthBounds(1600, ['conversation', 'detail'], 380, 320).max, 1600 - 24 - 380 - 8 - 320 - 8)
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

test('when notice and banner do not both fit, the sheet still keeps the notice band (#453 review)', () => {
  // Area of 220 px: room for the notice band alone (44), not for the notice and a 120 px banner (168)
  const l = sheetAt(390, TOPBAR_H + 220 + 16 + BAR_H + 8, ['detail', 'files'], 40, 120)
  assert.equal(l.area.h, 220)
  assert.equal(l.rects.files!.y, l.area.y + topbarStack(1, 40, 0).band)
  assert.equal(topbarStack(1, 40, 0).band, SHEET_NOTICE_H)
})

// A 320 x 568 phone as measured in a real browser: the top bar wraps to 187 px, the area under it is 276 px
const phone = (open: PanelId[], noticeH: number, bannerH: number) => {
  const l = computeDockLayout({ viewport: { w: 320, h: 568 }, topbarH: 187, controlBarH: 81, open, noticeH, bannerH })
  assert.equal(l.area.h, 276)
  return l
}

test('320 x 568, two panels and a banner: the sheet starts under the notice and the banner (#453 review)', () => {
  const l = phone(['timeline', 'files'], 40, 74)
  const s = topbarStack(1, 40, 74)
  assert.ok(l.rects.files!.y >= l.area.y + TOPBAR_STACK_TOP + 40, `the sheet starts under the notice (${l.rects.files!.y})`)
  assert.ok(l.rects.files!.y >= l.area.y + s.bannerTop! + 74, `the sheet starts under the banner (${l.rects.files!.y})`)
  assert.equal(bottom(l.rects.files!), bottom(l.area), 'the sheet still ends above the control bar')
})

test('320 x 568, agent card alone and a banner: the card sheet does not cover the banner (#453 review)', () => {
  const l = phone(['detail'], 0, 74)
  assert.ok(l.rects.detail!.y >= l.area.y + topbarStack(0, 0, 74).bannerTop! + 74, `card at ${l.rects.detail!.y}`)
  assert.ok(l.rects.detail!.h >= 96, 'the card keeps a usable, scrolling sheet (MIN_SHEET_H_WITH_BANNER)')
})

test('a window too short even for the reduced floor: the notice band is kept, then nothing (#453 review)', () => {
  // Area 200: notice + banner 74 (122) leaves 78, under the reduced floor; the notice alone (44) leaves 156, under MIN_MAIN_H
  const l = sheetAt(390, TOPBAR_H + 200 + 16 + BAR_H + 8, ['timeline', 'files'], 40, 74)
  assert.equal(l.area.h, 200)
  assert.equal(l.rects.files!.y, l.area.y)
  const k = sheetAt(390, TOPBAR_H + 210 + 16 + BAR_H + 8, ['timeline', 'files'], 40, 74)
  assert.equal(k.rects.files!.y, k.area.y + SHEET_NOTICE_H, '210 px: the notice band fits (166 left)')
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

// #410: the permission cards get their own slot at the top of the column under the top bar in a sheet: the notice and
// the banner go under it, the sheet under all of them (the cards used to cover the notice and the top of the sheet).
test('topbarStack: the permission slot comes first, the notice and the banner are pushed under it (#410)', () => {
  assert.deepEqual(topbarStack(0, 0, 0, 0), { bannerTop: null, band: 0 })
  assert.equal(topbarStack(0, 0, 0, 120).band, 120 + TOPBAR_STACK_GAP + 2, 'the slot alone')
  assert.equal(topbarStack(2, 55, 0, 120).band, 120 + TOPBAR_STACK_GAP + TOPBAR_STACK_TOP + 55 + 2, 'notice under the slot')
  const both = topbarStack(2, 55, 78, 120)
  assert.equal(both.bannerTop, 120 + TOPBAR_STACK_GAP + TOPBAR_STACK_TOP + 55 + TOPBAR_STACK_GAP)
  assert.equal(permissionsBand(NaN), 0)
  assert.equal(permissionsBand(-5), 0)
  assert.equal(permissionsBand(120.2), 121 + TOPBAR_STACK_GAP)
  assert.deepEqual(topbarStack(2, 55, 78, 0), topbarStack(2, 55, 78), 'no cards: unchanged')
})

test('sheet + permission cards: the sheet starts under the cards, the notice under the cards, at 320, 390 and 899 px (#410)', () => {
  for (const w of [320, 390, 899]) {
    const l = computeDockLayout({ viewport: { w, h: 844 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['detail', 'files'], noticeH: 40, permissionsH: 150 })
    assert.equal(l.mode, 'sheet')
    assert.equal(l.permissionsBand, permissionsBand(150))
    assert.ok(l.rects.files!.y >= TOPBAR_H + permissionsBand(150) + TOPBAR_STACK_TOP + 40, `${w}px: the sheet starts under cards and notice`)
    assert.ok(bottom(l.rects.files!) <= 844 - 16 - BAR_H - 8 + 0.5)
  }
})

test('sheet + permission cards too tall: the slot is dropped, the sheet keeps its minimum height (#410)', () => {
  const l = computeDockLayout({ viewport: { w: 390, h: 600 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['files'], permissionsH: 400 })
  assert.equal(l.permissionsBand, 0)
  assert.ok(l.rects.files!.h >= MIN_MAIN_H)
})

test('dock mode: no permission slot, the cards stay an obstacle (#410)', () => {
  const l = computeDockLayout({ viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['files'], permissionsH: 150 })
  assert.equal(l.mode, 'dock')
  assert.equal(l.permissionsBand, 0)
})

test('store: a measured permissions height is accepted and does not change a closed layout (#410)', () => {
  const env = createDockStore(() => ({ viewport: { w: 390, h: 800 }, topbarH: TOPBAR_H, controlBarH: BAR_H, obstacles: [], permissionsH: 90 })).getSnapshot()
  assert.equal(env.layout.permissionsBand, 0, 'nothing open: no band')
})

// ─── Left column: user-resizable width and heights ─────────────────────────

/** The column's default width and the narrowest it goes, as computeDockLayout applies them. */
const LEFT_DEFAULT_W = DETAIL_SIZE.w
const LEFT_MIN_W = leftDockWidthBounds(1600).min

test('the left column is larger than its minimum by default: a full agent card and the System gauges fit without scrolling', () => {
  assert.ok(LEFT_DEFAULT_W > LEFT_MIN_W, 'the default width leaves room to narrow the column')
  assert.ok(DETAIL_SIZE.h >= 300 && SYSTEM_SIZE.h >= 360, 'both panels open taller than the old 240 / 280 px slots')
  const l = layoutFor(1600, 900, ['detail', 'system'], [])
  assert.equal(l.leftWidth, LEFT_DEFAULT_W)
  assert.equal(l.rects.detail!.w, LEFT_DEFAULT_W)
  assert.equal(l.rects.system!.w, LEFT_DEFAULT_W)
  assert.equal(l.rects.detail!.h, DETAIL_SIZE.h)
  assert.equal(l.rects.system!.h, SYSTEM_SIZE.h)
})

test('the left column follows the requested width, clamped to the bounds of the viewport', () => {
  const at = (leftWidth: number, w = 1600) =>
    computeDockLayout({ viewport: { w, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['detail', 'system'], leftWidth })
  const wide = at(460)
  assert.equal(wide.leftWidth, 460)
  assert.equal(wide.rects.detail!.w, 460)
  assert.equal(wide.rects.system!.w, 460, 'System follows the card: one column, one width')
  assert.equal(at(5000).leftWidth, leftDockWidthBounds(1600).max)
  assert.equal(at(10).leftWidth, LEFT_MIN_W)
  assert.equal(at(Number.NaN).leftWidth, LEFT_DEFAULT_W, 'a broken stored width falls back to the default')
  // Narrow viewports cap the column, and the minimum always stays reachable
  for (const w of [900, 1024, 1280, 1600, 2560]) {
    const { min, max } = leftDockWidthBounds(w)
    assert.equal(min, LEFT_MIN_W)
    assert.ok(max >= min, `bounds at ${w}`)
    assert.equal(at(max + 100, w).leftWidth, max)
  }
})

test('the agent card and System take the heights the user asked for, shorter rungs when the column is short', () => {
  const at = (h: number, detailHeight: number, systemHeight: number) =>
    computeDockLayout({ viewport: { w: 1600, h }, topbarH: TOPBAR_H, controlBarH: BAR_H, open: ['detail', 'system'], detailHeight, systemHeight })
  const tall = at(1400, 500, 620)
  assert.equal(tall.rects.detail!.h, 500)
  assert.equal(tall.rects.system!.h, 620)
  // A column that cannot hold both at full height keeps both, each on a shorter rung, still not overlapping
  const short = at(700, 500, 620)
  assert.equal(short.mode, 'dock')
  assert.ok(short.rects.detail!.h <= 500 && short.rects.detail!.h >= DETAIL_SIZE.minH)
  assert.ok(short.rects.system!.h >= SYSTEM_SIZE.minH)
  assert.ok(!intersects(short.rects.detail!, short.rects.system!))
  // A height under the panel's minimum, or a broken stored one, is lifted to a readable slot
  const floor = at(1400, 10, 10)
  assert.equal(floor.rects.detail!.h, DETAIL_SIZE.minH)
  assert.equal(floor.rects.system!.h, SYSTEM_SIZE.minH)
  const broken = at(1400, Number.NaN, Number.NaN)
  assert.equal(broken.rects.detail!.h, DETAIL_SIZE.h)
  assert.equal(broken.rects.system!.h, SYSTEM_SIZE.h)
})

test('leftHeightBounds: from the panel minimum up to the height of the dock area', () => {
  assert.deepEqual(leftHeightBounds(640, 160), { min: 160, max: 640 })
  assert.deepEqual(leftHeightBounds(80, 160), { min: 160, max: 160 }, 'an area shorter than the minimum keeps a reachable range')
  assert.deepEqual(leftHeightBounds(Number.NaN, 120), { min: 120, max: 120 })
})

test('store: the left column width and the two heights round-trip and re-flow the layout', () => {
  const env: DockEnv = { viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, obstacles: [] }
  const store = createDockStore(() => env)
  store.setOpen('detail', true)
  store.setOpen('system', true)
  assert.equal(store.getLeftWidth(), LEFT_DEFAULT_W)
  store.setLeftWidth(420)
  assert.equal(store.getLeftWidth(), 420)
  assert.equal(store.getSnapshot().layout.rects.detail!.w, 420)
  store.setLeftWidth(99)
  assert.equal(store.getLeftWidth(), LEFT_MIN_W, 'clamped to the bounds of the viewport')
  store.setLeftHeight('detail', 420)
  store.setLeftHeight('system', 240)
  assert.equal(store.getLeftHeight('detail'), 420)
  assert.equal(store.getSnapshot().layout.rects.detail!.h, 420)
  assert.equal(store.getSnapshot().layout.rects.system!.h, 240)
})

test('the stored sizes of the left column agree with the layout (two modules, one range)', () => {
  assert.equal(DEFAULT_UI_PREFS.dockLeftWidth, LEFT_DEFAULT_W)
  assert.equal(DEFAULT_UI_PREFS.detailPanelHeight, DETAIL_SIZE.h)
  assert.equal(DEFAULT_UI_PREFS.systemPanelHeight, SYSTEM_SIZE.h)
  // A stored size out of range is clamped to the bounds the resizers offer
  assert.equal(sanitizePref('dockLeftWidth', 1e9), leftDockWidthBounds(4000).max)
  assert.equal(sanitizePref('dockLeftWidth', -10), LEFT_MIN_W)
  assert.equal(sanitizePref('detailPanelHeight', -10), Math.min(DETAIL_SIZE.minH, SYSTEM_SIZE.minH))
  assert.equal(sanitizePref('systemPanelHeight', 'tall' as unknown as number), DEFAULT_UI_PREFS.systemPanelHeight)
})

test('the column stops at the room beside the right dock, so widening it never costs the dock its layout', () => {
  // 1200 px with the Conversation panel at its widest: a column of 540 (45 %) left no way to place both,
  // and every panel fell to a full-width sheet — one drag could not be allowed to do that
  const bounds = leftDockWidthBounds(1200, ['conversation', 'detail'], 720)
  assert.equal(bounds.max, 1200 - 2 * 12 - 720 - 8)
  const at = (leftWidth: number) => computeDockLayout({
    viewport: { w: 1200, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H,
    open: ['conversation', 'detail'], leftWidth, rightWidth: 720,
  })
  assert.equal(at(bounds.max).mode, 'dock', 'the widest the grip offers still docks')
  assert.equal(at(bounds.max).rects.detail!.w, bounds.max)
  // Without a right-dock panel open the column keeps the whole viewport range
  assert.equal(leftDockWidthBounds(1200, ['detail'], 720).max, leftDockWidthBounds(1200).max)
  // Below the sheet breakpoint only the viewport applies: the panels are sheets there anyway
  assert.deepEqual(leftDockWidthBounds(800, ['conversation', 'detail'], 720), leftDockWidthBounds(800))
  // The minimum always stays reachable, even where the room is smaller than it (900 x 720: 148 px free)
  assert.equal(leftDockWidthBounds(900, ['files', 'detail'], 720).max, LEFT_MIN_W)
  for (const w of [900, 1024, 1200, 1440, 1600, 2560]) {
    const { min, max } = leftDockWidthBounds(w, ['conversation', 'detail', 'system'], 720)
    assert.ok(max >= min, `bounds stay usable at ${w}`)
  }
})

test('a height grip offers exactly what the column can grant: the wanted height is clipped, never dropped a rung', () => {
  const at = (detailHeight: number, systemHeight: number) => computeDockLayout({
    viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H,
    open: ['detail', 'system'], detailHeight, systemHeight,
  })
  const l = at(300, 300)
  const cap = l.leftHeightCap
  assert.equal(cap.system, l.area.h - 300 - 8, 'System may take what the card leaves under it')
  assert.equal(cap.detail, l.area.h - SYSTEM_SIZE.minH - 8, 'the card may take what System needs free')
  // Asking for more than the cap gives the cap. It used to fall to the next rung of the ladder, so one
  // keyboard step past the room shrank System from 440 to 300 px instead of growing it.
  for (const wanted of [cap.system - 10, cap.system, cap.system + 1, cap.system + 10, 5000]) {
    const drawn = at(300, wanted).rects.system!.h
    assert.equal(drawn, Math.min(wanted, cap.system), `System asked ${wanted}`)
  }
  for (const wanted of [cap.detail, cap.detail + 10, 5000]) {
    assert.equal(at(wanted, 300).rects.detail!.h, cap.detail, `the card asked ${wanted}`)
  }
  // The height a grip reports is the height the panel is drawn at, at every step up to its maximum
  for (const wanted of [200, 300, 400, cap.system]) {
    const shown = at(300, wanted)
    assert.equal(shown.rects.system!.h, Math.min(wanted, shown.leftHeightCap.system))
  }
})

test('the cap of each panel follows the other one: alone in the column, a panel may take the whole band', () => {
  const only = (open: PanelId[], detailHeight?: number) => computeDockLayout({
    viewport: { w: 1600, h: 900 }, topbarH: TOPBAR_H, controlBarH: BAR_H, open, detailHeight,
  })
  const alone = only(['system'])
  assert.equal(alone.leftHeightCap.system, alone.area.h)
  assert.equal(only(['detail']).leftHeightCap.detail, alone.area.h)
  // A taller card leaves System less, and the two caps never ask for more than the band together
  const tall = only(['detail', 'system'], 500)
  assert.equal(tall.leftHeightCap.system, tall.area.h - 500 - 8)
  assert.ok(tall.rects.detail!.h + 8 + tall.leftHeightCap.system <= tall.area.h)
})
