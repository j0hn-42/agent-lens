import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawBackground } from '../web/components/agent-visualizer/background-layer'

/* eslint-disable @typescript-eslint/no-explicit-any */
function countingCtx() {
  const c = { moveTo: 0, lineTo: 0, closePath: 0, stroke: 0 }
  const noop = () => {}
  const ctx: any = new Proxy({}, {
    get(_t, k: string) {
      if (k === 'moveTo') return () => { c.moveTo++ }
      if (k === 'lineTo') return () => { c.lineTo++ }
      if (k === 'closePath') return () => { c.closePath++ }
      if (k === 'stroke') return () => { c.stroke++ }
      if (k === 'createRadialGradient') return () => ({ addColorStop: noop })
      return noop
    },
    set() { return true },
  })
  return { ctx, c }
}

function hexes(scale: number, reducedMotion = false): number {
  const { ctx, c } = countingCtx()
  drawBackground(ctx, 1920, 1080, [], { x: 960, y: 540, scale }, true, 3, undefined, reducedMotion)
  return c.closePath
}

test('hex grid: the default zoom and the zooms above the 15 px pitch are not thinned', () => {
  // 1920x1080 at scale 1 and 0.25 keep the full grid (390 and 4140 hexagons before the change)
  assert.equal(hexes(1), 390)
  assert.equal(hexes(0.25), 4140)
})

test('hex grid: the count stops growing once the grid is thinned', () => {
  assert.ok(hexes(0.04) < hexes(0.07) * 1.5)
  assert.ok(hexes(0.04) < 5000)
})

test('hex grid: cost is bounded at every zoom (path operations at minimum zoom)', () => {
  const atDefault = hexes(1)
  assert.ok(atDefault > 300 && atDefault < 500, `default zoom draws ${atDefault}`)
  const bound = 10000
  for (const s of [0.25, 0.1, 0.07, 0.04]) {
    const n = hexes(s)
    assert.ok(n <= bound, `scale ${s}: ${n} hexagons > ${bound}`)
  }
  assert.ok(hexes(0.04, true) <= bound)
})

/** Centres (first vertex of each hexagon, rounded) drawn at a scale, same pan. */
function centres(scale: number): Set<string> {
  const pts = new Set<string>()
  const ctx: any = new Proxy({}, {
    get(_t, k: string) {
      if (k === 'moveTo') return (x: number, y: number) => { pts.add(`${Math.round(x * 100)},${Math.round(y * 100)}`) }
      if (k === 'createRadialGradient') return () => ({ addColorStop: () => {} })
      return () => {}
    },
    set() { return true },
  })
  drawBackground(ctx, 1920, 1080, [], { x: 960, y: 540, scale }, true, 3, undefined, true)
  return pts
}

test('hex grid: the worst case just above the threshold stays bounded (#613)', () => {
  // scale 1/6 is the threshold (pitch 15 px): 0.17 is the last unthinned zoom, 0.166 the first thinned one
  for (const s of [0.17, 0.168, 0.1668, 0.166, 0.165]) {
    const n = hexes(s)
    assert.ok(n <= 10000, `scale ${s}: ${n} hexagons`)
  }
  let max = 0
  for (let s = 0.04; s <= 1; s += 0.002) max = Math.max(max, hexes(s))
  assert.ok(max <= 10000, `max over the sweep: ${max}`)
})

test('hex grid: crossing the threshold only removes hexagons, none moves (#613)', () => {
  const before = centres(0.17) // stride 1
  const after = centres(0.166) // stride 2
  assert.ok(after.size > 0 && before.size > 0)
  // a kept hexagon inside the area the finer grid covered must already have been drawn
  const xs = [...before].map(p => Number(p.split(',')[0]))
  const ys = [...before].map(p => Number(p.split(',')[1]))
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const inside = [...after].filter(p => { const [x, y] = p.split(',').map(Number); return x >= x0 && x <= x1 && y >= y0 && y <= y1 })
  assert.ok(inside.length > 100)
  const moved = inside.filter(p => !before.has(p))
  assert.deepEqual(moved, [])
})
