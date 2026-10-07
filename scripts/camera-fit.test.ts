import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  fitToView, safeRect, computeFitBounds, emptyBounds, extendCircle, extendRect, isEmptyBounds, circleBounds,
  fitInsets, classifyOverlayInsets, clampRectToSafe, clusterSetSignature, shouldResumeAutoFit, parsePx, maxInsets,
  MAX_FIT_SCALE, classifyContentChange, contentStamp, FIT_MIN_SCALE, FIT_MIN_PADDING, type WorldBounds, type Rect,
} from '../web/components/agent-visualizer/canvas/camera-fit'
import { planOverlays, contextBlockHeight, contextBarShown } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { CAMERA, CLUSTER_DRAW } from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', name: 'main', state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    x: 0, y: 0, vx: 0, vy: 0, isMain: false, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], ...over,
  }
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)
const VP = { width: 2118, height: 1273 }

/** Screen rectangle of the bounds under a transform */
function screenOf(b: WorldBounds, t: { x: number; y: number; scale: number }) {
  return { l: b.minX * t.scale + t.x, r: b.maxX * t.scale + t.x, t: b.minY * t.scale + t.y, b: b.maxY * t.scale + t.y }
}

test('fitToView centres the bounds exactly in the viewport', () => {
  const b: WorldBounds = { minX: 100, maxX: 500, minY: 50, maxY: 350 }
  const t = fitToView(b, VP, null)!
  const s = screenOf(b, t)
  near((s.l + s.r) / 2, VP.width / 2)
  near((s.t + s.b) / 2, VP.height / 2)
  assert.ok(s.l >= 0 && s.r <= VP.width && s.t >= 0 && s.b <= VP.height)
})

test('fitToView centres in the safe area, not the viewport', () => {
  const b: WorldBounds = { minX: -200, maxX: 200, minY: -200, maxY: 200 }
  const insets = { top: 80, bottom: 100, left: 0, right: 400 }
  const t = fitToView(b, VP, insets)!
  const s = screenOf(b, t)
  const safe = safeRect(VP, insets)
  near((s.l + s.r) / 2, safe.x + safe.w / 2)
  near((s.t + s.b) / 2, safe.y + safe.h / 2)
  assert.ok(s.t >= insets.top && s.b <= VP.height - insets.bottom && s.r <= VP.width - insets.right)
})

test('fitToView: one cluster is capped at the maximum scale', () => {
  const t = fitToView(circleBounds(10, 20, 30), VP, null)!
  assert.equal(t.scale, MAX_FIT_SCALE)
  near(t.x + 10 * t.scale, VP.width / 2)
  near(t.y + 20 * t.scale, VP.height / 2)
})

test('fitToView: degenerate zero-size bounds centre on the point', () => {
  const t = fitToView({ minX: 5, maxX: 5, minY: 7, maxY: 7 }, VP, { top: 100 })!
  assert.equal(t.scale, MAX_FIT_SCALE)
  const safe = safeRect(VP, { top: 100 })
  near(5 * t.scale + t.x, safe.x + safe.w / 2)
  near(7 * t.scale + t.y, safe.y + safe.h / 2)
})

test('fitToView: zero width only still fits the height', () => {
  const t = fitToView({ minX: 0, maxX: 0, minY: 0, maxY: 4000 }, VP, null)!
  assert.ok(t.scale < 1 && t.scale >= CAMERA.minZoom)
})

