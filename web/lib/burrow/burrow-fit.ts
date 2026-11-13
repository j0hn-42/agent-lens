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

/** Scale and position of the `map`-sized stage in a `container`, centred on the area the `insets` leave free */
export function fitStage(container: { w: number; h: number }, insets: StageInsets, map: { w: number; h: number }): StageFit | null {
  const cw = container.w
  const ch = container.h
  if (!(cw > 0) || !(ch > 0) || !(map.w > 0) || !(map.h > 0)) return null
  const [left, right] = axis(edge(insets.left), edge(insets.right), cw)
  const [top, bottom] = axis(edge(insets.top), edge(insets.bottom), ch)
  const freeW = cw - left - right
  const freeH = ch - top - bottom
  const scale = Math.max(MIN_SCALE, Math.min(freeW / map.w, freeH / map.h))
  const width = Math.floor(map.w * scale)
  const height = Math.floor(map.h * scale)
  // centred on the free area; a stage that fits the scene is kept inside it, one that does not is centred on it
  const place = (start: number, free: number, size: number, total: number): number => {
    const at = start + (free - size) / 2
    return Math.round(size <= total ? Math.max(0, Math.min(total - size, at)) : (total - size) / 2)
  }
  return { scale, left: place(left, freeW, width, cw), top: place(top, freeH, height, ch), width, height }
}
