/**
 * Dock layout for the floating panels (issue #32).
 *
 * Pure placement functions + a tiny store that measures the environment (viewport, top bar, control
 * bar, panels owned by other modules) and publishes one layout to every docked panel:
 *
 *   - right dock : "link" (stacked on top) then "files" | "conversation" (width = resizable, default 380)
 *   - left dock  : "detail" (agent card), placed below / beside whatever else sits in the left column,
 *                  then "system" (machine health) in the same column, right below the card
 *   - bottom dock: "timeline", centred above the control bar, narrowed by whatever sits beside it
 *   - popups     : clamped to the viewport, between the top bar and the control bar
 *
 * Guarantees (property-tested in scripts/panel-layout.test.ts): in "dock" mode no two placed
 * rectangles intersect, none intersects a foreign obstacle, the top bar or the control bar, and all
 * stay inside the viewport. When a panel cannot be placed, or the viewport is narrower than
 * SHEET_BREAKPOINT, the layout switches to "sheet" mode: only the newest open panel is shown, full
 * width between the bars (it has its own visible close button), the others are `hidden`.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Viewport { w: number; h: number }

export type PanelId = 'detail' | 'system' | 'link' | 'files' | 'conversation' | 'timeline'

/** Below this viewport width panels become full-width sheets (one at a time). */
export const SHEET_BREAKPOINT = 900
/** Minimum band kept under the top bar by a sheet that hides other open panels (the "N panels hidden" notice). */
export const SHEET_NOTICE_H = 44
/** Space between two panels. */
export const DOCK_GAP = 8
/** Space between a panel and the viewport edge. */
export const DOCK_EDGE = 12
/** Space under the control bar (matches its `bottom-4`). */
export const CONTROL_BAR_BOTTOM = 16
export const CONTROL_BAR_MAX_WIDTH = 680
/** Used until the control bar has been measured. */
export const CONTROL_BAR_FALLBACK_H = 56
export const TOPBAR_FALLBACK_H = 60

export const RIGHT_DOCK = { default: 380, min: 280, maxFraction: 0.6, maxPx: 720, step: 16, bigStep: 64 } as const
export const DETAIL_SIZE = { w: 240, h: 240, minH: 120 } as const
const SYSTEM_H = 280
export const LINK_H = 300
export const MIN_MAIN_H = 160
export const TIMELINE_SIZE = { maxW: 700, minW: 280, heights: [360, 280, 200] as readonly number[] }

// ─── Geometry ───────────────────────────────────────────────────────────────

export const right = (r: Rect) => r.x + r.w
export const bottom = (r: Rect) => r.y + r.h

/** Strict overlap (touching edges do not intersect). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)

// ─── Right dock width ───────────────────────────────────────────────────────

export function dockWidthBounds(viewportW: number): { min: number; max: number } {
  const max = Math.max(RIGHT_DOCK.min, Math.min(RIGHT_DOCK.maxPx, Math.floor(viewportW * RIGHT_DOCK.maxFraction)))
  return { min: RIGHT_DOCK.min, max }
}

/** Clamp a right-dock width to [min, max] for this viewport (NaN falls back to the default). */
export function clampDockWidth(width: number, viewportW: number): number {
  const { min, max } = dockWidthBounds(viewportW)
  return Math.round(clamp(finite(width, RIGHT_DOCK.default), min, max))
}

/** Width after a key press on the resize handle; null when the key is not a resize key. */
export function dockWidthForKey(current: number, key: string, shift: boolean, viewportW: number): number | null {
  const step = shift ? RIGHT_DOCK.bigStep : RIGHT_DOCK.step
  const { min, max } = dockWidthBounds(viewportW)
  // The dock hugs the right edge: ArrowLeft moves the handle left, which widens the dock.
  if (key === 'ArrowLeft') return clampDockWidth(current + step, viewportW)
  if (key === 'ArrowRight') return clampDockWidth(current - step, viewportW)
  if (key === 'Home') return min
  if (key === 'End') return max
  return null
}