test('fitToView returns null for empty, non-finite or zero-size input', () => {
  assert.equal(fitToView(emptyBounds(), VP, null), null)
  assert.equal(fitToView(null, VP, null), null)
  assert.equal(fitToView({ minX: NaN, maxX: 1, minY: 0, maxY: 1 }, VP, null), null)
  assert.equal(fitToView({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, { width: 0, height: 100 }, null), null)
})

test('fitToView: huge halos clamp at the minimum zoom and stay centred', () => {
  const b = circleBounds(0, 0, 1_000_000)
  const t = fitToView(b, VP, null)!
  assert.equal(t.scale, CAMERA.minZoom)
  near(t.x, VP.width / 2)
  near(t.y, VP.height / 2)
})

test('fitToView: 12 clusters on a ring all fit inside the safe area', () => {
  const b = emptyBounds()
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    extendCircle(b, Math.cos(a) * 900, Math.sin(a) * 900, 260)
  }
  const insets = fitInsets({ top: 76, bottom: 70, left: 0, right: 0 }, true)
  const t = fitToView(b, VP, insets)!
  const s = screenOf(b, t)
  const safe = safeRect(VP, insets)
  assert.ok(s.l >= safe.x - 1e-6 && s.r <= safe.x + safe.w + 1e-6)
  assert.ok(s.t >= safe.y - 1e-6 && s.b <= safe.y + safe.h + 1e-6)
  near((s.l + s.r) / 2, safe.x + safe.w / 2)
  near((s.t + s.b) / 2, safe.y + safe.h / 2)
})

test('fitToView: tiny viewport with panels open still yields a finite transform inside the viewport', () => {
  const vp = { width: 320, height: 240 }
  const insets = { top: 200, bottom: 200, left: 300, right: 300 }
  const t = fitToView({ minX: 0, maxX: 800, minY: 0, maxY: 600 }, vp, insets)!
  assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y) && t.scale >= CAMERA.minZoom)
  const safe = safeRect(vp, insets)
  assert.ok(safe.w >= 1 && safe.h >= 1 && safe.x >= 0 && safe.y >= 0 && safe.x + safe.w <= vp.width && safe.y + safe.h <= vp.height)
})

test('safeRect sanitises negative, NaN and oversize insets', () => {
  const r = safeRect({ width: 1000, height: 800 }, { top: -5, left: NaN, right: 0, bottom: 0 })
  assert.deepEqual(r, { x: 0, y: 0, w: 1000, h: 800 })
  const big = safeRect({ width: 1000, height: 800 }, { top: 5000, bottom: 5000 })
  assert.ok(big.h >= 1 && big.y + big.h <= 800)
})

test('safeRect with side panels (transcript + files + timeline widths)', () => {
  const r = safeRect(VP, { left: 420, right: 380, top: 76, bottom: 64 })
  assert.deepEqual(r, { x: 420, y: 76, w: VP.width - 800, h: VP.height - 140 })
})

test('computeFitBounds only counts visible agents, so a faded outlier does not skew the fit', () => {
  const main = agent({ id: 'a', x: 0, y: 0, isMain: true })
  const ghost = agent({ id: 'b', x: 9000, y: 9000, opacity: 0 })
  const withGhost = computeFitBounds({ agents: [main, ghost], simTime: 0 })
  const without = computeFitBounds({ agents: [main], simTime: 0 })
  assert.equal(withGhost.maxX, without.maxX)
  assert.equal(withGhost.maxY, without.maxY)
})

test('computeFitBounds includes halos, tool cards and discoveries; a focus scope drops halos', () => {
  const a = agent({ id: 'a', x: 0, y: 0 })
  const base = computeFitBounds({ agents: [a], simTime: 0 })
  const halo = computeFitBounds({ agents: [a], simTime: 0, clusters: [{ cx: 0, cy: 0, r: 2000 }] })
  assert.ok(halo.minX <= -2000 && halo.maxX >= 2000)
  const scoped = computeFitBounds({ agents: [a], simTime: 0, clusters: [{ cx: 0, cy: 0, r: 2000 }], focusScope: new Set(['a']) })
  assert.equal(scoped.maxX, base.maxX)
  const tool = computeFitBounds({ agents: [a], simTime: 0, toolCalls: [{ x: 700, y: 0, opacity: 1, agentId: 'a' } as any] })
  assert.ok(tool.maxX > 700)
  const hiddenTool = computeFitBounds({ agents: [a], simTime: 0, toolCalls: [{ x: 700, y: 0, opacity: 0, agentId: 'a' } as any] })
  assert.equal(hiddenTool.maxX, base.maxX)
  const disc = computeFitBounds({ agents: [a], simTime: 0, discoveries: [{ x: -900, y: 0, opacity: 1, agentId: 'a' } as any] })
  assert.ok(disc.minX < -900)
})

