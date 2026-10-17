// "Fit to view" frames everything the canvas draws and keeps it clear of the bars (#378, lot 4):
// - the canvas controls (Legend, Tour, zoom, View) sit on the playback bar inside the canvas root, so the
//   overlay measure skipped them and the fit let content slide under them;
// - workspace zones (the frame drawn around the halos of one project) were not part of the fit bounds;
// - below 100 % agent labels are drawn enlarged (held at 11 px on screen) but were framed at their 100 % size.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as cameraFit from '../web/components/agent-visualizer/canvas/camera-fit'
import { computeFitBounds, fitToView, type Rect } from '../web/components/agent-visualizer/canvas/camera-fit'
import { labelScaleForZoom } from '../web/components/agent-visualizer/canvas/draw-options'
import { agentDrawRadius } from '../web/components/agent-visualizer/canvas/team-style'
import { AGENT_DRAW } from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', name: 'main', state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    x: 0, y: 0, vx: 0, vy: 0, isMain: false, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], ...over,
  }
}

function fakeEl(attrs: Record<string, string>, matchesBar: boolean, r: Rect): any {
  const el: any = {
    getAttribute: (k: string) => attrs[k] ?? null,
    matches: () => matchesBar,
    getBoundingClientRect: () => ({ left: r.x, top: r.y, width: r.w, height: r.h }),
    contains: (o: unknown) => o === el,
    closest: () => null,
    parentElement: null,
  }
  return el
}

test('measureOverlayInsets: the canvas controls row inside the canvas root reserves the bottom edge (#378)', async () => {
  const { measureOverlayInsets } = await import('../web/components/agent-visualizer/canvas/overlay-insets')
  // 1024 x 768 as in the demo: playback bar at y 700, zoom / legend row just above it at y 666
  const playback = fakeEl({}, true, { x: 172, y: 700, w: 680, h: 52 })
  const controlsRow = fakeEl({ 'data-canvas-inset': 'bottom' }, false, { x: 856, y: 666, w: 156, h: 26 })
  const toolbarInRoot = fakeEl({}, true, { x: 0, y: 300, w: 1024, h: 40 })
  const inRoot = new Set([controlsRow, toolbarInRoot])
  const root = { contains: (el: unknown) => inRoot.has(el) || el === canvas }
  const canvas: any = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
    closest: () => root,
  }
  const doc: any = {
    documentElement: {},
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    querySelectorAll: () => [playback, controlsRow, toolbarInRoot],
  }
  const i = measureOverlayInsets(canvas, doc)
  assert.equal(i.bottom, 768 - 666, 'the controls row on top of the playback bar is reserved')
  assert.equal(i.top, 0, 'an untagged element of the canvas root is still not an overlay')
})

test('computeFitBounds: the workspace zones drawn around the halos are framed (#378)', () => {
  const a = agent()
  const base = computeFitBounds({ agents: [a], simTime: 0, clusters: [{ cx: 0, cy: 0, r: 200 }] })
  const zone = { x: -260, y: -300, w: 520, h: 560 }
  const b = computeFitBounds({ agents: [a], simTime: 0, clusters: [{ cx: 0, cy: 0, r: 200 }], zones: [zone] } as any)
  assert.ok(b.minY <= zone.y && b.maxY >= zone.y + zone.h && b.minX <= zone.x && b.maxX >= zone.x + zone.w, JSON.stringify(b))
  assert.ok(base.minY > zone.y, 'precondition: the halo alone does not reach the zone top')
  // A focus scope (one agent and its children) frames them, not the project frame
  const scoped = computeFitBounds({ agents: [a], simTime: 0, zones: [zone], focusScope: new Set([a.id]) } as any)
  assert.ok(scoped.minY > zone.y)
})

test('fitContent: below 100 % the label blocks are framed at the size they are drawn (#378)', () => {
  const fitContent = (cameraFit as Record<string, unknown>).fitContent as undefined | ((...a: unknown[]) => cameraFit.Transform | null)
  assert.equal(typeof fitContent, 'function', 'camera-fit exports fitContent')
  // Two agents far apart vertically: the fit lands well under 100 %, where labels are drawn enlarged
  const top = agent({ id: 'a', x: 0, y: 0 })
  const bottom = agent({ id: 'b', x: 0, y: 1100 })
  const block = { w: 280, h: 70 }
  const viewport = { width: 1024, height: 768 }
  const drawnBlock = (t: cameraFit.Transform, a: any) => {
    const k = labelScaleForZoom(t.scale)
    const y0 = a.y + agentDrawRadius(a) + AGENT_DRAW.labelYOffset
    return {
      l: (a.x - (block.w * k) / 2) * t.scale + t.x, r: (a.x + (block.w * k) / 2) * t.scale + t.x,
      t: y0 * t.scale + t.y, b: (y0 + block.h * k) * t.scale + t.y,
    }
  }
  // The plain fit (labels at their 100 % size) leaves the bottom label block partly off screen
  const plain = fitToView(computeFitBounds({ agents: [top, bottom], simTime: 0 }), viewport)!
  assert.ok(plain.scale < 1 && plain.scale >= 0.35, `precondition: labels drawn enlarged at ${plain.scale}`)
  assert.ok(drawnBlock(plain, bottom).b > viewport.height, 'precondition: the plain fit cuts the bottom label')

  const t = fitContent!({ agents: [top, bottom], simTime: 0, labelBlock: () => block }, viewport)!
  for (const a of [top, bottom]) {
    const d = drawnBlock(t, a)
    assert.ok(d.t >= -0.5 && d.b <= viewport.height + 0.5 && d.l >= -0.5 && d.r <= viewport.width + 0.5, `label of ${a.id} ${JSON.stringify(d)} at zoom ${t.scale}`)
  }
  // Without label blocks it is the plain fit
  assert.deepEqual(fitContent!({ agents: [top, bottom], simTime: 0 }, viewport), plain)
})

test('fitContent: under the zoom where labels are hidden, they no longer stretch the fit (#378)', () => {
  const fitContent = (cameraFit as Record<string, unknown>).fitContent as undefined | ((...a: unknown[]) => cameraFit.Transform | null)
  assert.equal(typeof fitContent, 'function', 'camera-fit exports fitContent')
  const agents = [agent({ id: 'a', x: 0, y: 0 }), agent({ id: 'b', x: 0, y: 6000 })]
  const viewport = { width: 1024, height: 768 }
  const plain = fitToView(computeFitBounds({ agents, simTime: 0 }), viewport)!
  assert.ok(plain.scale < 0.3, `precondition: labels hidden at ${plain.scale}`)
  const t = fitContent!({ agents, simTime: 0, labelBlock: () => ({ w: 280, h: 70 }) }, viewport)!
  assert.ok(Math.abs(t.scale - plain.scale) < 1e-9, `${t.scale} vs ${plain.scale}`)
})
