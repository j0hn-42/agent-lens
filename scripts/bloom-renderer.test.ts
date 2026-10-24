import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BloomRenderer } from '../web/components/agent-visualizer/bloom-renderer'

// Minimal 2D context that tracks the transform like a real canvas (save/restore stack, setTransform).
function fakeCtx(canvas: { width: number; height: number }, dpr: number) {
  let m = [dpr, 0, 0, dpr, 0, 0]
  const stack: number[][] = []
  const draws: { dx: number; dy: number; dw: number; dh: number; scaleX: number; scaleY: number }[] = []
  return {
    canvas,
    draws,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save: () => { stack.push([...m]) },
    restore: () => { m = stack.pop() ?? m },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { m = [a, b, c, d, e, f] },
    clearRect: () => {},
    drawImage: (_img: unknown, ...a: number[]) => {
      const [dx, dy, dw, dh] = a.length >= 4 ? a : [a[0], a[1], 0, 0]
      draws.push({ dx, dy, dw, dh, scaleX: m[0], scaleY: m[3] })
    },
  }
}

function withDocument<T>(fn: () => T): T {
  const g = globalThis as { document?: unknown }
  const prev = g.document
  g.document = {
    createElement: () => {
      const c: { width: number; height: number; getContext: () => unknown } = {
        width: 300, height: 150,
        getContext: () => fakeCtx(c, 1),
      }
      return c
    },
  }
  try { return fn() } finally { g.document = prev }
}

for (const dpr of [1, 1.5, 2]) {
  test(`bloom composite is painted at identity scale over the full backing store (dpr ${dpr})`, () => {
    withDocument(() => {
      const cssW = 800, cssH = 600
      const source = { width: Math.round(cssW * dpr), height: Math.round(cssH * dpr) }
      const target = fakeCtx(source, dpr)
      const bloom = new BloomRenderer(0.5)
      bloom.resize(source.width, source.height)
      bloom.apply(source as unknown as HTMLCanvasElement, target as unknown as CanvasRenderingContext2D)
      assert.equal(target.draws.length, 1)
      const d = target.draws[0]
      assert.deepEqual([d.dx, d.dy, d.dw, d.dh], [0, 0, source.width, source.height])
      // Size on screen = size * transform scale: it must cover the backing store exactly, so scale 1.
      assert.equal(d.scaleX, 1)
      assert.equal(d.scaleY, 1)
    })
  })
}

test('apply leaves the caller transform untouched', () => {
  withDocument(() => {
    const source = { width: 1600, height: 1200 }
    const target = fakeCtx(source, 2)
    const bloom = new BloomRenderer(0.5)
    bloom.resize(source.width, source.height)
    bloom.apply(source as unknown as HTMLCanvasElement, target as unknown as CanvasRenderingContext2D)
    target.drawImage(null, 0, 0, 1, 1)
    assert.equal(target.draws[1].scaleX, 2)
  })
})