test('computeFitBounds of no visible content is empty', () => {
  assert.ok(isEmptyBounds(computeFitBounds({ agents: [], simTime: 0 })))
  assert.ok(isEmptyBounds(computeFitBounds({ agents: [agent({ opacity: 0 })], simTime: 0 })))
})

test('extendRect ignores non-finite values', () => {
  const b = emptyBounds()
  extendRect(b, NaN, 0, 1, 1)
  assert.ok(isEmptyBounds(b))
  extendRect(b, 0, 0, 10, 10)
  assert.deepEqual(b, { minX: 0, maxX: 10, minY: 0, maxY: 10 })
})

test('fitInsets reserves room for halo labels above the circles', () => {
  const plain = fitInsets({ top: 76 }, false)
  const labelled = fitInsets({ top: 76 }, true)
  assert.equal(labelled.top - plain.top, CLUSTER_DRAW.labelHeight + 4)
  assert.equal(plain.left, 0)
  assert.ok(fitInsets({ right: 380 }, false).right > 380)
})

test('classifyOverlayInsets: top bar, bottom bar and side panels; floating cards ignored', () => {
  const canvas: Rect = { x: 0, y: 0, w: 2118, h: 1273 }
  const topbar = { x: 12, y: 12, w: 2000, h: 56 }
  const bottom = { x: 100, y: 1200, w: 1900, h: 60 }
  const left = { x: 0, y: 100, w: 420, h: 900 }
  const right = { x: 1738, y: 100, w: 380, h: 700 }
  const card = { x: 900, y: 500, w: 300, h: 200 }
  const i = classifyOverlayInsets([topbar, bottom, left, right, card], canvas)
  assert.equal(i.top, 68)
  assert.equal(i.bottom, 73)
  assert.equal(i.left, 420)
  assert.equal(i.right, 380)
})

test('classifyOverlayInsets: canvas offset, invalid rects and empty canvas', () => {
  const canvas: Rect = { x: 0, y: 40, w: 1000, h: 800 }
  const i = classifyOverlayInsets([{ x: 0, y: 0, w: 1000, h: 90 }, { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 0 }], canvas)
  assert.equal(i.top, 50)
  assert.deepEqual(classifyOverlayInsets([{ x: 0, y: 0, w: 5, h: 5 }], { x: 0, y: 0, w: 0, h: 0 }), { top: 0, right: 0, bottom: 0, left: 0 })
})

test('maxInsets and parsePx', () => {
  assert.deepEqual(maxInsets({ top: 5, left: 9 }, { top: 7, right: 3 }), { top: 7, right: 3, bottom: 0, left: 9 })
  assert.equal(parsePx('68px'), 68)
  assert.equal(parsePx(' 12.5px'), 12.5)
  assert.equal(parsePx(''), 0)
  assert.equal(parsePx(undefined), 0)
  assert.equal(parsePx('-4px'), 0)
})

test('clampRectToSafe keeps labels out from under the tab strip and the control bar', () => {
  const safe: Rect = { x: 0, y: 80, w: 1000, h: 600 }
  assert.deepEqual(clampRectToSafe({ x: 100, y: -20, w: 200, h: 36 }, safe), { x: 100, y: 80, w: 200, h: 36 })
  assert.deepEqual(clampRectToSafe({ x: 100, y: 900, w: 200, h: 36 }, safe), { x: 100, y: 644, w: 200, h: 36 })
  assert.deepEqual(clampRectToSafe({ x: -50, y: 100, w: 200, h: 36 }, safe), { x: 0, y: 100, w: 200, h: 36 })
  assert.deepEqual(clampRectToSafe({ x: 900, y: 100, w: 200, h: 36 }, safe), { x: 800, y: 100, w: 200, h: 36 })
  // larger than the area: pinned to its top-left
  assert.deepEqual(clampRectToSafe({ x: 5, y: 5, w: 2000, h: 36 }, safe), { x: 0, y: 80, w: 2000, h: 36 })
})

