/**
 * Burrow view: where the picture goes. The stage is fitted to the area the panels leave free (top bar, control bar,
 * docked panels, as measured for the graph's own fit), keeps the picture's shape, never goes under half size and sits
 * on whole pixels. No DOM here: the view measures the insets and places the stage.
 */

export interface StageInsets { top: number; right: number; bottom: number; left: number }
export interface StageFit { scale: number; left: number; top: number; width: number; height: number }

/** The picture is never drawn smaller than this (the animals and their tags would not be told apart) */
const MIN_SCALE = 0.5

const edge = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

/** Two opposite insets that would leave less than a usable strip are shrunk in proportion (the graph's rule) */
function axis(a: number, b: number, size: number): [number, number] {
  const room = Math.max(0, size - Math.max(1, Math.min(size * 0.4, 160)))
  const sum = a + b
  if (sum <= room) return [a, b]
  const k = sum > 0 ? room / sum : 0
  return [a * k, b * k]
}

interface FreeArea { left: number; top: number; width: number; height: number }

/** The area the insets leave free in the container (null when the container or the picture has no size) */
function freeArea(container: { w: number; h: number }, insets: StageInsets, map: { w: number; h: number }): FreeArea | null {
  if (!(container.w > 0) || !(container.h > 0) || !(map.w > 0) || !(map.h > 0)) return null
  const [left, right] = axis(edge(insets.left), edge(insets.right), container.w)
  const [top, bottom] = axis(edge(insets.top), edge(insets.bottom), container.h)
  return { left, top, width: container.w - left - right, height: container.h - top - bottom }
}

/** Centred on the free span; a stage that fits the scene is kept inside it, one that does not is centred on it */
function place(start: number, free: number, size: number, total: number): number {
  const at = start + (free - size) / 2
  return Math.round(size <= total ? Math.max(0, Math.min(total - size, at)) : (total - size) / 2)
}

function stageIn(container: { w: number; h: number }, free: FreeArea, map: { w: number; h: number }, atTop: boolean): StageFit {
  const scale = Math.max(MIN_SCALE, Math.min(free.width / map.w, free.height / map.h))
  const width = Math.floor(map.w * scale)
  const height = Math.floor(map.h * scale)
  const top = atTop ? Math.round(free.top) : place(free.top, free.height, height, container.h)
  return { scale, left: place(free.left, free.width, width, container.w), top, width, height }
}

/** A free area narrower than this, and taller than wide, is laid out in portrait (a phone, a narrow strip beside a dock) */
const PORTRAIT_MAX_W = 600
/** Height the list panel needs under the stage for portrait to be worth it (a heading and a couple of rows) */
const MIN_LIST_H = 64

export interface BurrowLayout {
  stage: StageFit
  /** Portrait: where the always-shown agent list goes, under the stage in the free area; null in the landscape layout */
  list: { left: number; top: number; width: number; height: number } | null
}

/**
 * The burrow's layout. Landscape (the default): the `map`-sized stage centred on the area the `insets` leave free, the agent list shown on focus in the control
 * column. Portrait, when the free area is narrower than PORTRAIT_MAX_W and taller than wide: the stage spans the free
 * width at the top of the free area, and the list is a visible panel filling the rest below it, with the scene's gutters.
 */
export function burrowLayout(container: { w: number; h: number }, insets: StageInsets, map: { w: number; h: number }): BurrowLayout | null {
  const free = freeArea(container, insets, map)
  if (!free) return null
  if (free.width < PORTRAIT_MAX_W && free.height > free.width) {
    const stage = stageIn(container, free, map, true)
    const top = stage.top + stage.height + GUTTER
    const left = Math.round(free.left + GUTTER)
    const list = {
      left,
      top,
      width: Math.max(0, Math.floor(free.left + free.width - GUTTER) - left),
      height: Math.floor(free.top + free.height - GUTTER) - top,
    }
    if (list.height >= MIN_LIST_H && list.width > 0) return { stage, list }
  }
  return { stage: stageIn(container, free, map, false), list: null }
}

/** Gap between the burrow's control column and the scene's edges or a docked panel */
const GUTTER = 8
/** Width the control column keeps however wide a panel docked on the right is (its buttons, the legend, the agent list) */
const MIN_CONTROLS = 176

/**
 * Where the control column goes: left of a panel docked on the right (`dockRight`, its measured inset), but never so
 * far that less than MIN_CONTROLS is left before the scene's left edge (narrow window, 200 % zoom): the column then
 * overlaps the panel rather than being cut off. `room` is the width its contents may take (1.4.10 reflow).
 */
export function controlColumn(containerW: number, dockRight: number): { right: number; room: number } {
  const cw = edge(containerW)
  const usable = Math.max(0, cw - 2 * GUTTER)
  const dock = Math.min(edge(dockRight), Math.max(0, usable - MIN_CONTROLS))
  const right = Math.round(dock + GUTTER)
  return { right, room: Math.max(0, Math.round(cw - right - GUTTER)) }
}
