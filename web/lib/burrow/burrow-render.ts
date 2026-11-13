/**
 * Burrow view: drawing. Everything is drawn on a 560 x 315 px canvas (real pixels), then enlarged to the visible canvas
 * without smoothing: decor, woven title mats (pixel font), front door, animals and lights.
 */
import type { BurrowActor, BurrowEngine } from './burrow-engine'
import type { BurrowData } from './burrow-types'
import type { BurrowPalette } from './burrow-palette'

export type BurrowImages = Readonly<Record<string, CanvasImageSource>>

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const MOVING = new Set(['walk', 'doorOut', 'doorIn', 'hopOn', 'hopOff'])
/** A finished agent is drawn dimmed, like a finished node of the graph */
const RESTING_ALPHA = 0.45

/**
 * The ring on the floor that tells sessions and teams apart (burrow-marker): the pixels of an ellipse just around the
 * animal's shadow (20 x 7 px), relative to its feet, computed once.
 */
const RING_PIXELS: ReadonlyArray<readonly [number, number]> = (() => {
  const rx = 11
  const ry = 4
  const seen = new Set<string>()
  const out: Array<[number, number]> = []
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2
    const p: [number, number] = [Math.round(rx * Math.cos(a)), Math.round(ry * Math.sin(a))]
    const k = `${p[0]},${p[1]}`
    if (!seen.has(k)) { seen.add(k); out.push(p) }
  }
  return out
})()

function drawText(ctx: CanvasRenderingContext2D, font: BurrowData['font'], text: string, x: number, y: number, color: string): void {
  ctx.fillStyle = color
  for (const ch of text) {
    const gl = font.glyphs[ch] ?? font.glyphs[' ']
    for (let j = 0; j < gl.r.length; j++) {
      for (let i = 0; i < gl.w; i++) {
        if ((gl.r[j] >> (gl.w - 1 - i)) & 1) ctx.fillRect(x + i, y + gl.t + j, 1, 1)
      }
    }
    x += gl.w + font.spacing
  }
}

/** A thread between two animals (scene pixels): the selected agent and its parent or sub-agents */
export interface BurrowThread { x1: number; y1: number; x2: number; y2: number }
/** A letter in flight (scene pixels): a dispatch, a return, or a message between teammates */
export interface BurrowLetter { x: number; y: number; kind: 'dispatch' | 'return' | 'message' }


export interface BurrowRenderer {
  /** Scene pixels -> visible canvas: call when the visible canvas changes size */
  resize(width: number, height: number): void
  /** The theme changed: letters and threads take the new paper and ink at the next render */
  setPalette(palette: BurrowPalette): void
  /** Draws the title layer again from the engine's current mats (after engine.setTitles) */
  redrawTitles(): void
  /** `rings`: colour of the floor ring per agent key (burrow-marker colourOf); an agent without one gets no ring */
  render(opts: { showTitles: boolean; hiddenKeys?: ReadonlySet<string>; threads?: readonly BurrowThread[]; letters?: readonly BurrowLetter[]; rings?: ReadonlyMap<string, string> }): void
}