test('cluster halo labels never overlap the tab strip (planOverlays safe area)', () => {
  const lead = agent({ id: 'L', sessionId: 'L', isMain: true, x: 0, y: 0, name: 'lead' })
  const other = agent({ id: 'O', sessionId: 'O', isMain: true, x: 600, y: 0, name: 'other' })
  const agents = new Map([[lead.id, lead], [other.id, other]])
  const clusters = computeClusters(agents.values())
  const transform = { x: 300, y: 10, scale: 1 }
  const safeArea = { x: 0, y: 90, w: 2118, h: 1100 }
  const res = planOverlays({
    agents, clusters, edgeBubbles: [], transform, viewport: { w: 2118, h: 1273 }, safeArea,
    lod: { labels: true, details: true }, showStats: false, showCost: false, showSessionLabels: true,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 0, isBubbleHeld: () => false,
  })
  const placed = clusters.map(c => res.plan.get(`cluster:${c.key}`)).filter(p => p && p.rect)
  assert.ok(placed.length > 0)
  for (const p of placed) assert.ok(p!.rect!.y >= safeArea.y, `label at y=${p!.rect!.y}`)
})

test('auto-fit rules: first content and scope change resume; resize and live growth leave a manual view alone', () => {
  const none = { signature: null, width: 800, height: 600 }
  const sig = clusterSetSignature(['b', 'a'], ['s2', 's1', undefined])
  assert.equal(sig, clusterSetSignature(['a', 'b', 'a'], ['s1', undefined, 's2']))
  assert.equal(shouldResumeAutoFit(none, { signature: null, width: 800, height: 600 }), false)
  assert.equal(shouldResumeAutoFit(none, { signature: sig, width: 800, height: 600 }), true)
  const cur = { signature: sig, width: 800, height: 600 }
  assert.equal(shouldResumeAutoFit(cur, { ...cur }), false)
  assert.equal(shouldResumeAutoFit(cur, { ...cur, width: 800.5 }), false)
  // A resize no longer snaps a manually placed camera (issue #2)
  assert.equal(shouldResumeAutoFit(cur, { ...cur, width: 1200 }), false)
  assert.equal(shouldResumeAutoFit(cur, { ...cur, height: 300 }), false)
  assert.equal(shouldResumeAutoFit(cur, { ...cur, signature: clusterSetSignature(['a'], ['s1']) }), true)
})

test('label block reserves the context bar so a shifted LEAD label never lands on the token text', () => {
  const h0 = contextBlockHeight(28, 0)
  const h1 = contextBlockHeight(28, 1)
  assert.ok(h1 - h0 > 0)
  assert.ok(h0 > 26)
  assert.equal(contextBarShown({ tokensUsed: 0, state: 'idle', opacity: 1 }), false)
  assert.equal(contextBarShown({ tokensUsed: 5, state: 'idle', opacity: 1 }), true)
  assert.equal(contextBarShown({ tokensUsed: 5, state: 'complete', opacity: 0.2 }), false)
  assert.equal(contextBarShown({ tokensUsed: 5, state: 'idle', opacity: 1, archived: true }), false)
})


// ─── camera-fit2: floor, auto-fit rules, overlay roles, numeric verification ───

test('fit floor and interactive zoom floor are the same value; minFitScale is gone', () => {
  assert.equal(FIT_MIN_SCALE, CAMERA.minZoom)
  assert.ok(FIT_MIN_SCALE <= 0.05)
  assert.equal((CAMERA as Record<string, unknown>).minFitScale, undefined)
})

test('fitToView: 40 clusters on a wide ring fit inside the safe area (below the old 0.2 floor)', () => {
  const b = emptyBounds()
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    extendCircle(b, Math.cos(a) * 4200, Math.sin(a) * 4200, 380)
  }
  const insets = fitInsets({ top: 76, bottom: 70, left: 0, right: 0 }, true)
  const t = fitToView(b, VP, insets)!
  assert.ok(t.scale < CAMERA.minZoom * 5 && t.scale > FIT_MIN_SCALE)
  const s = screenOf(b, t)
  const safe = safeRect(VP, insets)
  assert.ok(s.l >= safe.x && s.r <= safe.x + safe.w && s.t >= safe.y && s.b <= safe.y + safe.h)
})

