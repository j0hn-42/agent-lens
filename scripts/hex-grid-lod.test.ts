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
