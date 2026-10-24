import { withHexAlpha } from '../../../lib/color-alpha'
// ─── Glow sprite cache ─────────────────────────────────────────────────────
// Pre-renders radial gradient glows to off-screen canvases.
// Avoids creating CanvasGradient objects every frame.

const glowSpriteCache = new Map<string, HTMLCanvasElement>()

/** Simple radial glow: gradient from center (innerAlpha) to edge (outerAlpha) */
export function getGlowSprite(
  color: string, radius: number, innerAlpha: string, outerAlpha: string,
): HTMLCanvasElement {
  const rQ = Math.ceil(radius)
  const key = `${color}|${rQ}|${innerAlpha}|${outerAlpha}`
  let sprite = glowSpriteCache.get(key)
  if (sprite) return sprite

  const size = rQ * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const ctx = sprite.getContext('2d')!
  const glow = ctx.createRadialGradient(rQ, rQ, 0, rQ, rQ, rQ)
  glow.addColorStop(0, color + innerAlpha)
  glow.addColorStop(1, color + outerAlpha)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  glowSpriteCache.set(key, sprite)
  return sprite
}

/** Agent glow: gradient from innerRadius to outerRadius */
export function getAgentGlowSprite(
  color: string, innerRadius: number, outerRadius: number, glowAlphaHex: string,
): HTMLCanvasElement {
  const iR = Math.round(innerRadius)
  const oR = Math.ceil(outerRadius)
  const key = `ag|${color}|${iR}|${oR}|${glowAlphaHex}`
  let sprite = glowSpriteCache.get(key)
  if (sprite) return sprite

  const size = oR * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const ctx = sprite.getContext('2d')!
  const glow = ctx.createRadialGradient(oR, oR, iR, oR, oR, oR)
  glow.addColorStop(0, color + glowAlphaHex)
  glow.addColorStop(1, withHexAlpha(color, '00'))
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  glowSpriteCache.set(key, sprite)
  return sprite
}

/** Sprites painted by the caller (depth shadows): one canvas per key, painted once at its centre */
const paintedSpriteCache = new Map<string, HTMLCanvasElement>()
const PAINTED_SPRITE_MAX = 400

export function getPaintedSprite(
  key: string, halfSize: number, paint: (ctx: CanvasRenderingContext2D, cx: number, cy: number) => void,
): HTMLCanvasElement {
  let sprite = paintedSpriteCache.get(key)
  if (sprite) return sprite
  if (paintedSpriteCache.size >= PAINTED_SPRITE_MAX) paintedSpriteCache.clear()
  const size = Math.ceil(halfSize) * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  paint(sprite.getContext('2d')!, size / 2, size / 2)
  paintedSpriteCache.set(key, sprite)
  return sprite
}

// ─── Gradient cache ────────────────────────────────────────────────────────
// A CanvasGradient belongs to the context that made it and is positioned in the coordinates of the
// moment it is used: gradients are built around the origin and the caller translates to the agent.

const gradientCache = new WeakMap<object, Map<string, CanvasGradient>>()

export function getCachedLinearGradient(
  ctx: CanvasRenderingContext2D, key: string, y0: number, y1: number, stops: ReadonlyArray<readonly [number, string]>,
): CanvasGradient {
  let perCtx = gradientCache.get(ctx)
  if (!perCtx) { perCtx = new Map(); gradientCache.set(ctx, perCtx) }
  let g = perCtx.get(key)
  if (g) return g
  if (perCtx.size >= 200) perCtx.clear()
  g = ctx.createLinearGradient(0, y0, 0, y1)
  for (const [at, color] of stops) g.addColorStop(at, color)
  perCtx.set(key, g)
  return g
}

// ─── Text measurement cache ────────────────────────────────────────────────
// Caches ctx.measureText().width to avoid redundant browser layout per frame.

const textWidthCache = new Map<string, number>()
const TEXT_CACHE_MAX = 2000

export function measureTextCached(ctx: CanvasRenderingContext2D, text: string): number {
  const key = ctx.font + '|' + text
  let w = textWidthCache.get(key)
  if (w !== undefined) return w
  w = ctx.measureText(text).width
  if (textWidthCache.size > TEXT_CACHE_MAX) textWidthCache.clear()
  textWidthCache.set(key, w)
  return w
}

// ─── Tool card size cache ──────────────────────────────────────────────────
// The draw pass measures the real card size; hit-testing reuses it so clicks line up
// with what is drawn (instead of estimating from a per-character width).

const toolCardSizes = new Map<string, { w: number; h: number }>()
const TOOL_CARD_CACHE_MAX = 1000

export function setToolCardSize(id: string, w: number, h: number): void {
  if (toolCardSizes.size > TOOL_CARD_CACHE_MAX) toolCardSizes.clear()
  toolCardSizes.set(id, { w, h })
}

export function getToolCardSize(id: string): { w: number; h: number } | undefined {
  return toolCardSizes.get(id)
}