test('20000 random cases: overflowing content gets a scale below 1 and ends inside the safe area', () => {
  let seed = 12345
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  let overflow = 0
  for (let i = 0; i < 20000; i++) {
    const vp = { width: 400 + rnd() * 3000, height: 300 + rnd() * 1500 }
    const insets = { top: rnd() * 150, bottom: rnd() * 150, left: rnd() < 0.3 ? rnd() * 500 : 0, right: rnd() < 0.3 ? rnd() * 500 : 0 }
    const safe = safeRect(vp, insets)
    const availW = safe.w - FIT_MIN_PADDING * 2
    const availH = safe.h - FIT_MIN_PADDING * 2
    // up to ~15x the room: always above the floor, so the fit has to be exact
    const bw = rnd() * availW * 15
    const bh = rnd() * availH * 15
    const b: WorldBounds = { minX: (rnd() - 0.5) * 8000, minY: (rnd() - 0.5) * 8000, maxX: 0, maxY: 0 }
    b.maxX = b.minX + bw
    b.maxY = b.minY + bh
    const t = fitToView(b, vp, insets)!
    const s = screenOf(b, t)
    const eps = 1e-6
    near((s.l + s.r) / 2, safe.x + safe.w / 2, 1e-6)
    near((s.t + s.b) / 2, safe.y + safe.h / 2, 1e-6)
    if (bw > availW || bh > availH) {
      overflow++
      assert.ok(t.scale < 1, `scale ${t.scale} for overflowing content`)
      assert.ok(t.scale >= FIT_MIN_SCALE)
    }
    if (t.scale > FIT_MIN_SCALE) {
      assert.ok(s.l >= safe.x - eps && s.r <= safe.x + safe.w + eps && s.t >= safe.y - eps && s.b <= safe.y + safe.h + eps, 'content inside the safe area')
    }
  }
  assert.ok(overflow > 5000)
})

test('classifyOverlayInsets: a control bar is counted by role, not by width ratio, on very wide canvases', () => {
  const canvas: Rect = { x: 0, y: 0, w: 5000, h: 1300 }
  const bar = { x: 2160, y: 1220, w: 678, h: 56 }
  // Untagged: the width heuristic would drop it (678 < 25% of 5000)
  assert.equal(classifyOverlayInsets([bar], canvas).bottom, 0)
  assert.equal(classifyOverlayInsets([{ ...bar, bar: true }], canvas).bottom, 1300 - 1220)
  const top = { x: 20, y: 8, w: 400, h: 52, bar: true }
  assert.equal(classifyOverlayInsets([top], canvas).top, 60)
  // A bar floating mid-canvas reserves nothing
  assert.deepEqual(classifyOverlayInsets([{ x: 2000, y: 600, w: 600, h: 50, bar: true }], canvas), { top: 0, right: 0, bottom: 0, left: 0 })
})

test('classifyOverlayInsets: data-canvas-inset edge opt-in reserves that edge whatever the size', () => {
  const canvas: Rect = { x: 0, y: 0, w: 2000, h: 1000 }
  const i = classifyOverlayInsets([
    { x: 800, y: 300, w: 200, h: 100, edge: 'top' },
    { x: 50, y: 400, w: 120, h: 80, edge: 'right' },
    { x: 100, y: 20, w: 90, h: 90, edge: 'left' },
    { x: 700, y: 900, w: 90, h: 40, edge: 'bottom' },
  ], canvas)
  assert.equal(i.top, 400)
  assert.equal(i.right, 2000 - 50)
  assert.equal(i.left, 190)
  assert.equal(i.bottom, 1000 - 900)
})

/** Minimal synthetic DOM for measureOverlayInsets */
function fakeEl(attrs: Record<string, string>, matchesBar: boolean, r: Rect, parent?: any, contains = false): any {
  const el: any = {
    getAttribute: (k: string) => attrs[k] ?? null,
    matches: () => matchesBar,
    getBoundingClientRect: () => ({ left: r.x, top: r.y, width: r.w, height: r.h }),
    contains: (o: unknown) => o === el || contains,
    closest: () => null,
    parentElement: parent ?? null,
  }
  return el
}