/** Width while dragging the handle from `startX` (pointer x at drag start) to `x`. */
export function dockWidthForDrag(startWidth: number, startX: number, x: number, viewportW: number): number {
  return clampDockWidth(startWidth + (startX - x), viewportW)
}

// ─── Left panel (Sessions) width ────────────────────────────────────────────

const RIGHT_DOCK_PANELS: readonly PanelId[] = ['link', 'files', 'conversation']

/**
 * Bounds of a panel anchored on the left edge (the Sessions list) that must not run into its
 * neighbours: it may grow up to the free space left of the right dock (when one of its panels is
 * open), and keeps the room the agent card needs beside it while that card is open. Below the sheet
 * breakpoint the generic dock bounds apply (the panel is clamped by the viewport).
 */
export function leftPanelWidthBounds(
  viewportW: number,
  open: readonly PanelId[],
  rightWidth: number,
): { min: number; max: number } {
  if (viewportW < SHEET_BREAKPOINT) return dockWidthBounds(viewportW)
  const rightOpen = open.some(id => RIGHT_DOCK_PANELS.includes(id))
  const reserved = (rightOpen ? rightWidth + DOCK_GAP : 0) + (open.includes('detail') || open.includes('system') ? DETAIL_SIZE.w + DOCK_GAP : 0)
  const max = Math.max(0, Math.floor(viewportW - 2 * DOCK_EDGE - reserved))
  // Never wider than the room, even when the room is smaller than the usual minimum
  return { min: Math.min(RIGHT_DOCK.min, max), max }
}

/** Clamp a left-panel width to its bounds (NaN falls back to the default width). */
export function clampLeftPanelWidth(width: number, fallback: number, bounds: { min: number; max: number }): number {
  return Math.round(clamp(finite(width, fallback), bounds.min, bounds.max))
}

// ─── Free-space search ──────────────────────────────────────────────────────