export function createBurrowRenderer(data: BurrowData, images: BurrowImages, engine: BurrowEngine, view: HTMLCanvasElement, initialPalette: BurrowPalette): BurrowRenderer | null {
  let pal = initialPalette
  const { w: W, h: H } = data.map
  const vg = view.getContext('2d')
  const world = document.createElement('canvas')
  world.width = W; world.height = H
  const g = world.getContext('2d')
  const signs = document.createElement('canvas')
  signs.width = W; signs.height = H
  const sg = signs.getContext('2d')
  if (!vg || !g || !sg) return null
  const FX = data.fx
  const MAP = data.map

  const M = FX.mat
  // title mats: drawn once, and again when the engine lays them anew (language change)
  function drawSigns(): void {
  if (!sg) return
  sg.clearRect(0, 0, W, H)
  sg.imageSmoothingEnabled = false
  for (const m of engine.mats) {
    const r = FX.rects[`mat_${m.id}`] ?? FX.rects.mat_lounge
    sg.drawImage(images.fx, r[0], r[1], M.cap, M.h, m.x, m.y, M.cap, M.h)                                  // left fringe
    sg.drawImage(images.fx, r[0] + r[2] - M.cap, r[1], M.cap, M.h, m.x + m.w - M.cap, m.y, M.cap, M.h)    // right fringe
    for (let x = M.cap; x < m.w - M.cap; x += M.mid) {                                                      // repeated middle
      const n = Math.min(M.mid, m.w - M.cap - x)
      sg.drawImage(images.fx, r[0] + M.cap, r[1], n, M.h, m.x + x, m.y, n, M.h)
    }
    const ink = M.inks[m.id] ?? M.inks.lounge
    drawText(sg, data.font, m.label, m.x + M.cap + M.pad, m.y + M.textY + 1, ink.shade)                    // one darker stitch underneath,
    drawText(sg, data.font, m.label, m.x + M.cap + M.pad, m.y + M.textY, ink.ink)                          // then the thread itself
  }
  }
  drawSigns()

  function drawFx(name: string, x: number, y: number): void {
    const r = FX.rects[name]
    if (r) g?.drawImage(images.fx, r[0], r[1], r[2], r[3], x, y, r[2], r[3])
  }
  let rings: ReadonlyMap<string, string> | undefined
  function drawActor(a: BurrowActor, alphaIn: number): void {
    if (!g) return
    const alpha = a.resting ? alphaIn * RESTING_ALPHA : alphaIn
    const m = a.meta
    const c = m.cell
    let row: number
    let col: number
    const pose = a.pose ? m.poses[a.pose] : undefined
    if (pose) { row = pose.row; col = pose.col }
    else {
      const an = m.anims[a.dir]
      const waiting = (a.mode === 'doorOut' || a.mode === 'doorIn') && a.wait > 0   // standing still while the door opens
      const rate = (a.fps * an.frames) / m.anims.down.frames                          // same loop duration in every direction
      row = an.row
      col = MOVING.has(a.mode) && !waiting ? Math.floor(a.animT * rate) % an.frames : 0
    }
    const x = Math.round(a.x)
    const y = Math.round(a.y)
    g.globalAlpha = alpha
    if (a.mode !== 'sit') drawFx('shadow', x - 10, y - 4)
    const ring = rings?.get(a.key)
    if (ring) {
      // on the floor under the animal: one pixel of the colour over one of shadow (it stays visible on any floor). Never
      // dimmed with a finished animal: the ring tells its session or team apart, it would be lost at the resting alpha
      g.globalAlpha = alphaIn
      g.fillStyle = pal.shadow
      for (const [dx, dy] of RING_PIXELS) if (dy >= 0) g.fillRect(x + dx, y + dy + 1, 1, 1)
      g.fillStyle = ring
      for (const [dx, dy] of RING_PIXELS) g.fillRect(x + dx, y + dy, 1, 1)
      g.globalAlpha = alpha
    }
    g.drawImage(images[a.sprite], col * c, row * c, c, c, x - m.anchor[0], y - m.anchor[1], c, c)
    g.globalAlpha = 1
  }

  return {
    setPalette(palette) { pal = palette },
    redrawTitles: drawSigns,
    resize(width, height) {
      if (view.width !== width || view.height !== height) { view.width = width; view.height = height }
      vg.imageSmoothingEnabled = false
    },
    render({ showTitles, hiddenKeys, threads, letters, rings: ringsIn }) {
      rings = ringsIn
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
      g.imageSmoothingEnabled = false
      g.drawImage(images.decor, 0, 0)
      drawFx(`fire${engine.ambience.fireFrame}`, FX.fire[0], FX.fire[1])
      if (showTitles) g.drawImage(signs, 0, 0)
      // front door: closed in the decor, open while someone walks through. On the floor in front of the door the agent is drawn
      // normally; once on the doorstep it only shows through the doorway, behind the stone arch (both fade into each other).
      const u = engine.door.user
      if (engine.doorIsOpen()) {
        const T = MAP.door
        const op = T.opening
        const inside = clamp01(u ? u.tp / 0.35 : 0)
        drawFx('doorOpen', T.x, T.y)
        if (u) {
          if (inside < 1) {                                       // still partly in front of the arch: fades out above the doorstep line
            g.save(); g.beginPath(); g.rect(0, 0, W, T.y + op[3]); g.clip()
            drawActor(u, u.alpha * (1 - inside))
            g.restore()
          }
          g.save()
          g.beginPath()
          g.rect(T.x + op[0], T.y + op[1], op[2] - op[0], op[3] - op[1])       // the doorway...
          g.rect(0, T.y + op[3], W, H - T.y - op[3])                           // ...and everything from the doorstep down (the feet)
          g.clip()
          drawActor(u, u.alpha)
          g.restore()
          g.globalAlpha = inside
          drawFx('doorFrame', T.x, T.y)
          g.globalAlpha = 1
        }
      }
      // threads of the selected agent, on the floor under the animals: dashed, one pixel wide
      if (threads?.length) {
        for (const th of threads) {
          const len = Math.hypot(th.x2 - th.x1, th.y2 - th.y1)
          const n = Math.max(1, Math.round(len))
          for (let i = 0; i <= n; i++) {
            if (i % 5 > 2) continue
            const x = Math.round(th.x1 + ((th.x2 - th.x1) * i) / n)
            const y = Math.round(th.y1 + ((th.y2 - th.y1) * i) / n)
            g.fillStyle = pal.ink; g.globalAlpha = 0.55; g.fillRect(x, y + 1, 1, 1)
            g.fillStyle = pal.paper; g.globalAlpha = 0.9; g.fillRect(x, y, 1, 1)
          }
        }
        g.globalAlpha = 1
      }
      // everyone else in the burrow, from back to front
      const list = engine.actors.filter((a) => a !== u && a.mode !== 'home' && !hiddenKeys?.has(a.key)).sort((p, q) => p.y - q.y)
      for (const a of list) drawActor(a, a.alpha)
      // glows
      const { fireGlow } = engine.ambience
      const clock = engine.clock
      g.globalCompositeOperation = 'lighter'
      let r = FX.rects.glowFire
      g.globalAlpha = fireGlow
      drawFx('glowFire', MAP.lights.fire[0] - (r[2] >> 1), MAP.lights.fire[1] - (r[3] >> 1))
      r = FX.rects.glowFurnace
      g.globalAlpha = clamp01(0.55 + 0.45 * fireGlow * Math.abs(Math.sin(clock * 2.3)))
      drawFx('glowFurnace', MAP.lights.furnace[0] - (r[2] >> 1), MAP.lights.furnace[1] - (r[3] >> 1))
      r = FX.rects.glowLamp
      MAP.lights.lanterns.forEach((p, i) => {
        g.globalAlpha = clamp01(0.66 + 0.2 * Math.sin(clock * 3.1 + i * 1.7) + 0.12 * Math.sin(clock * 7.7 + i * 2.9))
        drawFx('glowLamp', p[0] - (r[2] >> 1), p[1] - (r[3] >> 1))
      })
      r = FX.rects.glowShroom
      MAP.lights.mushrooms.forEach((p, i) => {
        g.globalAlpha = clamp01(0.5 + 0.4 * Math.sin(clock * 1.1 + i * 1.3))
        drawFx('glowShroom', p[0] - (r[2] >> 1), p[1] - (r[3] >> 1))
      })
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
      // letters in flight, above everything: a 9 x 6 envelope, its flap drawn in ink; a return carries a red seal
      if (letters?.length) {
        for (const l of letters) {
          const x = Math.round(l.x) - 4
          const y = Math.round(l.y) - 3
          g.fillStyle = pal.shadow; g.fillRect(x + 1, y + 6, 9, 1)
          g.fillStyle = pal.ink; g.fillRect(x, y, 9, 6)
          g.fillStyle = l.kind === 'dispatch' ? pal.paper : l.kind === 'return' ? pal.letterReturn : pal.letterMessage; g.fillRect(x + 1, y + 1, 7, 4)
          g.fillStyle = pal.ink
          for (let i = 0; i < 3; i++) { g.fillRect(x + 1 + i, y + 1 + i, 1, 1); g.fillRect(x + 7 - i, y + 1 + i, 1, 1) }
          g.fillRect(x + 4, y + 3, 1, 1)
          if (l.kind === 'return') { g.fillStyle = pal.seal; g.fillRect(x + 4, y + 3, 1, 2) }
        }
      }
      // crisp enlargement to the visible canvas
      vg.imageSmoothingEnabled = false
      vg.drawImage(world, 0, 0, W, H, 0, 0, view.width, view.height)
    },
  }
}