test('measureOverlayInsets reads roles and data-canvas-inset from a synthetic DOM', async () => {
  const { measureOverlayInsets, overlayRoleOf } = await import('../web/components/agent-visualizer/canvas/overlay-insets')
  const canvas: any = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 5000, height: 1300 }),
    closest: () => null,
  }
  const controlBar = fakeEl({}, true, { x: 2160, y: 1220, w: 678, h: 56 })
  const feed = fakeEl({ 'data-canvas-inset': 'left' }, false, { x: 0, y: 200, w: 300, h: 100 })
  const note = fakeEl({}, false, { x: 900, y: 900, w: 100, h: 50 })
  const nestedHeader = fakeEl({}, true, { x: 0, y: 0, w: 4000, h: 40 }, {})
  nestedHeader.parentElement = { closest: () => ({ contains: () => false }) }
  const doc: any = {
    documentElement: {},
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    querySelectorAll: () => [controlBar, feed, note, nestedHeader],
  }
  const i = measureOverlayInsets(canvas, doc)
  assert.equal(i.bottom, 1300 - 1220)
  assert.equal(i.left, 300)
  assert.equal(i.top, 0, 'nested header is part of its panel')
  assert.deepEqual(overlayRoleOf(feed), { edge: 'left' })
  assert.deepEqual(overlayRoleOf(fakeEl({ 'data-canvas-inset': 'auto' }, false, { x: 0, y: 0, w: 1, h: 1 })), { bar: false })
  assert.deepEqual(overlayRoleOf(fakeEl({ 'data-canvas-inset': 'bogus' }, true, { x: 0, y: 0, w: 1, h: 1 })), { bar: true })
})

test('classifyContentChange: manual pan survives live growth and resize; tab change and first content resume', () => {
  const st = (sessions: string[], keys = sessions.map(s => `session:${s}`)) => ({
    signature: clusterSetSignature(keys, sessions), sessions: Array.from(new Set(sessions)).sort(), width: 800, height: 600,
  })
  const empty = { signature: null, width: 800, height: 600 }
  assert.equal(classifyContentChange(empty, st(['a'])), 'first')
  assert.equal(classifyContentChange(st(['a']), st(['a'])), 'none')
  assert.equal(classifyContentChange(st(['a', 'b']), st(['a', 'b', 'c'])), 'growth')
  assert.equal(classifyContentChange(st(['a']), st(['a'], ['session:a', 'team:a:x'])), 'growth')
  assert.equal(classifyContentChange(st(['a', 'b', 'c']), st(['b'])), 'scope')
  assert.equal(classifyContentChange(st(['a']), st(['b'])), 'scope')
  assert.equal(classifyContentChange(st(['a']), st(['a', 'b', 'c'])), 'scope')
  assert.equal(classifyContentChange(st(['a']), empty), 'none')
  assert.equal(shouldResumeAutoFit(st(['a', 'b']), st(['a', 'b', 'c'])), false)
  assert.equal(shouldResumeAutoFit(st(['a']), st(['b'])), true)
})

test('contentStamp: order-insensitive, sensitive to the content set, ignores positions', () => {
  const ag = (...ids: string[]) => ids.map(sessionId => ({ sessionId }))
  const cl = (...keys: string[]) => keys.map(key => ({ key }))
  assert.equal(contentStamp(cl('a', 'b'), ag('s1', 's2', 's1')), contentStamp(cl('b', 'a'), ag('s1', 's1', 's2')))
  assert.notEqual(contentStamp(cl('a', 'b'), ag('s1', 's2')), contentStamp(cl('a', 'b', 'c'), ag('s1', 's2')))
  assert.notEqual(contentStamp(cl('a'), ag('s1')), contentStamp(cl('a'), ag('s2')))
  assert.notEqual(contentStamp(cl('a'), ag('s1')), contentStamp(cl('a'), ag('s1', 's1')))
})