/** Free vertical intervals of [top, bottom] in the column [x0, x1] once the blockers (+gap) are removed. */
export function freeIntervals(blockers: readonly Rect[], x0: number, x1: number, top: number, bot: number, gap = DOCK_GAP): Array<[number, number]> {
  const col: Rect = { x: x0, y: top, w: x1 - x0, h: Math.max(0, bot - top) }
  const cuts = blockers
    .filter(b => b.w > 0 && b.h > 0 && intersects(col, inflate(b, gap)))
    .map(b => [Math.max(top, b.y - gap), Math.min(bot, bottom(b) + gap)] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  let cursor = top
  for (const [s, e] of cuts) {
    if (s > cursor) out.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (cursor < bot) out.push([cursor, bot])
  return out
}

function fitsIn(r: Rect, area: Rect, blockers: readonly Rect[]): boolean {
  if (r.w <= 0 || r.h <= 0) return false
  if (r.x < area.x || r.y < area.y || right(r) > right(area) || bottom(r) > bottom(area)) return false
  return !blockers.some(b => b.w > 0 && b.h > 0 && intersects(r, inflate(b, DOCK_GAP)))
}

/** First free spot for a w x h box: scanned top to bottom, then left to right, anchored on the blockers. */
export function findFreeSpot(w: number, h: number, area: Rect, blockers: readonly Rect[]): Rect | null {
  const xs = [area.x, ...blockers.map(b => right(b) + DOCK_GAP)]
  const ys = [area.y, ...blockers.map(b => bottom(b) + DOCK_GAP), bottom(area) - h]
  const sortedYs = Array.from(new Set(ys.map(Math.round))).sort((a, b) => a - b)
  const sortedXs = Array.from(new Set(xs.map(Math.round))).sort((a, b) => a - b)
  for (const y of sortedYs) {
    for (const x of sortedXs) {
      const r = { x, y, w, h }
      if (fitsIn(r, area, blockers)) return r
    }
  }
  return null
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export interface DockInput {
  viewport: Viewport
  /** Value of --topbar-h: everything above this y belongs to the top bar. */
  topbarH: number
  controlBarH: number
  /** Open docked panels, oldest first (the newest wins when the layout falls back to a sheet). */
  open: readonly PanelId[]
  rightWidth?: number
  /** Rectangles of panels owned elsewhere (message feed, per-agent chat, ...): never covered. */
  obstacles?: readonly Rect[]
  /** Measured height of the "N panels hidden" notice (0 / unknown until it is drawn). */
  noticeH?: number
  /** Measured height of the truncation banner (0 / absent when none is drawn): a sheet keeps it free (#453). */
  bannerH?: number
  /** Measured height of the permission cards (0 / absent when none is drawn): a sheet keeps a slot for them (#410). */
  permissionsH?: number
}

export interface DockLayout {
  mode: 'dock' | 'sheet'
  /** Why the layout is a sheet (undefined in dock mode). */
  sheetReason?: 'narrow' | 'no-room'
  rects: Partial<Record<PanelId, Rect>>
  /** Open panels not shown (sheet mode keeps only the newest). */
  hidden: PanelId[]
  /** Free band between the top bar and the control bar. */
  area: Rect
  topbar: Rect
  controlBar: Rect
  rightWidth: number
  /** Band a sheet keeps free right under the top bar for the permission cards, 0 in dock mode (#410). */
  permissionsBand: number
}

export function controlBarRect(viewport: Viewport, controlBarH: number): Rect {
  const w = Math.max(0, Math.min(CONTROL_BAR_MAX_WIDTH, viewport.w - 2 * CONTROL_BAR_BOTTOM))
  return { x: Math.round((viewport.w - w) / 2), y: viewport.h - CONTROL_BAR_BOTTOM - controlBarH, w, h: controlBarH }
}

/** Offset of the column under the top bar that holds the hidden-panels notice, then the truncation banner (#453). */
export const TOPBAR_STACK_TOP = 2
/** Space between the notice and the banner in that column. */
export const TOPBAR_STACK_GAP = 4
/** The banner never starts higher than this under the top bar: the history-loading indicator (top bar + 8 px) keeps its slot. */
export const BANNER_MIN_TOP = 44

/**
 * The column under the top bar (#453), as offsets from the bottom of the top bar: where the banner starts (null when
 * none is drawn) and the band it all takes (0 when nothing is drawn). The notice is drawn only when panels are hidden,
 * at least SHEET_NOTICE_H - 4 high; the banner goes right under it, never above its own slot. Heights are the measured
 * ones (an unmeasured or invalid value counts as nothing drawn), so a wrapped line grows the band instead of being cut.
 */
export function topbarStack(hiddenCount: number, noticeH = 0, bannerH = 0, permissionsH = 0): { bannerTop: number | null; band: number } {
  const perm = permissionsBand(permissionsH)
  const notice = hiddenCount > 0 ? Math.max(SHEET_NOTICE_H - 4, Math.ceil(Math.max(0, finite(noticeH, 0)))) : 0
  const banner = Math.ceil(Math.max(0, finite(bannerH, 0)))
  const noticeBottom = notice > 0 ? perm + TOPBAR_STACK_TOP + notice : 0
  const bannerTop = banner > 0 ? (noticeBottom > 0 ? Math.max(BANNER_MIN_TOP, noticeBottom + TOPBAR_STACK_GAP) : perm + BANNER_MIN_TOP) : null
  const lowest = bannerTop !== null ? bannerTop + banner : noticeBottom > 0 ? noticeBottom : perm
  return { bannerTop, band: lowest > 0 ? lowest + 2 : 0 }
}

/**
 * Slot of the permission cards (#410): they sit right under the top bar, so in a sheet they take the top of the column
 * and the notice and the banner go under them. Their measured height plus a gap; 0 when none is drawn or invalid.
 */
export function permissionsBand(permissionsH = 0): number {
  const h = Math.ceil(Math.max(0, finite(permissionsH, 0)))
  return h > 0 ? h + TOPBAR_STACK_GAP : 0
}

/**
 * Smallest sheet left under the column when a truncation banner is drawn (#453): lower than MIN_MAIN_H, so a phone
 * (320 x 568, where the top bar wraps) keeps the banner, the only sign of a partial graph, visible; the sheet scrolls.
 */
const MIN_SHEET_H_WITH_BANNER = 96

/**
 * Band a sheet keeps free under the top bar for that column. In order: the whole column (notice and banner) when it
 * leaves MIN_MAIN_H, or, with a banner, MIN_SHEET_H_WITH_BANNER; else the notice alone (as before #453) when it leaves
 * MIN_MAIN_H; else none (the sheet takes the room and may cover the column).
 */
function sheetNoticeBand(areaH: number, hiddenCount: number, noticeH = 0, bannerH = 0, permissionsH = 0): { band: number; permissions: number } {
  // The permission slot is kept only when everything still leaves a usable sheet; else the cards cover it as before
  for (const perm of permissionsH > 0 ? [permissionsH, 0] : [0]) {
    const full = topbarStack(hiddenCount, noticeH, bannerH, perm)
    const floor = full.bannerTop !== null ? MIN_SHEET_H_WITH_BANNER : MIN_MAIN_H
    if (full.band > 0 && areaH - full.band >= floor) return { band: full.band, permissions: permissionsBand(perm) }
    const noticeOnly = topbarStack(hiddenCount, noticeH, 0, perm).band
    if (noticeOnly > 0 && areaH - noticeOnly >= MIN_MAIN_H) return { band: noticeOnly, permissions: permissionsBand(perm) }
  }
  return { band: 0, permissions: 0 }
}

function sheetLayout(base: Omit<DockLayout, 'mode' | 'rects' | 'hidden' | 'permissionsBand'>, open: readonly PanelId[], reason: 'narrow' | 'no-room', noticeH?: number, bannerH?: number, permissionsH?: number): DockLayout {
  const { area } = base
  const newest = open[open.length - 1]
  // Other open panels are hidden: keep a band under the top bar for the notice that names them (#410), and for the
  // truncation banner under it (#453), which a sheet must not slide under even when it is the only open panel; the
  // permission cards take the top of that column (#410)
  const { band, permissions } = sheetNoticeBand(area.h, open.length - 1, noticeH, bannerH, permissionsH)
  const sheet: Rect = { x: 8, y: area.y + band, w: Math.max(0, area.w - 0), h: area.h - band }
  return {
    ...base,
    mode: 'sheet',
    sheetReason: reason,
    rects: newest ? { [newest]: sheet } : {},
    hidden: open.slice(0, -1),
    permissionsBand: permissions,
  }
}

function tryDock(input: DockInput, base: Omit<DockLayout, 'mode' | 'rects' | 'hidden' | 'permissionsBand'>): Partial<Record<PanelId, Rect>> | null {
  const { viewport: vp, open } = input
  const { area, rightWidth: rw } = base
  const rects: Partial<Record<PanelId, Rect>> = {}
  // The top bar and the control bar are excluded by `area` itself
  const blockers: Rect[] = [...(input.obstacles ?? [])]
  const colX = vp.w - DOCK_EDGE - rw
  const isOpen = (id: PanelId) => open.includes(id)

  // Right dock, top to bottom: link, then the main panel (files | conversation).
  if (isOpen('link')) {
    const iv = freeIntervals(blockers, colX, colX + rw, area.y, bottom(area)).find(([s, e]) => e - s >= 120)
    if (!iv) return null
    const r = { x: colX, y: iv[0], w: rw, h: Math.min(LINK_H, iv[1] - iv[0]) }
    rects.link = r
    blockers.push(r)
  }
  for (const id of ['conversation', 'files'] as const) {
    if (!isOpen(id)) continue
    const iv = freeIntervals(blockers, colX, colX + rw, area.y, bottom(area)).find(([s, e]) => e - s >= MIN_MAIN_H)
    if (!iv) return null
    const r = { x: colX, y: iv[0], w: rw, h: iv[1] - iv[0] }
    rects[id] = r
    blockers.push(r)
  }

  // Left dock: the agent card.
  if (isOpen('detail')) {
    const w = Math.min(DETAIL_SIZE.w, vp.w - 2 * DOCK_EDGE)
    const leftArea: Rect = { x: DOCK_EDGE, y: area.y, w: vp.w - 2 * DOCK_EDGE, h: area.h }
    let placed: Rect | null = null
    for (const h of [DETAIL_SIZE.h, 180, DETAIL_SIZE.minH]) {
      placed = findFreeSpot(w, Math.min(h, area.h), leftArea, blockers)
      if (placed) break
    }
    if (!placed) return null
    rects.detail = placed
    blockers.push(placed)
  }

  // Left dock, second slot: System, in the card's column (below it), or at the top of the column when the
  // card is closed.
  if (isOpen('system')) {
    const w = Math.min(DETAIL_SIZE.w, vp.w - 2 * DOCK_EDGE)
    const card = rects.detail
    const leftArea: Rect = card
      ? { x: card.x, y: area.y, w, h: area.h }
      : { x: DOCK_EDGE, y: area.y, w: vp.w - 2 * DOCK_EDGE, h: area.h }
    let placed: Rect | null = null
    for (const h of [SYSTEM_H, DETAIL_SIZE.h, 180, DETAIL_SIZE.minH]) {
      placed = findFreeSpot(w, Math.min(h, area.h), leftArea, blockers)
      if (placed) break
    }
    if (!placed) return null
    rects.system = placed
    blockers.push(placed)
  }

  // Bottom dock: the timeline, centred above the control bar, narrowed by whatever sits beside it.
  if (isOpen('timeline')) {
    let placed: Rect | null = null
    for (const h of TIMELINE_SIZE.heights) {
      const hh = Math.min(h, area.h)
      const y = bottom(area) - hh
      let x0 = DOCK_EDGE
      let x1 = vp.w - DOCK_EDGE
      for (const b of blockers) {
        if (!(b.y < y + hh && bottom(b) > y)) continue
        if (b.x + b.w / 2 < vp.w / 2) x0 = Math.max(x0, right(b) + DOCK_GAP)
        else x1 = Math.min(x1, b.x - DOCK_GAP)
      }
      const span = x1 - x0
      if (span < TIMELINE_SIZE.minW) continue
      const w = Math.min(TIMELINE_SIZE.maxW, span)
      const x = clamp(Math.round(vp.w / 2 - w / 2), x0, x1 - w)
      const r = { x, y, w, h: hh }
      if (fitsIn(r, area, blockers)) { placed = r; break }
    }
    if (!placed) return null
    rects.timeline = placed
    blockers.push(placed)
  }
  return rects
}

export function computeDockLayout(input: DockInput): DockLayout {
  const vp = { w: Math.max(0, finite(input.viewport.w, 0)), h: Math.max(0, finite(input.viewport.h, 0)) }
  const topbarH = clamp(finite(input.topbarH, TOPBAR_FALLBACK_H), 0, vp.h)
  const controlBarH = clamp(finite(input.controlBarH, CONTROL_BAR_FALLBACK_H), 0, vp.h)
  const controlBar = controlBarRect(vp, controlBarH)
  const areaBottom = controlBar.y - DOCK_GAP
  const area: Rect = { x: DOCK_EDGE, y: topbarH, w: Math.max(0, vp.w - 2 * DOCK_EDGE), h: Math.max(0, areaBottom - topbarH) }
  const base = {
    area,
    topbar: { x: 0, y: 0, w: vp.w, h: topbarH },
    controlBar,
    rightWidth: clampDockWidth(input.rightWidth ?? RIGHT_DOCK.default, vp.w),
  }
  const open = Array.from(new Set(input.open))
  if (open.length === 0) return { ...base, mode: 'dock', rects: {}, hidden: [], permissionsBand: 0 }
  if (vp.w < SHEET_BREAKPOINT) return sheetLayout({ ...base, area: { ...area, x: 8, w: Math.max(0, vp.w - 16) } }, open, 'narrow', input.noticeH, input.bannerH, input.permissionsH)
  const rects = tryDock({ ...input, viewport: vp, open }, base)
  if (!rects) return sheetLayout({ ...base, area: { ...area, x: 8, w: Math.max(0, vp.w - 16) } }, open, 'no-room', input.noticeH, input.bannerH, input.permissionsH)
  return { ...base, mode: 'dock', rects, hidden: [], permissionsBand: 0 }
}

// ─── Popups ─────────────────────────────────────────────────────────────────

export interface PopupPlacement { left: number; top: number; width: number; maxHeight: number }

/**
 * Place a popup under an anchor point, inside the viewport and between the top bar and the control
 * bar (never over either), nor over the permission cards that sit right under the top bar (#410): their measured
 * slot is kept free, and a popup on top of them would hide a pending decision. Wider-than-viewport popups shrink;
 * taller ones get a maxHeight to scroll.
 */
export function placePopup(
  anchor: { x: number; y: number },
  size: { w: number; h: number },
  env: { viewport: Viewport; topbarH: number; controlBarH: number; permissionsH?: number },
  offsetY = 20,
): PopupPlacement {
  const margin = 8
  const vw = env.viewport.w
  const width = Math.max(0, Math.min(size.w, vw - 2 * margin))
  const minTop = Math.min(env.topbarH + permissionsBand(env.permissionsH), env.viewport.h)
  const maxBottom = Math.max(minTop, env.viewport.h - CONTROL_BAR_BOTTOM - env.controlBarH - DOCK_GAP)
  const maxHeight = Math.max(0, maxBottom - minTop)
  const height = Math.min(size.h, maxHeight)
  return {
    left: Math.round(clamp(finite(anchor.x, 0) - width / 2, margin, vw - width - margin)),
    top: Math.round(clamp(finite(anchor.y, 0) + offsetY, minTop, maxBottom - height)),
    width,
    maxHeight,
  }
}

// ─── Store (environment measurement + shared state) ─────────────────────────

export interface DockEnv {
  viewport: Viewport
  topbarH: number
  controlBarH: number
  obstacles: Rect[]
  /** Height of the drawn hidden-panels notice (absent when none is drawn). */
  noticeH?: number
  /** Height of the drawn truncation banner (absent when none is drawn, #453). */
  bannerH?: number
  /** Height of the drawn permission cards (absent when none is drawn, #410). */
  permissionsH?: number
}

export interface DockSnapshot { layout: DockLayout; env: DockEnv; open: readonly PanelId[] }

/** Panels owned by other modules that the docks must never cover. Closed ones are skipped. */
export const OBSTACLE_SELECTORS = [
  '[role="region"][aria-label="Messages"]',
  'button[aria-label^="Expand messages"]',
  '[data-companion-panel]',
  '[data-permission-requests]',
  '[data-truncation-banner]',
  '[aria-label="Session transcript"]',
  '[aria-label="Sessions and agents"]',
] as const

function roundRect(r: { left: number; top: number; width: number; height: number }): Rect {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

/** DOM side: read the environment. SSR / missing document returns defaults. */
export function measureDockEnv(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): DockEnv {
  const win = doc?.defaultView
  const viewport = { w: win?.innerWidth ?? 1280, h: win?.innerHeight ?? 800 }
  if (!doc || !win) return { viewport, topbarH: TOPBAR_FALLBACK_H, controlBarH: CONTROL_BAR_FALLBACK_H, obstacles: [] }
  let topbarH = TOPBAR_FALLBACK_H
  try {
    const raw = parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--topbar-h'))
    if (Number.isFinite(raw) && raw > 0) topbarH = raw
  } catch { /* no computed style */ }
  const bar = doc.querySelector<HTMLElement>('[data-control-bar]')
  const barH = bar ? bar.getBoundingClientRect().height : 0
  const obstacles: Rect[] = []
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(OBSTACLE_SELECTORS.join(',')))) {
    if (el.closest('[data-dock-panel]') || el.closest('[aria-hidden="true"]') || el.closest('[inert]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    obstacles.push(roundRect(r))
  }
  const notice = doc.querySelector<HTMLElement>('[data-hidden-panels-notice]')
  const noticeH = notice ? Math.ceil(notice.getBoundingClientRect().height) : 0
  // The banner is an obstacle for the docks (above) and takes its own band over a sheet (#453)
  const banner = doc.querySelector<HTMLElement>('[data-truncation-banner]')
  const bannerH = banner && !banner.closest('[aria-hidden="true"]') && !banner.closest('[inert]') ? Math.max(0, Math.ceil(banner.getBoundingClientRect().height)) : 0
  // The cards are an obstacle for the docks (above) and take a slot at the top of the column over a sheet (#410)
  const perm = doc.querySelector<HTMLElement>('[data-permission-requests]')
  const permissionsH = perm && !perm.closest('[aria-hidden="true"]') && !perm.closest('[inert]') ? Math.max(0, Math.ceil(perm.getBoundingClientRect().height)) : 0
  return { viewport, topbarH, controlBarH: barH > 0 ? Math.ceil(barH) : CONTROL_BAR_FALLBACK_H, obstacles, noticeH, bannerH, permissionsH }
}

type Listener = () => void

export interface DockStore {
  subscribe(l: Listener): () => void
  getSnapshot(): DockSnapshot
  setOpen(id: PanelId, open: boolean): void
  getRightWidth(): number
  setRightWidth(w: number): void
  /** Re-read the DOM now (tests / after layout changes). */
  measure(): void
  /** Replace the environment (tests). */
  setEnv(env: Partial<DockEnv>): void
}

/** Create a store. `measure` reads the environment; tests inject their own. */
export function createDockStore(measure: () => DockEnv = measureDockEnv): DockStore {
  const listeners = new Set<Listener>()
  let env = measure()
  let open: PanelId[] = []
  let rightWidth: number = RIGHT_DOCK.default
  let snapshot: DockSnapshot
  let stop: (() => void) | null = null
  let key = ''

  const compute = () => {
    const k = JSON.stringify([env, open, rightWidth])
    if (k === key && snapshot) return false
    key = k
    snapshot = { layout: computeDockLayout({ ...env, open, rightWidth }), env, open: [...open] }
    return true
  }
  compute()
  const emit = () => { if (compute()) listeners.forEach(l => l()) }

  const start = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let raf = 0
    let trail: ReturnType<typeof setTimeout> | undefined
    const remeasure = () => { env = measure(); emit() }
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(() => { raf = 0; remeasure() })
      // Slide-in panels settle after their 300 ms transition: measure again once they are still
      clearTimeout(trail)
      trail = setTimeout(remeasure, 380)
    }
    window.addEventListener('resize', schedule)
    let mo: MutationObserver | undefined
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(schedule)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'aria-hidden', 'hidden', 'inert'] })
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    }
    schedule()
    stop = () => {
      window.removeEventListener('resize', schedule)
      mo?.disconnect()
      if (raf) window.cancelAnimationFrame(raf)
      clearTimeout(trail)
    }
  }

  return {
    subscribe(l) {
      listeners.add(l)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(l)
        if (listeners.size === 0) { stop?.(); stop = null }
      }
    },
    getSnapshot: () => snapshot,
    setOpen(id, isOpen) {
      const has = open.includes(id)
      if (isOpen === has) return
      open = isOpen ? [...open, id] : open.filter(p => p !== id)
      emit()
    },
    getRightWidth: () => rightWidth,
    setRightWidth(w) {
      const next = clampDockWidth(w, env.viewport.w)
      if (next === rightWidth) return
      rightWidth = next
      emit()
    },
    measure() { env = measure(); emit() },
    setEnv(partial) { env = { ...env, ...partial }; emit() },
  }
}

/** Stable snapshot for server rendering / hydration (no panel open). */
export const dockServerSnapshot: DockSnapshot = (() => {
  const env: DockEnv = { viewport: { w: 1280, h: 800 }, topbarH: TOPBAR_FALLBACK_H, controlBarH: CONTROL_BAR_FALLBACK_H, obstacles: [] }
  return { layout: computeDockLayout({ ...env, open: [] }), env, open: [] }
})()

/** The store shared by every docked panel of the page. */
export const dockStore: DockStore = createDockStore()
